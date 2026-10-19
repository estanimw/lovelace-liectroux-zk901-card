/* eslint-disable @typescript-eslint/no-unused-vars */
import { css, html, nothing, svg, type TemplateResult } from "lit";

import {
    applyAreaEdit,
    callCleanAreas,
    callVacuumAction,
    errorMessage,
    getAreaCatalog,
    refreshCard,
    subscribeCard,
    type ApplyAreaEditResponse,
    type CardSnapshot,
    type ZoneArea,
    type ZonePose,
} from "./data/zk901";
import { CARD_CUSTOM_ELEMENT_NAME, CARD_VERSION, EDITOR_CUSTOM_ELEMENT_NAME, INTEGRATION_DOMAIN } from "./const";
import {
    computeSceneBounds,
    createInitialRectangle,
    polygonCenter,
    validVertices,
    type Point,
    type WorldBounds,
} from "./model/zone-geometry";
import { ZoneDraft } from "./model/zone-draft";
import type { HomeAssistantFixed } from "./types/fixes";

export interface CardConfig {
    type: string;
    entity: string;
    title?: string;
    [key: string]: unknown;
}

interface CatalogView {
    map_id: number | string | null;
    revision: string | null;
    areas: ZoneArea[];
    observed_at: string | null;
    age_seconds: number | null;
    fresh: boolean;
    available: boolean;
    error: string | null;
}

interface CatalogConflict {
    map_id: number | string | null;
    revision: string | null;
    areas: ZoneArea[];
    observed_at: string | null;
}

interface VertexGesture {
    pointerId: number;
    index?: number;
    last: Point;
    before: ReturnType<ZoneDraft["beginGesture"]>;
    moved: boolean;
}

export function zoneName(area: ZoneArea): string {
    const tag = typeof area.tag === "string" ? area.tag.trim() : "";
    const name = typeof area.name === "string" ? area.name.trim() : "";
    return tag || name || `Zona ${area.id}`;
}

export function zoneType(active: unknown): string {
    if (active === "normal") return "Normal";
    if (active === "depth") return "Profunda";
    if (active === "forbid") return "Prohibida";
    return "Tipo no compatible";
}

export function statusName(snapshot?: CardSnapshot): string {
    if (!snapshot?.available) return "Sin conexión";
    const status = snapshot.status;
    if (status.mode === "pause") return "Pausada";
    if (status.mode === "sweep") {
        if (status.sub_mode === "area") return "Limpiando zonas";
        if (status.sub_mode === "curpoint") return "Limpiando posición actual";
        if (status.sub_mode === "point") return "Limpieza localizada";
        return "Limpiando";
    }
    if (status.mode === "backcharge") return "Volviendo a la base";
    if (status.mode === "charge" || status.mode === "fullcharge") return "En la base";
    if (status.mode === "rfctrl") return "Control manual";
    return "Estado sin clasificar";
}

export function timestampLabel(value: string | null): string {
    if (!value) return "sin lectura";
    const elapsed = Math.max(0, Date.now() - Date.parse(value));
    if (!Number.isFinite(elapsed)) return "sin lectura";
    if (elapsed < 60_000) return "hace menos de un minuto";
    if (elapsed < 3_600_000) return `hace ${Math.floor(elapsed / 60_000)} min`;
    return `hace ${Math.floor(elapsed / 3_600_000)} h`;
}

function isPositiveId(area: ZoneArea): boolean {
    return Number.isSafeInteger(area.id) && area.id > 0;
}

export function errorText(value: unknown): string | null {
    if (value === null || value === undefined || value === false) return null;
    if (typeof value === "number" && (!Number.isFinite(value) || value === 0)) return null;
    if (typeof value === "string" && (!value.trim() || value.trim() === "0")) return null;
    if (Array.isArray(value) && value.length === 0) return null;
    if (typeof value === "object") {
        try {
            return JSON.stringify(value) || null;
        } catch {
            return String(value);
        }
    }
    return String(value);
}

function htmlError(result: ApplyAreaEditResponse): string {
    if (result.error === "conflict")
        return "El catálogo cambió mientras editabas. Tu borrador quedó intacto para que lo revises.";
    if (result.error === "uncertain")
        return "No se pudo confirmar el guardado. Recargá el catálogo antes de decidir si volvés a intentarlo.";
    if (result.error === "invalid" || result.error === "rejected")
        return result.detail ?? "La integración rechazó el cambio.";
    if (result.error === "not_found") return "La entidad de la integración ya no está disponible.";
    if (result.error === "unavailable") return "La aspiradora no está disponible para guardar las zonas.";
    if (result.error === "failed")
        return "No se pudo completar el guardado. El resultado puede ser incierto; recargá el catálogo.";
    return "No se pudo guardar la zona.";
}

export class ZK901Controller {
    public isConnected = false;
    constructor(
        public requestUpdate: () => void,
        public screenToWorld: (x: number, y: number) => Point,
        public fit: () => void,
    ) {}
    public hass?: HomeAssistantFixed;
    public _config?: CardConfig;
    public _snapshot?: CardSnapshot;
    public _message = "";
    public messageSequence = 0;
    public notifyMessage = false;
    public handleRadius = 20;
    public _messageKind: "info" | "error" | "success" = "info";
    public _loading = true;
    public _apiCompatible = true;
    public _selectedIds: number[] = [];
    public _selectionNeedsReview = false;
    public _editMode = false;
    public _draft: ZoneDraft | null = null;
    public _activeVertex: number | null = null;
    public _draftConflict: CatalogConflict | null = null;
    public _uncertainDraft = false;
    public _catalogReloadedAfterUncertain = false;
    public _pendingAction = "";
    public _uncertainAction = false;
    public _showRoute = true;
    public _showCoverage = true;
    public _routeSession = "latest";
    public _confirmClearRoute = false;

    public _unsubscribe?: () => void;
    public _subscribedEntity = "";
    public _subscribedConnection?: HomeAssistantFixed["connection"];
    public _subscriptionEpoch = 0;
    public _generation = "";
    public _sequence = -1;
    public _pendingSnapshot?: CardSnapshot;
    public _savingDraft = false;
    public _initialFitDone = false;
    public _canvasExpansion = 1;
    public _vertexGesture?: VertexGesture;
    public _suppressClickUntil = 0;

    setConfig(config: CardConfig): void {
        if (!config || typeof config.entity !== "string" || !config.entity.startsWith("vacuum.")) {
            throw new Error("La tarjeta ZK901 necesita entity: vacuum.<entidad>.");
        }
        this._config = { ...config };
        this.requestUpdate();
    }

    connect(): void {
        this.isConnected = true;
        this._ensureSubscription();
    }
    disconnect(): void {
        this.isConnected = false;
        this._subscriptionEpoch += 1;
        this._unsubscribe?.();
        this._unsubscribe = undefined;
        this._subscribedEntity = "";
        this._subscribedConnection = undefined;
        this._vertexGesture = undefined;
    }
    public get _title(): string {
        return typeof this._config?.title === "string" && this._config.title.trim()
            ? this._config.title.trim()
            : "Liectroux ZK901";
    }

    public _ensureSubscription(): void {
        if (!this.isConnected || !this.hass || !this._config) return;
        const connection = this.hass.connection;
        if (this._subscribedEntity === this._config.entity && this._subscribedConnection === connection) return;
        this._unsubscribe?.();
        this._unsubscribe = undefined;
        this._subscribedEntity = this._config.entity;
        this._subscribedConnection = connection;
        this._snapshot = undefined;
        this._loading = true;
        this._apiCompatible = true;
        this._generation = "";
        this._sequence = -1;
        this._selectionNeedsReview = false;
        this._message = "";
        const epoch = ++this._subscriptionEpoch;
        subscribeCard(this.hass, this._config.entity, snapshot => this._receiveSnapshot(snapshot))
            .then(unsubscribe => {
                if (epoch !== this._subscriptionEpoch || !this.isConnected) {
                    unsubscribe();
                    return;
                }
                this._unsubscribe = unsubscribe;
            })
            .catch(error => {
                if (epoch !== this._subscriptionEpoch) return;
                this._loading = false;
                this._apiCompatible = false;
                const message = errorMessage(error);
                this._setMessage(
                    message.toLowerCase().includes("unauthorized") || message.toLowerCase().includes("admin")
                        ? "La lectura y edición de zonas requiere permisos de administrador en Home Assistant."
                        : "No responde la API de la tarjeta ZK901. Actualizá la integración junto con la tarjeta.",
                    "error",
                );
            });
    }

    public _receiveSnapshot(incoming: CardSnapshot): void {
        if (!incoming || typeof incoming !== "object" || incoming.entity_id !== this._config?.entity) return;
        if (incoming.api_version !== 1 || !incoming.catalog || !Array.isArray(incoming.catalog.areas)) {
            this._apiCompatible = false;
            this._loading = false;
            this._setMessage(
                "La integración devolvió una versión de API incompatible. Instalá el paquete conjunto.",
                "error",
            );
            return;
        }
        this._apiCompatible = true;
        if (incoming.generation === this._generation && incoming.sequence <= this._sequence) return;
        if (incoming.generation !== this._generation) {
            this._generation = incoming.generation;
            this._sequence = -1;
        }
        this._sequence = incoming.sequence;
        this._loading = false;

        if (this._savingDraft) {
            this._pendingSnapshot = incoming;
            if (this._snapshot) this._snapshot = { ...incoming, catalog: this._snapshot.catalog };
            return;
        }

        this._applySnapshot(incoming);
    }

    public _applySnapshot(incoming: CardSnapshot): void {
        const previous = this._snapshot;
        const changedCatalog =
            !!previous &&
            (previous.catalog.revision !== incoming.catalog.revision ||
                previous.catalog.map_id !== incoming.catalog.map_id);
        if (this._draft?.isDirty && changedCatalog) {
            this._draftConflict = {
                map_id: incoming.catalog.map_id,
                revision: incoming.catalog.revision,
                areas: incoming.catalog.areas,
                observed_at: incoming.catalog.observed_at,
            };
            this._snapshot = { ...incoming, catalog: previous.catalog };
            this._setMessage(
                "El catálogo cambió en otra vista. Tu borrador quedó intacto; revisá los cambios antes de guardarlo.",
                "error",
            );
            return;
        }
        if (this._draft && changedCatalog && !this._draft.isDirty) {
            this._draft = null;
            this._setMessage("El catálogo se actualizó antes de que modificaras una zona.", "info");
        }
        if (previous && changedCatalog && this._selectedIds.length) this._selectionNeedsReview = true;
        this._snapshot = incoming;
        this.requestUpdate();
        if (!this._initialFitDone) this._fitMap();
    }

    public _renderArea(area: ZoneArea, isDraft: boolean): TemplateResult {
        const vertices = validVertices(area.vertexs) ? area.vertexs : [];
        const center = vertices.length ? polygonCenter(vertices) : [0, 0];
        const selected = this._selectedIds.includes(area.id);
        const isEditable = isDraft || (this._draft?.area?.id === area.id && !this._draft.deleted);
        const kind =
            area.active === "depth"
                ? "depth"
                : area.active === "forbid"
                ? "forbid"
                : area.active === "normal"
                ? "normal"
                : "unsupported";
        const label = `${zoneName(area)}, ${zoneType(area.active)}${selected ? ", seleccionada" : ""}`;
        return svg`
            <g
                class=${`zone-group ${selected ? "selected" : ""} ${isEditable ? "editing" : ""}`}
                data-area-id=${area.id}
                data-draft-area=${isDraft ? "true" : "false"}
                role="button"
                tabindex="0"
                aria-label=${label}
                aria-pressed=${selected ? "true" : "false"}
                @click=${(event: MouseEvent) => this._areaActivated(event, area)}
                @keydown=${(event: KeyboardEvent) => this._areaKeyDown(event, area)}
            >
                <polygon points=${vertices
                    .map(([x, y]) => `${x},${-y}`)
                    .join(" ")} class=${`zone-shape ${kind}`}></polygon>
                <text x=${center[0]} y=${-center[1]} class="zone-label">${zoneName(area)}</text>
                <text x=${center[0]} y=${-center[1] + 24} class="zone-type-label">${zoneType(area.active)}</text>
                ${isEditable ? this._renderVertexHandles(vertices) : nothing}
            </g>
        `;
    }

    public _renderDraftArea(area: NonNullable<ZoneDraft["area"]>): TemplateResult {
        const selectedArea: ZoneArea = {
            ...area,
            id: area.id ?? -99,
            tag: area.tag,
            active: area.active,
            vertexs: area.vertexs,
        };
        return this._renderArea(selectedArea, area.id === null);
    }

    public _renderVertexHandles(vertices: Point[]): TemplateResult[] {
        return vertices.map(
            ([x, y], index) => svg`
            <circle
                cx=${x}
                cy=${-y}
                r=${this.handleRadius}
                class=${`vertex-handle ${this._activeVertex === index ? "active" : ""}`}
                data-vertex-index=${index}
                role="button"
                tabindex="0"
                aria-label=${`Vértice ${index + 1}`}
                @click=${(event: MouseEvent) => {
                    event.stopPropagation();
                    this._activeVertex = index;
                    this.requestUpdate();
                }}
                @keydown=${(event: KeyboardEvent) => this._vertexKeyDown(event, index)}
            ></circle>
        `,
        );
    }

    public _renderZoneList(): TemplateResult {
        const areas = this._snapshot?.catalog.areas ?? [];
        if (!areas.length) {
            return html`<p class="empty-list">El catálogo no tiene zonas guardadas.</p>`;
        }
        return html`
            <ul class="zone-list">
                ${areas.map((area, index) => {
                    const cleanable = this._isCleanable(area, areas);
                    const selected = this._selectedIds.includes(area.id);
                    const editable =
                        isPositiveId(area) &&
                        ["normal", "depth", "forbid"].includes(String(area.active)) &&
                        validVertices(area.vertexs);
                    return html`
                        <li>
                            <button
                                class=${`zone-row ${selected ? "selected" : ""} ${
                                    area.active === "forbid" ? "forbidden" : ""
                                }`}
                                aria-pressed=${selected ? "true" : "false"}
                                @click=${() => this._zoneRowActivated(area, areas)}
                                ?disabled=${this._editMode
                                    ? !!this._draft || !editable
                                    : !cleanable && area.active !== "forbid" && !this._editMode}
                                title=${this._editMode
                                    ? "Abrir zona para editar"
                                    : area.active === "forbid"
                                    ? "Zona prohibida: se puede inspeccionar y editar, pero no limpiar"
                                    : cleanable
                                    ? "Seleccionar para limpiar"
                                    : "No se puede seleccionar esta zona"}>
                                <span class="zone-row-mark" aria-hidden="true"
                                    >${area.active === "forbid" ? "⊘" : area.active === "depth" ? "◆" : index + 1}</span
                                >
                                <span class="zone-row-text"
                                    ><strong>${zoneName(area)}</strong
                                    ><small>${zoneType(area.active)} · ID ${String(area.id)}</small></span
                                >
                                <span class="zone-row-action" aria-hidden="true"
                                    >${this._editMode
                                        ? editable
                                            ? "Editar"
                                            : "—"
                                        : selected
                                        ? "✓"
                                        : cleanable
                                        ? "+"
                                        : ""}</span
                                >
                            </button>
                        </li>
                    `;
                })}
            </ul>
        `;
    }

    public _renderDraftPanel(): TemplateResult {
        const areas = this._snapshot?.catalog.areas ?? [];
        if (this._draftConflict) {
            return html`
                <div class="draft-panel">
                    <div class="notice warning compact" role="alert">
                        ${this._uncertainDraft
                            ? "Se perdió la respuesta del guardado y llegó un catálogo nuevo. El resultado es incierto; el borrador no se reenviará automáticamente."
                            : `El catálogo nuevo tiene ${this._draftConflict.areas.length} zonas (revisión ${
                                  this._draftConflict.revision?.slice(0, 8) ?? "desconocida"
                              }). Tu borrador usa el mapa ${String(this._draft?.baseMapId)} y no fue reemplazado.`}
                    </div>
                    <p class="draft-conflict-summary">
                        Borrador local:
                        ${this._draft?.deleted
                            ? "eliminar zona"
                            : this._draft?.operation === "create"
                            ? `crear “${this._draft.area?.tag || "Zona nueva"}”`
                            : `editar “${this._draft?.area?.tag || "zona"}”`}.
                        Podés cargar el catálogo nuevo para revisar el estado persistido.
                    </p>
                    <div class="conflict-catalog" aria-label="Catálogo nuevo recibido">
                        <strong>Catálogo recibido · mapa ${String(this._draftConflict.map_id ?? "desconocido")}</strong>
                        ${this._draftConflict.areas.length
                            ? html`
                                  <ul>
                                      ${this._draftConflict.areas.map(
                                          area => html`
                                              <li>
                                                  ${zoneName(area)} · ${zoneType(area.active)} · ID ${String(area.id)}
                                              </li>
                                          `,
                                      )}
                                  </ul>
                              `
                            : html`<p>El catálogo no contiene zonas.</p>`}
                    </div>
                    ${this._uncertainDraft
                        ? html`
                              <button
                                  class="button"
                                  @click=${this._reloadDraftCatalog}
                                  ?disabled=${!!this._pendingAction}>
                                  Recargar catálogo
                              </button>
                          `
                        : nothing}
                    <button class="button" @click=${this._discardAndLoadConflict}>
                        Descartar borrador y cargar catálogo actualizado
                    </button>
                </div>
            `;
        }
        if (this._uncertainDraft) {
            return html`
                <div class="draft-panel">
                    <div class="notice warning compact" role="alert">
                        El guardado no tiene confirmación. No se reenviará automáticamente. Recargá el catálogo y
                        comprobá si el cambio quedó persistido.
                    </div>
                    <button class="button" @click=${this._reloadDraftCatalog} ?disabled=${!!this._pendingAction}>
                        Recargar catálogo
                    </button>
                    ${this._catalogReloadedAfterUncertain
                        ? html`
                              <button class="text-button" @click=${this._allowExplicitRetry}>
                                  Ya revisé el catálogo; habilitar un nuevo intento
                              </button>
                          `
                        : nothing}
                    <button class="text-button" @click=${this._discardDraft}>Descartar borrador</button>
                </div>
            `;
        }
        if (!this._draft) {
            return html`
                <div class="draft-panel">
                    <p>Los cambios se guardan solo cuando elegís Guardar. Arrastrar el plano no modifica el robot.</p>
                    <button
                        class="button primary"
                        @click=${this._createZone}
                        ?disabled=${!!this._pendingAction ||
                        !this._snapshot?.catalog.fresh ||
                        !this._snapshot?.catalog.available}>
                        Crear zona
                    </button>
                    <small
                        >${areas.length
                            ? "Elegí una zona de la lista o del plano para modificarla."
                            : "El plano usa la posición para centrar el dibujo; no representa paredes ni el tamaño de la vivienda."}</small
                    >
                </div>
            `;
        }

        const draft = this._draft;
        const area = draft.area;
        const validation = draft.validationMessage;
        const validCatalog = !!this._snapshot?.catalog.fresh && !!this._snapshot?.catalog.available;
        return html`
            <div class="draft-panel">
                <div class="draft-title">
                    <strong
                        >${draft.operation === "create"
                            ? "Zona nueva"
                            : draft.deleted
                            ? "Eliminar zona"
                            : `Editar ${area?.tag || "zona"}`}</strong
                    >
                    <span
                        >${draft.operation === "create"
                            ? "Borrador"
                            : `ID ${String(area?.id ?? draft.baseArea?.id)}`}</span
                    >
                </div>
                ${!draft.deleted && area
                    ? html`
                          <label class="field-label"
                              >Nombre
                              <input type="text" maxlength="80" .value=${area.tag} @input=${this._draftTagChanged} />
                          </label>
                          <label class="field-label"
                              >Tipo de zona
                              <select .value=${area.active} @change=${this._draftTypeChanged}>
                                  <option value="normal">Normal</option>
                                  <option value="depth">Profunda</option>
                                  <option value="forbid">Prohibida</option>
                              </select>
                          </label>
                          <div class="geometry-tools">
                              <span
                                  >${area.vertexs.length}
                                  vértices${this._activeVertex !== null
                                      ? ` · seleccionado ${this._activeVertex + 1}`
                                      : ""}</span
                              >
                              <div>
                                  <button
                                      class="icon-button"
                                      aria-label="Añadir vértice"
                                      title="Añadir vértice"
                                      @click=${this._addVertex}
                                      ?disabled=${area.vertexs.length >= 128}>
                                      ＋
                                  </button>
                                  <button
                                      class="icon-button"
                                      aria-label="Quitar vértice seleccionado"
                                      title="Quitar vértice seleccionado"
                                      @click=${this._removeSelectedVertex}
                                      ?disabled=${area.vertexs.length <= 3 || this._activeVertex === null}>
                                      −
                                  </button>
                              </div>
                          </div>
                          <div class="nudge-tools" aria-label="Mover el polígono con el teclado o los botones">
                              <button
                                  class="icon-button"
                                  aria-label="Mover arriba"
                                  @click=${() => this._nudgePolygon(0, 1)}>
                                  ↑
                              </button>
                              <button
                                  class="icon-button"
                                  aria-label="Mover izquierda"
                                  @click=${() => this._nudgePolygon(-1, 0)}>
                                  ←
                              </button>
                              <button
                                  class="icon-button"
                                  aria-label="Mover abajo"
                                  @click=${() => this._nudgePolygon(0, -1)}>
                                  ↓
                              </button>
                              <button
                                  class="icon-button"
                                  aria-label="Mover derecha"
                                  @click=${() => this._nudgePolygon(1, 0)}>
                                  →
                              </button>
                          </div>
                          <p class="editor-help">
                              Arrastrá el polígono para moverlo o un vértice para cambiar su forma. Las flechas del
                              teclado mueven el elemento enfocado.
                          </p>
                          ${draft.operation === "update" && !draft.deleted
                              ? html`
                                    <button class="text-button delete-button" @click=${this._deleteDraft}>
                                        Eliminar zona…
                                    </button>
                                `
                              : nothing}
                      `
                    : html`<p>La zona se eliminará cuando guardes este cambio.</p>`}
                ${validation ? html`<p class="validation" role="status">${validation}</p>` : nothing}
                ${!validCatalog
                    ? html`<p class="validation">Recargá un catálogo fresco antes de guardar.</p>`
                    : nothing}
                <div class="draft-buttons">
                    <button
                        class="button primary"
                        @click=${this._saveDraft}
                        ?disabled=${!!this._pendingAction ||
                        !validCatalog ||
                        !draft.isDirty ||
                        !!validation ||
                        this._uncertainDraft}>
                        ${this._pendingAction === "guardado" ? "Guardando…" : "Guardar"}
                    </button>
                    <button class="button" @click=${this._discardDraft} ?disabled=${!!this._pendingAction}>
                        Descartar
                    </button>
                    <button
                        class="button"
                        @click=${this._undoDraft}
                        ?disabled=${!draft.canUndo || !!this._pendingAction}>
                        Deshacer
                    </button>
                </div>
            </div>
        `;
    }

    public _renderRouteTools(): TemplateResult {
        const route = this._snapshot?.trajectory;
        const sessions = route?.sessions ?? [];
        return html`
            <div class="route-tools">
                <label
                    ><input
                        type="checkbox"
                        .checked=${this._showRoute}
                        @change=${(event: Event) => {
                            this._showRoute = (event.target as HTMLInputElement).checked;
                            this.requestUpdate();
                        }} />
                    Recorrido</label
                >
                <label
                    ><input
                        type="checkbox"
                        .checked=${this._showCoverage}
                        @change=${(event: Event) => {
                            this._showCoverage = (event.target as HTMLInputElement).checked;
                            this.requestUpdate();
                        }} />
                    Cobertura estimada</label
                >
                <select
                    aria-label="Sesión del recorrido"
                    .value=${this._routeSession}
                    @change=${(event: Event) => {
                        this._routeSession = (event.target as HTMLSelectElement).value;
                        this.requestUpdate();
                    }}>
                    <option value="latest">Última actividad</option>
                    <option value="all">Historial acumulado</option>
                    ${sessions
                        .slice()
                        .reverse()
                        .map(
                            session =>
                                html`<option value=${session.id}>
                                    ${new Date(session.started_at).toLocaleString()}${session.incomplete
                                        ? " · incompleto"
                                        : ""}
                                </option>`,
                        )}
                </select>
                <small role="status"
                    >${route?.error === "storage_unavailable"
                        ? "No se pudo guardar el historial."
                        : route?.error
                        ? "Captura interrumpida; puede haber huecos."
                        : route?.capturing
                        ? "Capturando cada 20 s"
                        : "Captura en espera"}
                    · ${timestampLabel(route?.updated_at ?? null)}</small
                >
                <small
                    >Cobertura acumulada: franja ilustrativa de 30 cm; no representa paredes ni garantiza
                    limpieza.</small
                >
                <small>Azul: limpieza · ámbar: regreso · gris: tramo sin clasificación.</small>
                ${sessions.some(session => session.incomplete)
                    ? html`<small>Hay recorridos incompletos. Los huecos se mantienen separados.</small>`
                    : nothing}
                ${this._confirmClearRoute
                    ? html`
                          <span>¿Borrar todos los recorridos y empezar una reconstrucción nueva?</span>
                          <button class="text-button" @click=${this._clearRoutes}>Borrar recorridos</button>
                          <button
                              class="text-button"
                              @click=${() => {
                                  this._confirmClearRoute = false;
                                  this.requestUpdate();
                              }}>
                              Cancelar
                          </button>
                      `
                    : html`<button
                          class="text-button"
                          @click=${() => {
                              this._confirmClearRoute = true;
                              this.requestUpdate();
                          }}>
                          Reiniciar reconstrucción
                      </button>`}
            </div>
        `;
    }

    public _clearRoutes = async (): Promise<void> => {
        if (!this.hass || !this._config) return;
        try {
            const result = await this.hass.callWS<{ ok: boolean }>({
                type: `${INTEGRATION_DOMAIN}/trajectory/clear`,
                entity_id: this._config.entity,
            });
            if (!result.ok) throw new Error("No se pudieron borrar los recorridos.");
            this._confirmClearRoute = false;
            this._routeSession = "latest";
        } catch (error) {
            this._setMessage(errorMessage(error), "error");
        }
    };

    public _routeBounds(): WorldBounds {
        const base = computeSceneBounds(
            this._snapshot?.catalog.areas ?? [],
            this._snapshot?.pose ?? null,
            this._canvasExpansion,
        );
        (this._snapshot?.trajectory?.sessions ?? []).forEach(session =>
            session.segments.forEach(segment =>
                segment.points.forEach(point => {
                    base.minX = Math.min(base.minX, point[0] - 300);
                    base.maxX = Math.max(base.maxX, point[0] + 300);
                    base.minY = Math.min(base.minY, point[1] - 300);
                    base.maxY = Math.max(base.maxY, point[1] + 300);
                }),
            ),
        );
        const coverage = this._snapshot?.trajectory?.coverage;
        const size = coverage?.cell_size ?? 100;
        (coverage?.cells ?? []).forEach(cell => {
            base.minX = Math.min(base.minX, cell[0] * size - 300);
            base.maxX = Math.max(base.maxX, (cell[0] + 1) * size + 300);
            base.minY = Math.min(base.minY, cell[1] * size - 300);
            base.maxY = Math.max(base.maxY, (cell[1] + 1) * size + 300);
        });
        return base;
    }

    public _fitMap = (): void => {
        this._initialFitDone = true;
        this.fit();
    };
    public _expandDrawingSpace = (): void => {
        this._canvasExpansion = Math.min(this._canvasExpansion * 1.5, 8);
        this._fitMap();
        this._setMessage("Se amplió el área de dibujo. No implica que esa zona sea espacio navegable.", "info");
    };

    public _screenToWorld(x: number, y: number): Point {
        return this.screenToWorld(x, y);
    }
    public _mapPointerDown = (event: PointerEvent): void => {
        if (event.button !== 0 && event.pointerType !== "touch") return;
        const target = event.target instanceof Element ? event.target : null;
        const vertex = target?.closest("[data-vertex-index]") as SVGElement | null;
        const area = target?.closest("[data-area-id]") as SVGElement | null;
        const draft = this._draft;
        if (
            !this._editMode ||
            !draft?.area ||
            draft.deleted ||
            !area ||
            (draft.operation !== "create" && draft.area.id !== Number((area as SVGElement).dataset.areaId))
        )
            return;
        event.stopPropagation();
        event.preventDefault();
        this._activeVertex = vertex ? Number(vertex.dataset.vertexIndex) : null;
        this._vertexGesture = {
            pointerId: event.pointerId,
            index: this._activeVertex ?? undefined,
            last: this.screenToWorld(event.clientX, event.clientY),
            before: draft.beginGesture(),
            moved: false,
        };
        (event.currentTarget as SVGElement).setPointerCapture(event.pointerId);
        this.requestUpdate();
    };
    public _mapPointerMove = (event: PointerEvent): void => {
        const gesture = this._vertexGesture;
        if (!gesture || gesture.pointerId !== event.pointerId || !this._draft) return;
        event.stopPropagation();
        const point = this.screenToWorld(event.clientX, event.clientY);
        const dx = point[0] - gesture.last[0],
            dy = point[1] - gesture.last[1];
        if (dx || dy) {
            if (gesture.index === undefined) this._draft.movePolygon(dx, dy);
            else this._draft.moveVertex(gesture.index, point);
            gesture.last = point;
            gesture.moved = true;
            this.requestUpdate();
        }
    };
    public _mapPointerUp = (event: PointerEvent): void => {
        const gesture = this._vertexGesture;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        event.stopPropagation();
        this._draft?.finishGesture(gesture.before);
        this._vertexGesture = undefined;
        if (gesture.moved) this._suppressClickUntil = Date.now() + 250;
        this.requestUpdate();
    };
    public _areaActivated(event: MouseEvent, area: ZoneArea): void {
        event.stopPropagation();
        if (Date.now() < this._suppressClickUntil) return;
        this._zoneRowActivated(area, this._snapshot?.catalog.areas ?? []);
    }

    public _areaKeyDown(event: KeyboardEvent, area: ZoneArea): void {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            this._zoneRowActivated(area, this._snapshot?.catalog.areas ?? []);
            return;
        }
        if (
            !this._editMode ||
            this._draft?.area?.id !== area.id ||
            !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)
        )
            return;
        event.preventDefault();
        this._nudgePolygon(
            event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0,
            event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0,
            event.shiftKey ? 50 : 10,
        );
    }

    public _vertexKeyDown(event: KeyboardEvent, index: number): void {
        if (!this._draft?.area) return;
        if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
            event.preventDefault();
            const area = this._draft.area;
            const point = area.vertexs[index];
            const distance = event.shiftKey ? 50 : 10;
            const dx = event.key === "ArrowRight" ? distance : event.key === "ArrowLeft" ? -distance : 0;
            const dy = event.key === "ArrowUp" ? distance : event.key === "ArrowDown" ? -distance : 0;
            const before = this._draft.beginGesture();
            this._draft.moveVertex(index, [point[0] + dx, point[1] + dy]);
            this._draft.finishGesture(before);
            this._activeVertex = index;
            this.requestUpdate();
            return;
        }
        if (event.key === "Delete" || event.key === "Backspace") {
            event.preventDefault();
            this._draft.removeVertex(index);
            this._activeVertex = null;
            this.requestUpdate();
        }
    }

    public _zoneRowActivated(area: ZoneArea, catalogAreas: ZoneArea[]): void {
        if (this._editMode) {
            if (this._draft) return;
            if (
                !isPositiveId(area) ||
                !["normal", "depth", "forbid"].includes(String(area.active)) ||
                !validVertices(area.vertexs)
            ) {
                this._setMessage("Esta zona tiene un ID, tipo o geometría que el editor no puede modificar.", "error");
                return;
            }
            try {
                const mapId = this._snapshot?.catalog.map_id;
                const revision = this._snapshot?.catalog.revision;
                if (mapId === null || mapId === undefined || !revision)
                    throw new Error("Recargá el catálogo para obtener su revisión actual.");
                this._draft = ZoneDraft.update(mapId, revision, area);
                this._activeVertex = null;
                this._setMessage(`Editando ${zoneName(area)}. Los cambios todavía no se enviaron.`, "info");
            } catch (error) {
                this._setMessage(errorMessage(error), "error");
            }
            return;
        }
        if (this._selectionNeedsReview) {
            this._setMessage(
                "Vacía la selección anterior y vuelve a elegir las zonas después del cambio de catálogo.",
                "error",
            );
            return;
        }
        if (area.active === "forbid") {
            this._setMessage(
                `${zoneName(area)} es una zona prohibida y no se puede seleccionar para limpiar.`,
                "error",
            );
            return;
        }
        if (!this._isCleanable(area, catalogAreas)) {
            this._setMessage("Esta zona no tiene un ID único y compatible para limpiarla.", "error");
            return;
        }
        this._selectedIds = this._selectedIds.includes(area.id)
            ? this._selectedIds.filter(id => id !== area.id)
            : [...this._selectedIds, area.id];
        this._setMessage("Selección actualizada. La limpieza se enviará como una sola operación.", "info");
    }

    public _isCleanable(area: ZoneArea, areas: ZoneArea[]): boolean {
        if (!isPositiveId(area) || (area.active !== "normal" && area.active !== "depth")) return false;
        return areas.filter(candidate => candidate.id === area.id).length === 1;
    }

    public _selectionIsValid(): boolean {
        const areas = this._snapshot?.catalog.areas ?? [];
        return (
            this._selectedIds.length > 0 &&
            this._selectedIds.every(id => {
                const matches = areas.filter(area => area.id === id);
                return matches.length === 1 && this._isCleanable(matches[0], areas);
            })
        );
    }

    public _clearSelection = (): void => {
        this._selectedIds = [];
        this._selectionNeedsReview = false;
    };

    public _cleanSelected = async (): Promise<void> => {
        const hass = this.hass;
        const entityId = this._config?.entity;
        if (
            !hass ||
            !entityId ||
            !this._snapshot ||
            this._editMode ||
            this._draft ||
            this._selectionNeedsReview ||
            !this._selectionIsValid()
        )
            return;
        const selectedIds = [...this._selectedIds];
        await this._performAction("limpieza de zonas", async () => {
            await callCleanAreas(hass, entityId, selectedIds);
        });
    };

    public _vacuumAction = (
        service: "start" | "pause" | "stop" | "return_to_base" | "clean_spot",
        label: string,
    ): void => {
        const hass = this.hass;
        const entityId = this._config?.entity;
        if (!hass || !entityId) return;
        void this._performAction(label, () => callVacuumAction(hass, entityId, service));
    };

    public _powerChanged = (event: Event): void => {
        const hass = this.hass;
        const entityId = this._config?.entity;
        if (!hass || !entityId) return;
        const level = (event.currentTarget as HTMLSelectElement).value;
        if (!["quiet", "auto", "strong"].includes(level)) return;
        void this._performAction("intensidad", () =>
            callVacuumAction(hass, entityId, "set_fan_speed", { fan_speed: level }),
        );
    };

    public async _performAction(label: string, action: () => Promise<void>): Promise<void> {
        if (this._pendingAction || this._uncertainAction || !this._snapshot?.available) return;
        this._pendingAction = label;
        this.requestUpdate();
        this._message = "";
        try {
            await action();
        } catch (error) {
            const message = errorMessage(error);
            this._uncertainAction = /incierto|connection|conexión|timeout|timed out|lost|desconect/i.test(message);
            this._setMessage(
                this._uncertainAction
                    ? `Se perdió la confirmación de ${label}. Recargá el estado antes de volver a enviar.`
                    : `No se pudo ejecutar ${label}: ${message}`,
                "error",
            );
        } finally {
            this._pendingAction = "";
            this.requestUpdate();
        }
    }

    public _toggleEditMode = async (): Promise<void> => {
        if (this._editMode) {
            if (this._draft?.isDirty) {
                this._setMessage("Guardá o descartá el borrador antes de salir del modo de edición.", "error");
                return;
            }
            this._editMode = false;
            this._draft = null;
            this._activeVertex = null;
            this.requestUpdate();
            return;
        }
        this._editMode = true;
        await this._loadFreshCatalog(false);
    };

    public _createZone = (): void => {
        const snapshot = this._snapshot;
        if (!snapshot?.catalog.revision || snapshot.catalog.map_id === null || snapshot.catalog.map_id === undefined) {
            this._setMessage("Recargá el catálogo antes de crear una zona.", "error");
            return;
        }
        if (!snapshot.catalog.fresh || !snapshot.catalog.available) {
            this._setMessage("No se puede crear una zona con un catálogo antiguo o sin conexión.", "error");
            return;
        }
        const vertices = createInitialRectangle(snapshot.catalog.areas, snapshot.pose);
        this._draft = ZoneDraft.create(snapshot.catalog.map_id, snapshot.catalog.revision, vertices);
        this._activeVertex = null;
        this._setMessage(
            "Se creó un borrador rectangular. Ajustá el nombre, tipo y vértices antes de guardar.",
            "info",
        );
    };

    public _draftTagChanged = (event: Event): void => {
        this._draft?.updateProperties({ tag: (event.currentTarget as HTMLInputElement).value });
        this.requestUpdate();
    };

    public _draftTypeChanged = (event: Event): void => {
        const active = (event.currentTarget as HTMLSelectElement).value;
        if (active === "normal" || active === "depth" || active === "forbid") {
            this._draft?.updateProperties({ active });
            this.requestUpdate();
        }
    };

    public _addVertex = (): void => {
        this._draft?.addVertex();
        this.requestUpdate();
    };

    public _removeSelectedVertex = (): void => {
        if (this._activeVertex === null) return;
        this._draft?.removeVertex(this._activeVertex);
        this._activeVertex = null;
        this.requestUpdate();
    };

    public _nudgePolygon(dx: number, dy: number, distance = 10): void {
        if (!this._draft?.area) return;
        const before = this._draft.beginGesture();
        this._draft.movePolygon(dx * distance, dy * distance);
        this._draft.finishGesture(before);
        this.requestUpdate();
    }

    public _deleteDraft = (): void => {
        const name = this._draft?.area?.tag || "esta zona";
        if (!this._draft || !window.confirm(`Marcar “${name}” para eliminar al guardar?`)) return;
        this._draft.delete();
        this._activeVertex = null;
        this.requestUpdate();
    };

    public _undoDraft = (): void => {
        if (this._draft?.undo()) this.requestUpdate();
    };

    public _discardDraft = (): void => {
        if (this._draft?.isDirty && !window.confirm("Descartar todos los cambios de este borrador?")) return;
        this._draft = null;
        this._draftConflict = null;
        this._uncertainDraft = false;
        this._catalogReloadedAfterUncertain = false;
        this._activeVertex = null;
        this._setMessage("Borrador descartado. Las zonas guardadas no cambiaron.", "info");
    };

    public _discardAndLoadConflict = (): void => {
        const conflict = this._draftConflict;
        const snapshot = this._snapshot;
        if (!conflict || !snapshot) return;
        if (!window.confirm("Descartar el borrador y cargar el catálogo nuevo?")) return;
        this._snapshot = {
            ...snapshot,
            catalog: {
                ...snapshot.catalog,
                map_id: conflict.map_id,
                revision: conflict.revision,
                areas: conflict.areas,
                observed_at: conflict.observed_at,
                fresh: true,
                available: true,
                error: null,
                age_seconds: 0,
            },
        };
        this._draft = null;
        this._draftConflict = null;
        this._uncertainDraft = false;
        this._catalogReloadedAfterUncertain = false;
        this._selectionNeedsReview = this._selectedIds.length > 0;
        this._activeVertex = null;
        this._setMessage("Catálogo nuevo cargado. Revisá la selección de limpieza.", "info");
        this._fitMap();
    };

    public _saveDraft = async (): Promise<void> => {
        const draft = this._draft;
        const snapshot = this._snapshot;
        const hass = this.hass;
        const entityId = this._config?.entity;
        if (!draft || !snapshot || !hass || !entityId || !draft.isDirty || draft.validationMessage) return;
        if (!snapshot.catalog.fresh || !snapshot.catalog.available) {
            this._setMessage("Recargá un catálogo fresco antes de guardar.", "error");
            return;
        }
        this._savingDraft = true;
        this._pendingAction = "guardado";
        this.requestUpdate();
        this._message = "";
        try {
            const result = await applyAreaEdit(hass, draft.toRequest(entityId));
            if (!result.ok) {
                if (result.error === "conflict" && Array.isArray(result.areas)) {
                    this._draftConflict = {
                        map_id: result.map_id ?? null,
                        revision: result.revision ?? null,
                        areas: result.areas,
                        observed_at: null,
                    };
                }
                if (result.error === "uncertain" || result.error === "failed") this._uncertainDraft = true;
                this._setMessage(htmlError(result), "error");
                return;
            }
            if (!Array.isArray(result.areas) || !result.revision || result.map_id === undefined) {
                this._uncertainDraft = true;
                this._setMessage(
                    "La integración aceptó el guardado, pero no devolvió el catálogo confirmado. Recargá antes de reintentar.",
                    "error",
                );
                return;
            }
            this._snapshot = {
                ...snapshot,
                catalog: {
                    ...snapshot.catalog,
                    map_id: result.map_id,
                    revision: result.revision,
                    areas: result.areas,
                    observed_at:
                        "observed_at" in result && typeof result.observed_at === "string"
                            ? result.observed_at
                            : new Date().toISOString(),
                    age_seconds: 0,
                    fresh: true,
                    available: true,
                    error: null,
                },
            };
            this._draft = null;
            this._draftConflict = null;
            this._uncertainDraft = false;
            this._catalogReloadedAfterUncertain = false;
            this._selectionNeedsReview = this._selectedIds.length > 0;
            this._setMessage("Cambios guardados y verificados contra el catálogo del robot.", "success", true);
            this._fitMap();
        } catch (error) {
            this._uncertainDraft = true;
            this._setMessage(
                `Se perdió la respuesta del guardado (${errorMessage(
                    error,
                )}). El resultado es incierto; recargá el catálogo.`,
                "error",
            );
        } finally {
            this._savingDraft = false;
            this._pendingAction = "";
            this.requestUpdate();
            const pending = this._pendingSnapshot;
            this._pendingSnapshot = undefined;
            if (pending) this._applySnapshot(pending);
        }
    };

    public _reloadDraftCatalog = async (): Promise<void> => {
        await this._loadFreshCatalog(true);
        if (this._snapshot?.catalog.fresh && this._snapshot.catalog.available) {
            this._catalogReloadedAfterUncertain = true;
            this._setMessage(
                "Catálogo recargado. Compará las zonas y elegí si corresponde habilitar otro intento.",
                "info",
                true,
            );
        }
    };

    public _allowExplicitRetry = (): void => {
        if (!this._uncertainDraft || !this._catalogReloadedAfterUncertain) return;
        this._uncertainDraft = false;
        this._catalogReloadedAfterUncertain = false;
        this._setMessage(
            "El reintento quedó habilitado por decisión explícita después de releer el catálogo.",
            "warning",
        );
    };

    public _loadFreshCatalog = async (forUncertain: boolean): Promise<void> => {
        if (!this.hass || !this._config || this._pendingAction) return;
        this._pendingAction = "recarga";
        this.requestUpdate();
        try {
            const result = await getAreaCatalog(this.hass, this._config.entity);
            if (!result.ok || !Array.isArray(result.areas) || !result.revision) {
                this._setMessage(
                    result.error === "unavailable"
                        ? "La aspiradora no está disponible."
                        : "No se pudo leer el catálogo de zonas.",
                    "error",
                );
                return;
            }
            const catalog: CatalogView = {
                map_id: result.map_id ?? null,
                revision: result.revision,
                areas: result.areas,
                observed_at: result.observed_at ?? new Date().toISOString(),
                age_seconds: 0,
                fresh: true,
                available: true,
                error: null,
            };
            if (
                this._draft?.isDirty &&
                (catalog.revision !== this._draft.baseRevision || catalog.map_id !== this._draft.baseMapId)
            ) {
                this._draftConflict = {
                    map_id: catalog.map_id,
                    revision: catalog.revision,
                    areas: catalog.areas,
                    observed_at: catalog.observed_at,
                };
            } else if (this._snapshot) {
                const selectionNeedsReview =
                    this._selectedIds.length > 0 &&
                    (catalog.revision !== this._snapshot.catalog.revision ||
                        catalog.map_id !== this._snapshot.catalog.map_id);
                this._snapshot = { ...this._snapshot, catalog, pose: result.pose ?? this._snapshot.pose };
                if (selectionNeedsReview) this._selectionNeedsReview = true;
                if (!this._draft) this._fitMap();
            }
            if (forUncertain) this._catalogReloadedAfterUncertain = true;
            else this._setMessage("Catálogo de zonas leído directamente del robot.", "success");
        } catch (error) {
            this._setMessage(`No se pudo recargar el catálogo: ${errorMessage(error)}`, "error");
        } finally {
            this._pendingAction = "";
            this.requestUpdate();
        }
    };

    public _refreshData = async (): Promise<void> => {
        if (!this.hass || !this._config || this._pendingAction) return;
        this._pendingAction = "recarga";
        this.requestUpdate();
        try {
            const result = await refreshCard(this.hass, this._config.entity);
            if (!result.ok) {
                this._setMessage(
                    result.error === "not_found"
                        ? "La entidad ya no está disponible."
                        : "No se pudieron recargar el estado y el catálogo.",
                    "error",
                );
                return;
            }
            this._receiveSnapshot(result);
            if (this._uncertainAction) {
                this._uncertainAction = false;
                this._setMessage(
                    "Estado y catálogo releídos. Revisá la actividad observada antes de iniciar otra operación.",
                    "info",
                    true,
                );
            } else {
                this._setMessage("Estado y catálogo recargados.", "success");
            }
            if (this._uncertainDraft) this._catalogReloadedAfterUncertain = true;
        } catch (error) {
            this._setMessage(`No se pudo recargar: ${errorMessage(error)}`, "error");
        } finally {
            this._pendingAction = "";
            this.requestUpdate();
        }
    };

    public _setMessage(message: string, kind: "info" | "error" | "success" | "warning", notify = false): void {
        this.notifyMessage = notify || kind === "warning";
        this._message = message;
        this.messageSequence += 1;
        this._messageKind = kind === "warning" ? "info" : kind;
        this.requestUpdate();
    }

    static styles = css`
        .zk-secondary {
            padding: 16px;
            border-top: 1px solid var(--divider-color, #ddd);
        }
        .zk-secondary button,
        .zk-secondary input,
        .zk-secondary select {
            font: inherit;
        }
        .zk-secondary button {
            padding: 8px 12px;
            border-radius: 8px;
            border: 1px solid var(--divider-color, #aaa);
            background: var(--card-background-color, white);
            color: var(--primary-text-color, #222);
            cursor: pointer;
        }
        .zk-secondary button:disabled {
            opacity: 0.45;
            cursor: default;
        }
        .field-label {
            display: grid;
            gap: 6px;
            margin: 10px 0;
        }
        input,
        select {
            color: var(--primary-text-color, #222);
            background: var(--card-background-color, white);
            border: 1px solid var(--divider-color, #aaa);
            border-radius: 6px;
            padding: 8px;
            max-width: 100%;
            box-sizing: border-box;
        }
        .draft-buttons,
        .geometry-tools,
        .polygon-nudges {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
            margin: 12px 0;
        }
        .zone-list {
            list-style: none;
            padding: 0;
            display: grid;
            gap: 6px;
            max-height: 250px;
            overflow: auto;
        }
        .zone-row {
            width: 100%;
            display: flex;
            text-align: left;
            gap: 10px;
            align-items: center;
        }
        .zone-row small,
        .zone-row strong {
            display: block;
        }
        .zone-row-text {
            flex: 1;
        }
        .zone-row.selected {
            border-color: var(--primary-color, #03a9f4);
        }
        .draft-title {
            display: flex;
            justify-content: space-between;
        }
        .notice {
            padding: 10px;
            border-radius: 8px;
            background: var(--secondary-background-color, #eee);
        }
        .route-tools {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            align-items: center;
        }
        .route-tools small {
            width: 100%;
            color: var(--secondary-text-color, #666);
        }
        .route-tools label {
            display: inline-flex;
            align-items: center;
            gap: 5px;
        }
        .zone-shape {
            vector-effect: non-scaling-stroke;
            stroke-width: 2.5;
            transition: fill-opacity 120ms ease, stroke-width 120ms ease;
        }
        .zone-shape.normal {
            fill: var(--zk-zone-normal);
            fill-opacity: 0.23;
            stroke: var(--zk-zone-normal);
        }
        .zone-shape.depth {
            fill: var(--zk-zone-depth);
            fill-opacity: 0.25;
            stroke: var(--zk-zone-depth);
            stroke-dasharray: 7 4;
        }
        .zone-shape.forbid {
            fill: var(--zk-zone-forbid);
            fill-opacity: 0.16;
            stroke: var(--zk-zone-forbid);
            stroke-dasharray: 3 4;
        }
        .zone-shape.unsupported {
            fill: var(--secondary-text-color);
            fill-opacity: 0.18;
            stroke: var(--secondary-text-color);
            stroke-dasharray: 2 6;
        }
        .zone-group:hover .zone-shape,
        .zone-group:focus-visible .zone-shape,
        .zone-group.selected .zone-shape {
            fill-opacity: 0.4;
            stroke-width: 4;
        }
        .zone-group.editing .zone-shape {
            stroke-width: 4;
            stroke-dasharray: 8 4;
        }
        .zone-label,
        .zone-type-label,
        .empty-map-label {
            pointer-events: none;
            text-anchor: middle;
            dominant-baseline: middle;
            fill: var(--primary-text-color);
            paint-order: stroke;
            stroke: var(--card-background-color, white);
            stroke-width: 5px;
            stroke-linejoin: round;
        }
        .zone-label {
            font-size: var(--zk-world-font-size, 29px);
            font-weight: 700;
        }
        .zone-type-label {
            font-size: 21px;
            fill: var(--secondary-text-color);
        }
        .empty-map-label {
            font-size: 25px;
            fill: var(--secondary-text-color);
        }
        .vertex-handle {
            vector-effect: non-scaling-stroke;
            fill: var(--card-background-color, white);
            stroke: var(--primary-color, #526dcc);
            stroke-width: 3;
            cursor: move;
            touch-action: none;
        }
        .vertex-handle.active,
        .vertex-handle:focus-visible {
            fill: var(--primary-color, #526dcc);
            stroke: var(--card-background-color, white);
            stroke-width: 4;
        }
        .empty-list {
            padding: 14px 3px;
            color: var(--secondary-text-color);
            font-size: 0.85rem;
        }
        .zone-list {
            display: grid;
            gap: 5px;
            max-height: 320px;
            overflow: auto;
            margin: 0;
            padding: 0;
            list-style: none;
        }
        .zone-row {
            display: grid;
            grid-template-columns: 34px minmax(0, 1fr) auto;
            align-items: center;
            width: 100%;
            min-height: 52px;
            gap: 9px;
            padding: 6px 9px;
            text-align: left;
            color: var(--primary-text-color);
            background: var(--card-background-color, white);
            border: 1px solid transparent;
            border-radius: 10px;
            cursor: pointer;
        }
        .zone-row:hover:not(:disabled),
        .zone-row.selected {
            border-color: var(--primary-color);
            background: color-mix(in srgb, var(--primary-color, #526dcc) 9%, var(--card-background-color, white));
        }
        .zone-row.forbidden {
            border-left: 3px dashed var(--zk-zone-forbid);
        }
        .zone-row:disabled {
            opacity: 0.62;
            cursor: not-allowed;
        }
        .zone-row-mark {
            display: grid;
            place-items: center;
            width: 29px;
            height: 29px;
            border-radius: 8px;
            color: var(--primary-color);
            background: var(--secondary-background-color);
            font-size: 0.8rem;
            font-weight: 700;
        }
        .zone-row.forbidden .zone-row-mark {
            color: var(--zk-zone-forbid);
        }
        .zone-row-text {
            min-width: 0;
        }
        .zone-row-text strong,
        .zone-row-text small {
            display: block;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .zone-row-text strong {
            font-size: 0.84rem;
        }
        .zone-row-text small {
            margin-top: 3px;
            color: var(--secondary-text-color);
            font-size: 0.7rem;
        }
        .zone-row-action {
            color: var(--primary-color);
            font-size: 0.78rem;
            font-weight: 700;
        }
        .selection-actions {
            margin-top: 9px;
        }
        .selection-actions .button {
            flex: 1;
        }
        .text-button {
            min-height: 35px;
            padding: 4px 7px;
            color: var(--primary-color);
            background: transparent;
            border: 0;
            border-radius: 8px;
            font-size: 0.78rem;
            font-weight: 600;
            text-align: left;
        }
        .text-button:hover:not(:disabled) {
            background: var(--secondary-background-color);
        }
        .edit-controls {
            margin-top: 16px;
            padding-top: 13px;
            border-top: 1px solid var(--zk-card-border);
        }
        .draft-panel {
            display: grid;
            gap: 9px;
        }
        .draft-panel > p,
        .draft-conflict-summary,
        .draft-panel small,
        .editor-help {
            color: var(--secondary-text-color);
            font-size: 0.78rem;
            line-height: 1.4;
        }
        .conflict-catalog {
            max-height: 150px;
            overflow: auto;
            padding: 9px 10px;
            border: 1px solid var(--zk-card-border);
            border-radius: 9px;
            font-size: 0.82rem;
        }
        .conflict-catalog ul {
            margin: 6px 0 0;
            padding-left: 20px;
        }
        .conflict-catalog li {
            padding: 2px 0;
        }
        .conflict-catalog p {
            margin: 6px 0 0;
        }
        .draft-title span {
            color: var(--secondary-text-color);
            font-size: 0.75rem;
        }
        .field-label {
            display: grid;
            gap: 5px;
            font-size: 0.76rem;
            font-weight: 600;
        }
        .field-label input,
        .field-label select {
            width: 100%;
            font-weight: 400;
        }
        .geometry-tools {
            padding-top: 2px;
            color: var(--secondary-text-color);
            font-size: 0.75rem;
        }
        .nudge-tools {
            display: flex;
            justify-content: center;
            gap: 6px;
        }
        .editor-help {
            margin: 0;
        }
        .delete-button {
            color: var(--error-color, #b3261e);
        }
        .validation {
            color: var(--error-color, #b3261e) !important;
            font-size: 0.78rem;
        }
        .draft-buttons {
            justify-content: flex-start;
            flex-wrap: wrap;
        }
        .draft-buttons .button {
            flex: 1;
            min-width: 82px;
        }
        .footer {
            margin-top: 12px;
            padding: 10px 2px 0;
            border-top: 1px solid var(--zk-card-border);
            color: var(--secondary-text-color);
            font-size: 0.68rem;
        }
        .loading,
        .setup {
            padding: 18px;
            color: var(--secondary-text-color);
        }
        .incompatible {
            display: grid;
            gap: 10px;
        }
        :focus-visible {
            outline: 2px solid var(--primary-color);
            outline-offset: 2px;
        }
    `;
}
