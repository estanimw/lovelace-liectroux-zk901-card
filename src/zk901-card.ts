/* eslint-disable @typescript-eslint/no-unused-vars */
import { css, html, LitElement, nothing, svg, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators";
import { LovelaceCardEditor } from "custom-card-helpers";

import "./editor";

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
import {
    CARD_CUSTOM_ELEMENT_NAME,
    CARD_VERSION,
    EDITOR_CUSTOM_ELEMENT_NAME,
    INTEGRATION_DOMAIN,
} from "./const";
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

interface CardConfig {
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

interface PointerPosition {
    x: number;
    y: number;
}

interface VertexGesture {
    pointerId: number;
    index?: number;
    last: Point;
    before: ReturnType<ZoneDraft["beginGesture"]>;
    moved: boolean;
}

let gridCounter = 0;

function zoneName(area: ZoneArea): string {
    const tag = typeof area.tag === "string" ? area.tag.trim() : "";
    const name = typeof area.name === "string" ? area.name.trim() : "";
    return tag || name || `Zona ${area.id}`;
}

function zoneType(active: unknown): string {
    if (active === "normal") return "Normal";
    if (active === "depth") return "Profunda";
    if (active === "forbid") return "Prohibida";
    return "Tipo no compatible";
}

function statusName(snapshot?: CardSnapshot): string {
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

function timestampLabel(value: string | null): string {
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

function finitePosition(pose: ZonePose | null): pose is ZonePose {
    return (
        !!pose &&
        Array.isArray(pose.pos) &&
        pose.pos.length === 2 &&
        pose.pos.every(value => Number.isFinite(value))
    );
}

function htmlError(result: ApplyAreaEditResponse): string {
    if (result.error === "conflict") return "El catálogo cambió mientras editabas. Tu borrador quedó intacto para que lo revises.";
    if (result.error === "uncertain") return "No se pudo confirmar el guardado. Recargá el catálogo antes de decidir si volvés a intentarlo.";
    if (result.error === "invalid" || result.error === "rejected") return result.detail ?? "La integración rechazó el cambio.";
    if (result.error === "not_found") return "La entidad de la integración ya no está disponible.";
    if (result.error === "unavailable") return "La aspiradora no está disponible para guardar las zonas.";
    if (result.error === "failed") return "No se pudo completar el guardado. El resultado puede ser incierto; recargá el catálogo.";
    return "No se pudo guardar la zona.";
}

@customElement(CARD_CUSTOM_ELEMENT_NAME)
export class LiectrouxZK901MapCard extends LitElement {
    @property({ attribute: false }) public hass?: HomeAssistantFixed;
    @state() private _config?: CardConfig;
    @state() private _snapshot?: CardSnapshot;
    @state() private _message = "";
    @state() private _messageKind: "info" | "error" | "success" = "info";
    @state() private _loading = true;
    @state() private _apiCompatible = true;
    @state() private _selectedIds: number[] = [];
    @state() private _selectionNeedsReview = false;
    @state() private _editMode = false;
    @state() private _draft: ZoneDraft | null = null;
    @state() private _activeVertex: number | null = null;
    @state() private _draftConflict: CatalogConflict | null = null;
    @state() private _uncertainDraft = false;
    @state() private _catalogReloadedAfterUncertain = false;
    @state() private _pendingAction = "";
    @state() private _uncertainAction = false;
    @state() private _zoom = 1;

    private _unsubscribe?: () => void;
    private _subscribedEntity = "";
    private _subscribedConnection?: HomeAssistantFixed["connection"];
    private _subscriptionEpoch = 0;
    private _generation = "";
    private _sequence = -1;
    private _pendingSnapshot?: CardSnapshot;
    private _savingDraft = false;
    private _initialFitDone = false;
    private _canvasExpansion = 1;
    private _homeBounds?: WorldBounds;
    private _panX = 0;
    private _panY = 0;
    private _mapPointers = new Map<number, PointerPosition>();
    private _panLast?: PointerPosition;
    private _pinchStart?: { distance: number; zoom: number; anchor: Point };
    private _vertexGesture?: VertexGesture;
    private _suppressClickUntil = 0;
    private readonly _gridId = `zk901-grid-${gridCounter++}`;

    setConfig(config: CardConfig): void {
        if (!config || typeof config.entity !== "string" || !config.entity.startsWith("vacuum.")) {
            throw new Error("La tarjeta ZK901 necesita entity: vacuum.<entidad>.");
        }
        this._config = { ...config };
        this.requestUpdate();
    }

    getCardSize(): number {
        return 9;
    }

    static async getConfigElement(): Promise<LovelaceCardEditor> {
        return document.createElement(EDITOR_CUSTOM_ELEMENT_NAME) as unknown as LovelaceCardEditor;
    }

    static getStubConfig(hass: HomeAssistantFixed): CardConfig | undefined {
        const entity = Object.values(hass.entities ?? {}).find(
            entry => entry.platform === INTEGRATION_DOMAIN && entry.entity_id.startsWith("vacuum."),
        );
        return entity ? { type: CARD_CUSTOM_ELEMENT_NAME, entity: entity.entity_id } : undefined;
    }

    connectedCallback(): void {
        super.connectedCallback();
        this._ensureSubscription();
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
        this._subscriptionEpoch += 1;
        this._unsubscribe?.();
        this._unsubscribe = undefined;
        this._subscribedEntity = "";
        this._subscribedConnection = undefined;
        this._mapPointers.clear();
        this._panLast = undefined;
        this._pinchStart = undefined;
        this._vertexGesture = undefined;
    }

    protected updated(changed: PropertyValues<this>): void {
        if (changed.has("hass") || changed.has("_config" as keyof LiectrouxZK901MapCard)) this._ensureSubscription();
    }

    protected render(): TemplateResult {
        if (!this._config) return html`<ha-card><p class="setup">Elegí una entidad Liectroux ZK901.</p></ha-card>`;
        if (!this.hass || this._loading && !this._snapshot) {
            return html`<ha-card><div class="loading" role="status">${this._loading ? "Conectando con la integración…" : "Esperando Home Assistant…"}</div></ha-card>`;
        }
        if (!this._apiCompatible) {
            return html`
                <ha-card class="card incompatible">
                    <div class="header">
                        <div><h2>${this._title}</h2><span class="version">Tarjeta ${CARD_VERSION}</span></div>
                    </div>
                    <div class="notice error" role="alert">
                        ${this._message || "La API de la integración es incompatible o no está disponible. Instalá juntos el paquete de tarjeta e integración de la misma entrega."}
                    </div>
                    <button class="button" @click=${this._refreshData}>Volver a comprobar</button>
                </ha-card>
            `;
        }
        const snapshot = this._snapshot;
        const battery = snapshot?.status.battery;
        const batteryText = typeof battery === "number" && Number.isFinite(battery) ? `${Math.round(battery)}%` : "—";
        const busy = !!this._pendingAction;
        const paused = snapshot?.status.mode === "pause";
        const state = statusName(snapshot);
        const current = this.hass.states[this._config.entity];
        const friendlyName = typeof current?.attributes?.friendly_name === "string"
            ? current.attributes.friendly_name
            : this._title;
        const poseAge = snapshot?.pose?.observed_at ? Date.now() - Date.parse(snapshot.pose.observed_at) : Number.POSITIVE_INFINITY;
        const poseStale = !Number.isFinite(poseAge) || poseAge > 60_000;
        const currentSelectionValid = this._selectionIsValid();
        const catalogFresh = !!snapshot?.catalog.fresh && !!snapshot.catalog.available;
        const canCleanSelection = this._selectedIds.length > 0 && currentSelectionValid && catalogFresh && !this._selectionNeedsReview;
        const canAct = !!snapshot?.available && this._apiCompatible && !busy && !this._uncertainAction;
        const showDraftWarning = !!this._draftConflict || this._uncertainDraft;

        return html`
            <ha-card class="card">
                <header class="header">
                    <div class="identity">
                        <h2>${friendlyName || this._title || "Liectroux ZK901"}</h2>
                        <div class="state-line">
                            <span class="status-dot ${snapshot?.available ? "online" : "offline"}" aria-hidden="true"></span>
                            <span>${state}</span>
                            ${snapshot?.status.error && String(snapshot.status.error) !== "0" ? html`
                                <span class="error-state">Error ${String(snapshot.status.error)}</span>
                            ` : nothing}
                        </div>
                    </div>
                    <div class="battery" aria-label="Batería ${batteryText}">
                        <span aria-hidden="true">▰</span>
                        <strong>${batteryText}</strong>
                    </div>
                </header>

                ${this._message ? html`
                    <div class="notice ${this._messageKind}" role=${this._messageKind === "error" ? "alert" : "status"} aria-live="polite">
                        ${this._message}
                    </div>
                ` : nothing}
                ${this._uncertainAction ? html`
                    <div class="notice warning" role="alert">
                        El resultado del último comando no se confirmó. Recargá los datos y revisá el estado antes de enviar otra acción.
                        <button class="text-button" @click=${this._refreshData} ?disabled=${busy}>Recargar estado</button>
                    </div>
                ` : nothing}

                <div class="daily-controls" aria-label="Controles de limpieza">
                    <button class="button primary" @click=${() => this._vacuumAction("start", paused ? "continuar limpieza" : "iniciar limpieza total")} ?disabled=${!canAct}>
                        ${paused ? "Continuar limpieza" : "Iniciar limpieza total"}
                    </button>
                    <button class="button" @click=${() => this._vacuumAction("pause", "pausar")} ?disabled=${!canAct || paused}>
                        Pausar
                    </button>
                    <button class="button" @click=${() => this._vacuumAction("stop", "detener")} ?disabled=${!canAct}>
                        Detener
                    </button>
                    <button class="button" @click=${() => this._vacuumAction("return_to_base", "volver a la base")} ?disabled=${!canAct}>
                        Volver a la base
                    </button>
                    <button class="button localized" @click=${() => this._vacuumAction("clean_spot", "limpiar la posición actual")} ?disabled=${!canAct}>
                        Limpiar posición actual
                    </button>
                    <label class="power-control">
                        <span>Intensidad ${snapshot?.status.cleaning_level_kind === "water" ? "de agua" : snapshot?.status.cleaning_level_kind === "suction" ? "de aspiración" : ""}</span>
                        <select
                            aria-label="Intensidad de limpieza"
                            .value=${snapshot?.status.cleaning_level ?? "auto"}
                            @change=${this._powerChanged}
                            ?disabled=${!canAct}
                        >
                            <option value="quiet">Silenciosa</option>
                            <option value="auto">Automática</option>
                            <option value="strong">Fuerte</option>
                        </select>
                    </label>
                </div>

                <div class="workspace">
                    <section class="map-column" aria-label="Mapa vectorial de zonas y posición">
                        <div class="section-heading">
                            <div>
                                <h3>Plano de zonas</h3>
                                <p>${snapshot?.pose ? `Posición ${poseStale ? "observada" : "actual"} ${timestampLabel(snapshot.pose.observed_at)}` : "Posición no disponible"}</p>
                            </div>
                            <div class="map-tools">
                                <button class="icon-button" aria-label="Reducir zoom" title="Reducir zoom" @click=${() => this._changeZoom(1 / 1.25)}>−</button>
                                <button class="icon-button" aria-label="Aumentar zoom" title="Aumentar zoom" @click=${() => this._changeZoom(1.25)}>+</button>
                                <button class="icon-button fit-button" title="Ajustar el plano" @click=${this._fitMap}>Ajustar</button>
                            </div>
                        </div>
                        <div class="map-stage ${poseStale ? "pose-stale" : ""}">
                            ${this._renderMap()}
                            ${poseStale ? html`<div class="map-overlay" role="status">La última posición es antigua; no se muestra como actual.</div>` : nothing}
                        </div>
                        <div class="map-meta">
                            <span>${this._snapshot?.catalog?.areas?.length ?? 0} zonas</span>
                            <span>Catálogo ${this._snapshot?.catalog?.fresh && this._snapshot?.catalog?.available ? "actualizado" : "antiguo o sin lectura"} ${timestampLabel(this._snapshot?.catalog?.observed_at ?? null)}</span>
                        </div>
                        ${this._snapshot?.catalog?.areas?.length === 0 ? html`
                            <div class="empty-map">
                                <span>No hay zonas guardadas.</span>
                                <button class="text-button" @click=${this._expandDrawingSpace}>Ampliar espacio de dibujo</button>
                            </div>
                        ` : nothing}
                    </section>

                    <aside class="zones-panel" aria-label="Zonas guardadas y edición">
                        <div class="section-heading panel-heading">
                            <div><h3>Zonas guardadas</h3><p>${this._selectedIds.length ? `${this._selectedIds.length} seleccionada${this._selectedIds.length === 1 ? "" : "s"}` : "Elegí una o varias para limpiar"}</p></div>
                            <button class="button small" @click=${this._refreshData} ?disabled=${busy}>Recargar</button>
                        </div>
                        ${this._renderZoneList()}
                        ${this._selectionNeedsReview ? html`
                            <div class="notice warning compact" role="alert">
                                El catálogo cambió. Revisá la selección; no se enviará un subconjunto automáticamente.
                                <button class="text-button" @click=${this._clearSelection}>Vaciar selección y volver a elegir</button>
                            </div>
                        ` : nothing}
                        ${!catalogFresh ? html`
                            <div class="notice warning compact" role="status">
                                Recargá el catálogo para confirmar que las zonas seleccionadas siguen disponibles.
                            </div>
                        ` : nothing}
                        <div class="selection-actions">
                            <button class="text-button" @click=${this._clearSelection} ?disabled=${!this._selectedIds.length}>Limpiar selección</button>
                            <button class="button primary" @click=${this._cleanSelected} ?disabled=${!canAct || !canCleanSelection || this._editMode || !!this._draft || !!showDraftWarning}>
                                Limpiar ${this._selectedIds.length ? `seleccionadas (${this._selectedIds.length})` : "seleccionadas"}
                            </button>
                        </div>

                        <div class="edit-controls">
                            <div class="section-heading panel-heading">
                                <div><h3>Editar zonas</h3><p>${this._editMode ? "Modo de edición activo" : "Creá o modificá zonas persistidas"}</p></div>
                                <button class="button small" @click=${this._toggleEditMode} ?disabled=${busy || this._uncertainDraft}>
                                    ${this._editMode ? "Salir" : "Editar"}
                                </button>
                            </div>
                            ${this._editMode ? this._renderDraftPanel() : nothing}
                        </div>
                    </aside>
                </div>

                <footer class="footer">
                    <span>API ${this._snapshot?.api_version ?? "—"} · Tarjeta ${CARD_VERSION}</span>
                    <span>Sin recorrido LiDAR ni paredes reconstruidas</span>
                </footer>
            </ha-card>
        `;
    }

    private get _title(): string {
        return typeof this._config?.title === "string" && this._config.title.trim()
            ? this._config.title.trim()
            : "Liectroux ZK901";
    }

    private _ensureSubscription(): void {
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

    private _receiveSnapshot(incoming: CardSnapshot): void {
        if (!incoming || typeof incoming !== "object" || incoming.entity_id !== this._config?.entity) return;
        if (incoming.api_version !== 1 || !incoming.catalog || !Array.isArray(incoming.catalog.areas)) {
            this._apiCompatible = false;
            this._loading = false;
            this._setMessage("La integración devolvió una versión de API incompatible. Instalá el paquete conjunto.", "error");
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

    private _applySnapshot(incoming: CardSnapshot): void {
        const previous = this._snapshot;
        const changedCatalog = !!previous && (
            previous.catalog.revision !== incoming.catalog.revision ||
            previous.catalog.map_id !== incoming.catalog.map_id
        );
        if (this._draft?.isDirty && changedCatalog) {
            this._draftConflict = {
                map_id: incoming.catalog.map_id,
                revision: incoming.catalog.revision,
                areas: incoming.catalog.areas,
                observed_at: incoming.catalog.observed_at,
            };
            this._snapshot = { ...incoming, catalog: previous.catalog };
            this._setMessage("El catálogo cambió en otra vista. Tu borrador quedó intacto; revisá los cambios antes de guardarlo.", "error");
            return;
        }
        if (this._draft && changedCatalog && !this._draft.isDirty) {
            this._draft = null;
            this._setMessage("El catálogo se actualizó antes de que modificaras una zona.", "info");
        }
        if (previous && changedCatalog && this._selectedIds.length) this._selectionNeedsReview = true;
        this._snapshot = incoming;
        if (!this._initialFitDone) this._fitMap();
    }

    private _renderMap(): TemplateResult {
        const snapshot = this._snapshot;
        const areas = snapshot?.catalog.areas ?? [];
        const view = this._viewBounds();
        const viewWidth = Math.max(1, view.maxX - view.minX);
        const viewHeight = Math.max(1, view.maxY - view.minY);
        const step = Math.max(10, Math.max(viewWidth, viewHeight) / 12);
        const viewBox = `${view.minX} ${-view.maxY} ${viewWidth} ${viewHeight}`;
        const draftArea = this._draft?.area;
        const showDraft = !!draftArea && !this._draft?.deleted;
        const visibleAreas = areas.filter(area =>
            validVertices(area.vertexs) && !(showDraft && draftArea?.id === area.id),
        );
        const poseCandidate = snapshot?.pose ?? null;
        const pose = finitePosition(poseCandidate) ? poseCandidate : null;
        const poseRotation = pose?.phi === null || pose?.phi === undefined ? 0 : -(pose.phi / 1000) * (180 / Math.PI);

        return html`
            <svg
                class="map"
                viewBox=${viewBox}
                preserveAspectRatio="xMidYMid meet"
                role="group"
                aria-label="Mapa vectorial de zonas guardadas y posición del robot"
                @pointerdown=${this._mapPointerDown}
                @pointermove=${this._mapPointerMove}
                @pointerup=${this._mapPointerUp}
                @pointercancel=${this._mapPointerUp}
                @wheel=${this._mapWheel}
            >
                <defs>
                    <pattern id=${this._gridId} width=${step} height=${step} patternUnits="userSpaceOnUse" x=${view.minX} y=${-view.maxY}>
                        <path d=${`M ${step} 0 L 0 0 0 ${step}`} class="grid-line"></path>
                    </pattern>
                </defs>
                <rect x=${view.minX} y=${-view.maxY} width=${viewWidth} height=${viewHeight} class="map-background"></rect>
                <rect x=${view.minX} y=${-view.maxY} width=${viewWidth} height=${viewHeight} fill=${`url(#${this._gridId})`}></rect>
                ${visibleAreas.map(area => this._renderArea(area, false))}
                ${showDraft && draftArea ? this._renderDraftArea(draftArea) : nothing}
                ${pose ? svg`
                    <g class="robot ${this._snapshot?.available ? "" : "stale"}" transform=${`translate(${pose.pos[0]} ${-pose.pos[1]}) rotate(${poseRotation})`} aria-label="Posición del robot">
                        <circle r="30" class="robot-shadow"></circle>
                        <path d="M 0 -34 L 23 22 L 0 13 L -23 22 Z" class="robot-body"></path>
                        <circle r="4" class="robot-center"></circle>
                    </g>
                ` : nothing}
                ${areas.length === 0 ? svg`
                    <text x=${(view.minX + view.maxX) / 2} y=${-((view.minY + view.maxY) / 2)} class="empty-map-label">
                        Sin zonas guardadas · sin paredes ni escala física
                    </text>
                ` : nothing}
            </svg>
        `;
    }

    private _renderArea(area: ZoneArea, isDraft: boolean): TemplateResult {
        const vertices = validVertices(area.vertexs) ? area.vertexs : [];
        const center = vertices.length ? polygonCenter(vertices) : [0, 0];
        const selected = this._selectedIds.includes(area.id);
        const isEditable = isDraft || (this._draft?.area?.id === area.id && !this._draft.deleted);
        const kind = area.active === "depth" ? "depth" : area.active === "forbid" ? "forbid" : area.active === "normal" ? "normal" : "unsupported";
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
                <polygon points=${vertices.map(([x, y]) => `${x},${-y}`).join(" ")} class=${`zone-shape ${kind}`}></polygon>
                <text x=${center[0]} y=${-center[1]} class="zone-label">${zoneName(area)}</text>
                <text x=${center[0]} y=${-center[1] + 24} class="zone-type-label">${zoneType(area.active)}</text>
                ${isEditable ? this._renderVertexHandles(vertices) : nothing}
            </g>
        `;
    }

    private _renderDraftArea(area: NonNullable<ZoneDraft["area"]>): TemplateResult {
        const selectedArea: ZoneArea = {
            ...area,
            id: area.id ?? -99,
            tag: area.tag,
            active: area.active,
            vertexs: area.vertexs,
        };
        return this._renderArea(selectedArea, area.id === null);
    }

    private _renderVertexHandles(vertices: Point[]): TemplateResult[] {
        return vertices.map(([x, y], index) => svg`
            <circle
                cx=${x}
                cy=${-y}
                r="20"
                class=${`vertex-handle ${this._activeVertex === index ? "active" : ""}`}
                data-vertex-index=${index}
                role="button"
                tabindex="0"
                aria-label=${`Vértice ${index + 1}`}
                @click=${(event: MouseEvent) => {
                    event.stopPropagation();
                    this._activeVertex = index;
                }}
                @keydown=${(event: KeyboardEvent) => this._vertexKeyDown(event, index)}
            ></circle>
        `);
    }

    private _renderZoneList(): TemplateResult {
        const areas = this._snapshot?.catalog.areas ?? [];
        if (!areas.length) {
            return html`<p class="empty-list">El catálogo no tiene zonas guardadas.</p>`;
        }
        return html`
            <ul class="zone-list">
                ${areas.map((area, index) => {
                    const cleanable = this._isCleanable(area, areas);
                    const selected = this._selectedIds.includes(area.id);
                    const editable = isPositiveId(area) && ["normal", "depth", "forbid"].includes(String(area.active)) && validVertices(area.vertexs);
                    return html`
                        <li>
                            <button
                                class=${`zone-row ${selected ? "selected" : ""} ${area.active === "forbid" ? "forbidden" : ""}`}
                                aria-pressed=${selected ? "true" : "false"}
                                @click=${() => this._zoneRowActivated(area, areas)}
                                ?disabled=${this._editMode ? !!this._draft || !editable : !cleanable && area.active !== "forbid" && !this._editMode}
                                title=${this._editMode ? "Abrir zona para editar" : area.active === "forbid" ? "Zona prohibida: se puede inspeccionar y editar, pero no limpiar" : cleanable ? "Seleccionar para limpiar" : "No se puede seleccionar esta zona"}
                            >
                                <span class="zone-row-mark" aria-hidden="true">${area.active === "forbid" ? "⊘" : area.active === "depth" ? "◆" : index + 1}</span>
                                <span class="zone-row-text"><strong>${zoneName(area)}</strong><small>${zoneType(area.active)} · ID ${String(area.id)}</small></span>
                                <span class="zone-row-action" aria-hidden="true">${this._editMode ? editable ? "Editar" : "—" : selected ? "✓" : cleanable ? "+" : ""}</span>
                            </button>
                        </li>
                    `;
                })}
            </ul>
        `;
    }

    private _renderDraftPanel(): TemplateResult {
        const areas = this._snapshot?.catalog.areas ?? [];
        if (this._draftConflict) {
            return html`
                <div class="draft-panel">
                    <div class="notice warning compact" role="alert">
                        ${this._uncertainDraft
                            ? "Se perdió la respuesta del guardado y llegó un catálogo nuevo. El resultado es incierto; el borrador no se reenviará automáticamente."
                            : `El catálogo nuevo tiene ${this._draftConflict.areas.length} zonas (revisión ${this._draftConflict.revision?.slice(0, 8) ?? "desconocida"}). Tu borrador usa el mapa ${String(this._draft?.baseMapId)} y no fue reemplazado.`}
                    </div>
                    <p class="draft-conflict-summary">
                        Borrador local: ${this._draft?.deleted ? "eliminar zona" : this._draft?.operation === "create" ? `crear “${this._draft.area?.tag || "Zona nueva"}”` : `editar “${this._draft?.area?.tag || "zona"}”`}.
                        Podés cargar el catálogo nuevo para revisar el estado persistido.
                    </p>
                    <div class="conflict-catalog" aria-label="Catálogo nuevo recibido">
                        <strong>Catálogo recibido · mapa ${String(this._draftConflict.map_id ?? "desconocido")}</strong>
                        ${this._draftConflict.areas.length ? html`
                            <ul>
                                ${this._draftConflict.areas.map(area => html`
                                    <li>${zoneName(area)} · ${zoneType(area.active)} · ID ${String(area.id)}</li>
                                `)}
                            </ul>
                        ` : html`<p>El catálogo no contiene zonas.</p>`}
                    </div>
                    ${this._uncertainDraft ? html`
                        <button class="button" @click=${this._reloadDraftCatalog} ?disabled=${!!this._pendingAction}>Recargar catálogo</button>
                    ` : nothing}
                    <button class="button" @click=${this._discardAndLoadConflict}>Descartar borrador y cargar catálogo actualizado</button>
                </div>
            `;
        }
        if (this._uncertainDraft) {
            return html`
                <div class="draft-panel">
                    <div class="notice warning compact" role="alert">
                        El guardado no tiene confirmación. No se reenviará automáticamente. Recargá el catálogo y comprobá si el cambio quedó persistido.
                    </div>
                    <button class="button" @click=${this._reloadDraftCatalog} ?disabled=${!!this._pendingAction}>Recargar catálogo</button>
                    ${this._catalogReloadedAfterUncertain ? html`
                        <button class="text-button" @click=${this._allowExplicitRetry}>Ya revisé el catálogo; habilitar un nuevo intento</button>
                    ` : nothing}
                    <button class="text-button" @click=${this._discardDraft}>Descartar borrador</button>
                </div>
            `;
        }
        if (!this._draft) {
            return html`
                <div class="draft-panel">
                    <p>Los cambios se guardan solo cuando elegís Guardar. Arrastrar el plano no modifica el robot.</p>
                    <button class="button primary" @click=${this._createZone} ?disabled=${!!this._pendingAction || !this._snapshot?.catalog.fresh || !this._snapshot?.catalog.available}>
                        Crear zona
                    </button>
                    <small>${areas.length ? "Elegí una zona de la lista o del plano para modificarla." : "El plano usa la posición para centrar el dibujo; no representa paredes ni el tamaño de la vivienda."}</small>
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
                    <strong>${draft.operation === "create" ? "Zona nueva" : draft.deleted ? "Eliminar zona" : `Editar ${area?.tag || "zona"}`}</strong>
                    <span>${draft.operation === "create" ? "Borrador" : `ID ${String(area?.id ?? draft.baseArea?.id)}`}</span>
                </div>
                ${!draft.deleted && area ? html`
                    <label class="field-label">Nombre
                        <input type="text" maxlength="80" .value=${area.tag} @input=${this._draftTagChanged} />
                    </label>
                    <label class="field-label">Tipo de zona
                        <select .value=${area.active} @change=${this._draftTypeChanged}>
                            <option value="normal">Normal</option>
                            <option value="depth">Profunda</option>
                            <option value="forbid">Prohibida</option>
                        </select>
                    </label>
                    <div class="geometry-tools">
                        <span>${area.vertexs.length} vértices${this._activeVertex !== null ? ` · seleccionado ${this._activeVertex + 1}` : ""}</span>
                        <div>
                            <button class="icon-button" aria-label="Añadir vértice" title="Añadir vértice" @click=${this._addVertex} ?disabled=${area.vertexs.length >= 128}>＋</button>
                            <button class="icon-button" aria-label="Quitar vértice seleccionado" title="Quitar vértice seleccionado" @click=${this._removeSelectedVertex} ?disabled=${area.vertexs.length <= 3 || this._activeVertex === null}>−</button>
                        </div>
                    </div>
                    <div class="nudge-tools" aria-label="Mover el polígono con el teclado o los botones">
                        <button class="icon-button" aria-label="Mover arriba" @click=${() => this._nudgePolygon(0, 1)}>↑</button>
                        <button class="icon-button" aria-label="Mover izquierda" @click=${() => this._nudgePolygon(-1, 0)}>←</button>
                        <button class="icon-button" aria-label="Mover abajo" @click=${() => this._nudgePolygon(0, -1)}>↓</button>
                        <button class="icon-button" aria-label="Mover derecha" @click=${() => this._nudgePolygon(1, 0)}>→</button>
                    </div>
                    <p class="editor-help">Arrastrá el polígono para moverlo o un vértice para cambiar su forma. Las flechas del teclado mueven el elemento enfocado.</p>
                    ${draft.operation === "update" && !draft.deleted ? html`
                        <button class="text-button delete-button" @click=${this._deleteDraft}>Eliminar zona…</button>
                    ` : nothing}
                ` : html`<p>La zona se eliminará cuando guardes este cambio.</p>`}
                ${validation ? html`<p class="validation" role="status">${validation}</p>` : nothing}
                ${!validCatalog ? html`<p class="validation">Recargá un catálogo fresco antes de guardar.</p>` : nothing}
                <div class="draft-buttons">
                    <button class="button primary" @click=${this._saveDraft} ?disabled=${!!this._pendingAction || !validCatalog || !draft.isDirty || !!validation || this._uncertainDraft}>
                        ${this._pendingAction === "guardado" ? "Guardando…" : "Guardar"}
                    </button>
                    <button class="button" @click=${this._discardDraft} ?disabled=${!!this._pendingAction}>Descartar</button>
                    <button class="button" @click=${this._undoDraft} ?disabled=${!draft.canUndo || !!this._pendingAction}>Deshacer</button>
                </div>
            </div>
        `;
    }

    private _viewBounds(): WorldBounds {
        const base = this._homeBounds ?? computeSceneBounds(
            this._snapshot?.catalog.areas ?? [],
            this._snapshot?.pose ?? null,
            this._canvasExpansion,
        );
        const centerX = (base.minX + base.maxX) / 2 + this._panX;
        const centerY = (base.minY + base.maxY) / 2 + this._panY;
        const halfWidth = (base.maxX - base.minX) / (2 * this._zoom);
        const halfHeight = (base.maxY - base.minY) / (2 * this._zoom);
        return {
            minX: centerX - halfWidth,
            maxX: centerX + halfWidth,
            minY: centerY - halfHeight,
            maxY: centerY + halfHeight,
        };
    }

    private _fitMap = (): void => {
        this._homeBounds = computeSceneBounds(
            this._snapshot?.catalog.areas ?? [],
            this._snapshot?.pose ?? null,
            this._canvasExpansion,
        );
        this._zoom = 1;
        this._panX = 0;
        this._panY = 0;
        this._initialFitDone = true;
        this.requestUpdate();
    };

    private _expandDrawingSpace = (): void => {
        this._canvasExpansion = Math.min(this._canvasExpansion * 1.5, 8);
        this._fitMap();
        this._setMessage("Se amplió el área de dibujo. No implica que esa zona sea espacio navegable.", "info");
    };

    private _changeZoom(factor: number): void {
        this._zoom = Math.max(0.5, Math.min(8, this._zoom * factor));
    }

    private _screenToWorld(x: number, y: number): Point {
        const svgMap = this.renderRoot.querySelector("svg.map");
        const view = this._viewBounds();
        if (!svgMap) return [(view.minX + view.maxX) / 2, (view.minY + view.maxY) / 2];
        const rect = svgMap.getBoundingClientRect();
        const width = view.maxX - view.minX;
        const height = view.maxY - view.minY;
        const scale = Math.min(rect.width / width, rect.height / height);
        if (!Number.isFinite(scale) || scale <= 0) return [(view.minX + view.maxX) / 2, (view.minY + view.maxY) / 2];
        const renderedWidth = width * scale;
        const renderedHeight = height * scale;
        const left = rect.left + (rect.width - renderedWidth) / 2;
        const top = rect.top + (rect.height - renderedHeight) / 2;
        return [
            view.minX + (x - left) / scale,
            view.maxY - (y - top) / scale,
        ];
    }

    private _mapPointerDown = (event: PointerEvent): void => {
        if (event.button !== 0 && event.pointerType !== "touch") return;
        const target = event.target instanceof Element ? event.target : null;
        const vertex = target?.closest("[data-vertex-index]") as SVGElement | null;
        const areaTarget = target?.closest("[data-area-id]") as SVGElement | null;
        const areaId = areaTarget ? Number(areaTarget.dataset.areaId) : null;
        const draft = this._draft;
        const point = this._screenToWorld(event.clientX, event.clientY);
        const canEdit = this._editMode && draft && !draft.deleted && draft.area;
        if (areaTarget && !canEdit) return;
        if (canEdit && vertex && (draft.operation === "create" || draft.area?.id === areaId)) {
            const index = Number(vertex.dataset.vertexIndex);
            this._activeVertex = index;
            this._vertexGesture = {
                pointerId: event.pointerId,
                index,
                last: point,
                before: draft.beginGesture(),
                moved: false,
            };
            this.requestUpdate();
        } else if (canEdit && areaTarget && (draft.operation === "create" || draft.area?.id === areaId)) {
            this._vertexGesture = {
                pointerId: event.pointerId,
                last: point,
                before: draft.beginGesture(),
                moved: false,
            };
        }
        this._mapPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (this._mapPointers.size === 1) this._panLast = { x: event.clientX, y: event.clientY };
        if (this._mapPointers.size === 2 && !this._vertexGesture) this._beginPinch();
        try {
            (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
        } catch {
            // Some synthetic browser events cannot capture a pointer.
        }
        event.preventDefault();
    };

    private _mapPointerMove = (event: PointerEvent): void => {
        if (!this._mapPointers.has(event.pointerId)) return;
        this._mapPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const gesture = this._vertexGesture;
        if (gesture && gesture.pointerId === event.pointerId && this._draft) {
            const point = this._screenToWorld(event.clientX, event.clientY);
            const dx = point[0] - gesture.last[0];
            const dy = point[1] - gesture.last[1];
            if (Math.abs(dx) + Math.abs(dy) > 0) {
                if (gesture.index === undefined) this._draft.movePolygon(dx, dy);
                else this._draft.moveVertex(gesture.index, point);
                gesture.last = point;
                gesture.moved = true;
                this.requestUpdate();
            }
            return;
        }
        if (this._mapPointers.size >= 2 && this._pinchStart) {
            this._updatePinch();
            return;
        }
        if (this._mapPointers.size === 1 && this._panLast) {
            const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
            const view = this._viewBounds();
            const scale = Math.min(
                rect.width / Math.max(1, view.maxX - view.minX),
                rect.height / Math.max(1, view.maxY - view.minY),
            );
            if (scale > 0 && Number.isFinite(scale)) {
                const dx = event.clientX - this._panLast.x;
                const dy = event.clientY - this._panLast.y;
                this._panX -= dx / scale;
                this._panY += dy / scale;
                this._panLast = { x: event.clientX, y: event.clientY };
                if (Math.abs(dx) + Math.abs(dy) > 3) this._suppressClickUntil = Date.now() + 250;
            }
        }
    };

    private _mapPointerUp = (event: PointerEvent): void => {
        if (this._vertexGesture?.pointerId === event.pointerId) {
            const gesture = this._vertexGesture;
            this._vertexGesture = undefined;
            if (this._draft) this._draft.finishGesture(gesture.before);
            if (gesture.moved) this._suppressClickUntil = Date.now() + 250;
            this.requestUpdate();
        }
        this._mapPointers.delete(event.pointerId);
        this._pinchStart = undefined;
        if (this._mapPointers.size === 1) {
            const remaining = Array.from(this._mapPointers.values())[0];
            this._panLast = { ...remaining };
        } else {
            this._panLast = undefined;
        }
        try {
            (event.currentTarget as SVGSVGElement).releasePointerCapture(event.pointerId);
        } catch {
            // Pointer capture can already have been released by the browser.
        }
    };

    private _beginPinch(): void {
        const points = Array.from(this._mapPointers.values());
        if (points.length !== 2) return;
        const midpoint = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
        this._pinchStart = {
            distance: Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y),
            zoom: this._zoom,
            anchor: this._screenToWorld(midpoint.x, midpoint.y),
        };
    }

    private _updatePinch(): void {
        if (!this._pinchStart) return;
        const points = Array.from(this._mapPointers.values());
        if (points.length < 2) return;
        const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
        const zoom = Math.max(0.5, Math.min(8, this._pinchStart.zoom * distance / Math.max(1, this._pinchStart.distance)));
        this._zoom = zoom;
        const midpoint = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
        const after = this._screenToWorld(midpoint.x, midpoint.y);
        this._panX += this._pinchStart.anchor[0] - after[0];
        this._panY += this._pinchStart.anchor[1] - after[1];
        this._suppressClickUntil = Date.now() + 250;
    }

    private _mapWheel = (event: WheelEvent): void => {
        event.preventDefault();
        const anchor = this._screenToWorld(event.clientX, event.clientY);
        this._zoom = Math.max(0.5, Math.min(8, this._zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));
        const after = this._screenToWorld(event.clientX, event.clientY);
        this._panX += anchor[0] - after[0];
        this._panY += anchor[1] - after[1];
    };

    private _areaActivated(event: MouseEvent, area: ZoneArea): void {
        event.stopPropagation();
        if (Date.now() < this._suppressClickUntil) return;
        this._zoneRowActivated(area, this._snapshot?.catalog.areas ?? []);
    }

    private _areaKeyDown(event: KeyboardEvent, area: ZoneArea): void {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            this._zoneRowActivated(area, this._snapshot?.catalog.areas ?? []);
            return;
        }
        if (!this._editMode || this._draft?.area?.id !== area.id || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        this._nudgePolygon(
            event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0,
            event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0,
            event.shiftKey ? 50 : 10,
        );
    }

    private _vertexKeyDown(event: KeyboardEvent, index: number): void {
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

    private _zoneRowActivated(area: ZoneArea, catalogAreas: ZoneArea[]): void {
        if (this._editMode) {
            if (this._draft) return;
            if (!isPositiveId(area) || !["normal", "depth", "forbid"].includes(String(area.active)) || !validVertices(area.vertexs)) {
                this._setMessage("Esta zona tiene un ID, tipo o geometría que el editor no puede modificar.", "error");
                return;
            }
            try {
                const mapId = this._snapshot?.catalog.map_id;
                const revision = this._snapshot?.catalog.revision;
                if (mapId === null || mapId === undefined || !revision) throw new Error("Recargá el catálogo para obtener su revisión actual.");
                this._draft = ZoneDraft.update(mapId, revision, area);
                this._activeVertex = null;
                this._setMessage(`Editando ${zoneName(area)}. Los cambios todavía no se enviaron.`, "info");
            } catch (error) {
                this._setMessage(errorMessage(error), "error");
            }
            return;
        }
        if (this._selectionNeedsReview) {
            this._setMessage("Vacía la selección anterior y vuelve a elegir las zonas después del cambio de catálogo.", "error");
            return;
        }
        if (area.active === "forbid") {
            this._setMessage(`${zoneName(area)} es una zona prohibida y no se puede seleccionar para limpiar.`, "error");
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

    private _isCleanable(area: ZoneArea, areas: ZoneArea[]): boolean {
        if (!isPositiveId(area) || (area.active !== "normal" && area.active !== "depth")) return false;
        return areas.filter(candidate => candidate.id === area.id).length === 1;
    }

    private _selectionIsValid(): boolean {
        const areas = this._snapshot?.catalog.areas ?? [];
        return this._selectedIds.length > 0 && this._selectedIds.every(id => {
            const matches = areas.filter(area => area.id === id);
            return matches.length === 1 && this._isCleanable(matches[0], areas);
        });
    }

    private _clearSelection = (): void => {
        this._selectedIds = [];
        this._selectionNeedsReview = false;
    };

    private _cleanSelected = async (): Promise<void> => {
        const hass = this.hass;
        const entityId = this._config?.entity;
        if (!hass || !entityId || !this._snapshot || this._editMode || this._draft || this._selectionNeedsReview || !this._selectionIsValid()) return;
        const selectedIds = [...this._selectedIds];
        await this._performAction("limpieza de zonas", async () => {
            await callCleanAreas(hass, entityId, selectedIds);
        });
    };

    private _vacuumAction = (
        service: "start" | "pause" | "stop" | "return_to_base" | "clean_spot",
        label: string,
    ): void => {
        const hass = this.hass;
        const entityId = this._config?.entity;
        if (!hass || !entityId) return;
        void this._performAction(label, () => callVacuumAction(hass, entityId, service));
    };

    private _powerChanged = (event: Event): void => {
        const hass = this.hass;
        const entityId = this._config?.entity;
        if (!hass || !entityId) return;
        const level = (event.currentTarget as HTMLSelectElement).value;
        if (!["quiet", "auto", "strong"].includes(level)) return;
        void this._performAction("intensidad", () => callVacuumAction(
            hass,
            entityId,
            "set_fan_speed",
            { fan_speed: level },
        ));
    };

    private async _performAction(label: string, action: () => Promise<void>): Promise<void> {
        if (this._pendingAction || this._uncertainAction || !this._snapshot?.available) return;
        this._pendingAction = label;
        this._message = "";
        try {
            await action();
            this._setMessage(`Home Assistant aceptó la solicitud de ${label}. El estado observado se actualizará por separado.`, "success");
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
        }
    }

    private _toggleEditMode = async (): Promise<void> => {
        if (this._editMode) {
            if (this._draft?.isDirty) {
                this._setMessage("Guardá o descartá el borrador antes de salir del modo de edición.", "error");
                return;
            }
            this._editMode = false;
            this._draft = null;
            this._activeVertex = null;
            return;
        }
        this._editMode = true;
        await this._loadFreshCatalog(false);
    };

    private _createZone = (): void => {
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
        this._setMessage("Se creó un borrador rectangular. Ajustá el nombre, tipo y vértices antes de guardar.", "info");
    };

    private _draftTagChanged = (event: Event): void => {
        this._draft?.updateProperties({ tag: (event.currentTarget as HTMLInputElement).value });
        this.requestUpdate();
    };

    private _draftTypeChanged = (event: Event): void => {
        const active = (event.currentTarget as HTMLSelectElement).value;
        if (active === "normal" || active === "depth" || active === "forbid") {
            this._draft?.updateProperties({ active });
            this.requestUpdate();
        }
    };

    private _addVertex = (): void => {
        this._draft?.addVertex();
        this.requestUpdate();
    };

    private _removeSelectedVertex = (): void => {
        if (this._activeVertex === null) return;
        this._draft?.removeVertex(this._activeVertex);
        this._activeVertex = null;
        this.requestUpdate();
    };

    private _nudgePolygon(dx: number, dy: number, distance = 10): void {
        if (!this._draft?.area) return;
        const before = this._draft.beginGesture();
        this._draft.movePolygon(dx * distance, dy * distance);
        this._draft.finishGesture(before);
        this.requestUpdate();
    }

    private _deleteDraft = (): void => {
        const name = this._draft?.area?.tag || "esta zona";
        if (!this._draft || !window.confirm(`Marcar “${name}” para eliminar al guardar?`)) return;
        this._draft.delete();
        this._activeVertex = null;
        this.requestUpdate();
    };

    private _undoDraft = (): void => {
        if (this._draft?.undo()) this.requestUpdate();
    };

    private _discardDraft = (): void => {
        if (this._draft?.isDirty && !window.confirm("Descartar todos los cambios de este borrador?")) return;
        this._draft = null;
        this._draftConflict = null;
        this._uncertainDraft = false;
        this._catalogReloadedAfterUncertain = false;
        this._activeVertex = null;
        this._setMessage("Borrador descartado. Las zonas guardadas no cambiaron.", "info");
    };

    private _discardAndLoadConflict = (): void => {
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

    private _saveDraft = async (): Promise<void> => {
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
                this._setMessage("La integración aceptó el guardado, pero no devolvió el catálogo confirmado. Recargá antes de reintentar.", "error");
                return;
            }
            this._snapshot = {
                ...snapshot,
                catalog: {
                    ...snapshot.catalog,
                    map_id: result.map_id,
                    revision: result.revision,
                    areas: result.areas,
                    observed_at: "observed_at" in result && typeof result.observed_at === "string" ? result.observed_at : new Date().toISOString(),
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
            this._setMessage("Cambios guardados y verificados contra el catálogo del robot.", "success");
            this._fitMap();
        } catch (error) {
            this._uncertainDraft = true;
            this._setMessage(`Se perdió la respuesta del guardado (${errorMessage(error)}). El resultado es incierto; recargá el catálogo.`, "error");
        } finally {
            this._savingDraft = false;
            this._pendingAction = "";
            const pending = this._pendingSnapshot;
            this._pendingSnapshot = undefined;
            if (pending) this._applySnapshot(pending);
        }
    };

    private _reloadDraftCatalog = async (): Promise<void> => {
        await this._loadFreshCatalog(true);
        if (this._snapshot?.catalog.fresh && this._snapshot.catalog.available) {
            this._catalogReloadedAfterUncertain = true;
            this._setMessage("Catálogo recargado. Compará las zonas y elegí si corresponde habilitar otro intento.", "info");
        }
    };

    private _allowExplicitRetry = (): void => {
        if (!this._uncertainDraft || !this._catalogReloadedAfterUncertain) return;
        this._uncertainDraft = false;
        this._catalogReloadedAfterUncertain = false;
        this._setMessage("El reintento quedó habilitado por decisión explícita después de releer el catálogo.", "warning");
    };

    private _loadFreshCatalog = async (forUncertain: boolean): Promise<void> => {
        if (!this.hass || !this._config || this._pendingAction) return;
        this._pendingAction = "recarga";
        try {
            const result = await getAreaCatalog(this.hass, this._config.entity);
            if (!result.ok || !Array.isArray(result.areas) || !result.revision) {
                this._setMessage(result.error === "unavailable" ? "La aspiradora no está disponible." : "No se pudo leer el catálogo de zonas.", "error");
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
            if (this._draft?.isDirty && (
                catalog.revision !== this._draft.baseRevision || catalog.map_id !== this._draft.baseMapId
            )) {
                this._draftConflict = {
                    map_id: catalog.map_id,
                    revision: catalog.revision,
                    areas: catalog.areas,
                    observed_at: catalog.observed_at,
                };
            } else if (this._snapshot) {
                const selectionNeedsReview = this._selectedIds.length > 0 && (
                    catalog.revision !== this._snapshot.catalog.revision ||
                    catalog.map_id !== this._snapshot.catalog.map_id
                );
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
        }
    };

    private _refreshData = async (): Promise<void> => {
        if (!this.hass || !this._config || this._pendingAction) return;
        this._pendingAction = "recarga";
        try {
            const result = await refreshCard(this.hass, this._config.entity);
            if (!result.ok) {
                this._setMessage(result.error === "not_found" ? "La entidad ya no está disponible." : "No se pudieron recargar el estado y el catálogo.", "error");
                return;
            }
            this._receiveSnapshot(result);
            if (this._uncertainAction) {
                this._uncertainAction = false;
                this._setMessage("Estado y catálogo releídos. Revisá la actividad observada antes de iniciar otra operación.", "info");
            } else {
                this._setMessage("Estado y catálogo recargados.", "success");
            }
            if (this._uncertainDraft) this._catalogReloadedAfterUncertain = true;
        } catch (error) {
            this._setMessage(`No se pudo recargar: ${errorMessage(error)}`, "error");
        } finally {
            this._pendingAction = "";
        }
    };

    private _setMessage(message: string, kind: "info" | "error" | "success" | "warning"): void {
        this._message = message;
        this._messageKind = kind === "warning" ? "info" : kind;
    }

    static styles = css`
        :host {
            display: block;
            color: var(--primary-text-color);
            --zk-card-border: var(--divider-color, rgba(127, 127, 127, 0.25));
            --zk-map-bg: color-mix(in srgb, var(--primary-background-color, #f6f7fb) 88%, var(--primary-color, #5672d8) 12%);
            --zk-zone-normal: var(--primary-color, #526dcc);
            --zk-zone-depth: var(--teal-color, #008c83);
            --zk-zone-forbid: var(--error-color, #c23a45);
        }
        ha-card.card {
            overflow: hidden;
            padding: 18px;
            border-radius: 18px;
        }
        .header,
        .section-heading,
        .daily-controls,
        .map-tools,
        .map-meta,
        .draft-title,
        .geometry-tools,
        .draft-buttons,
        .selection-actions,
        .footer {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
        }
        .header {
            padding: 2px 2px 15px;
            border-bottom: 1px solid var(--zk-card-border);
        }
        h2,
        h3,
        p {
            margin: 0;
        }
        h2 {
            font-size: 1.22rem;
            letter-spacing: -0.015em;
        }
        h3 {
            font-size: 0.98rem;
            letter-spacing: -0.01em;
        }
        .state-line,
        .battery {
            display: flex;
            align-items: center;
            gap: 7px;
            color: var(--secondary-text-color);
            font-size: 0.85rem;
        }
        .state-line { margin-top: 6px; flex-wrap: wrap; }
        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--error-color, #c23a45);
        }
        .status-dot.online { background: var(--success-color, #16845b); }
        .battery {
            min-height: 42px;
            padding: 0 12px;
            border: 1px solid var(--zk-card-border);
            border-radius: 12px;
            font-size: 1rem;
        }
        .battery strong { color: var(--primary-text-color); }
        .version { color: var(--secondary-text-color); font-size: 0.72rem; }
        .error-state { color: var(--error-color, #b3261e); font-weight: 600; }
        .notice {
            margin: 12px 0 0;
            padding: 10px 12px;
            border: 1px solid var(--zk-card-border);
            border-radius: 11px;
            background: var(--secondary-background-color, rgba(127,127,127,.08));
            font-size: 0.88rem;
            line-height: 1.45;
        }
        .notice.error { color: var(--error-color, #a31f2d); border-color: color-mix(in srgb, var(--error-color, #c23a45) 35%, transparent); }
        .notice.success { color: var(--success-color, #08774d); }
        .notice.warning { background: color-mix(in srgb, var(--warning-color, #e5a326) 12%, var(--card-background-color, white)); }
        .notice.compact { margin: 7px 0; padding: 8px 10px; font-size: .82rem; }
        .daily-controls {
            justify-content: flex-start;
            flex-wrap: wrap;
            padding: 14px 0 16px;
        }
        button,
        select,
        input {
            font: inherit;
        }
        .button,
        .icon-button,
        .text-button {
            color: var(--primary-text-color);
            cursor: pointer;
        }
        .button {
            min-height: 40px;
            padding: 8px 13px;
            border: 1px solid var(--zk-card-border);
            border-radius: 11px;
            background: var(--card-background-color, var(--ha-card-background, white));
            font-weight: 600;
            transition: transform 100ms ease, background 120ms ease, border-color 120ms ease;
        }
        .button:hover:not(:disabled) { border-color: var(--primary-color); background: var(--secondary-background-color); }
        .button:active:not(:disabled) { transform: scale(.98); }
        .button.primary {
            color: var(--text-primary-color, white);
            background: var(--primary-color, #5066ba);
            border-color: var(--primary-color, #5066ba);
        }
        .button.primary:hover:not(:disabled) { filter: brightness(1.07); }
        .button.localized { border-color: color-mix(in srgb, var(--primary-color, #526dcc) 50%, var(--zk-card-border)); }
        .button.small { min-height: 34px; padding: 6px 10px; font-size: .82rem; }
        button:disabled,
        select:disabled { opacity: .5; cursor: not-allowed; }
        .power-control {
            display: flex;
            align-items: center;
            gap: 8px;
            min-height: 40px;
            padding: 0 10px;
            color: var(--secondary-text-color);
            border: 1px solid var(--zk-card-border);
            border-radius: 11px;
            font-size: .82rem;
        }
        .power-control select,
        .field-label select,
        .field-label input {
            min-height: 36px;
            padding: 6px 9px;
            color: var(--primary-text-color);
            background: var(--card-background-color, var(--ha-card-background, white));
            border: 1px solid var(--zk-card-border);
            border-radius: 8px;
        }
        .workspace {
            display: grid;
            grid-template-columns: minmax(0, 1.65fr) minmax(270px, .85fr);
            align-items: start;
            gap: 15px;
        }
        .map-column,
        .zones-panel {
            min-width: 0;
            padding: 13px;
            border: 1px solid var(--zk-card-border);
            border-radius: 15px;
            background: color-mix(in srgb, var(--card-background-color, white) 95%, var(--primary-background-color, #f5f6fa));
        }
        .section-heading { min-height: 36px; margin-bottom: 10px; }
        .section-heading p { margin-top: 3px; color: var(--secondary-text-color); font-size: .78rem; }
        .map-tools { gap: 6px; }
        .icon-button {
            min-width: 34px;
            min-height: 34px;
            padding: 3px 8px;
            border: 1px solid var(--zk-card-border);
            border-radius: 9px;
            background: var(--card-background-color, white);
            font-size: 1rem;
            font-weight: 700;
        }
        .fit-button { font-size: .76rem; }
        .map-stage {
            position: relative;
            overflow: hidden;
            height: clamp(285px, 40vw, 540px);
            border: 1px solid var(--zk-card-border);
            border-radius: 13px;
            background: var(--zk-map-bg);
        }
        svg.map {
            display: block;
            width: 100%;
            height: 100%;
            touch-action: none;
            cursor: grab;
            user-select: none;
        }
        svg.map:active { cursor: grabbing; }
        .map-background { fill: var(--zk-map-bg); }
        .grid-line { fill: none; stroke: var(--primary-text-color); stroke-opacity: .07; stroke-width: 3; }
        .zone-group { cursor: pointer; outline: none; }
        .zone-shape {
            vector-effect: non-scaling-stroke;
            stroke-width: 2.5;
            transition: fill-opacity 120ms ease, stroke-width 120ms ease;
        }
        .zone-shape.normal { fill: var(--zk-zone-normal); fill-opacity: .23; stroke: var(--zk-zone-normal); }
        .zone-shape.depth { fill: var(--zk-zone-depth); fill-opacity: .25; stroke: var(--zk-zone-depth); stroke-dasharray: 7 4; }
        .zone-shape.forbid { fill: var(--zk-zone-forbid); fill-opacity: .16; stroke: var(--zk-zone-forbid); stroke-dasharray: 3 4; }
        .zone-shape.unsupported { fill: var(--secondary-text-color); fill-opacity: .18; stroke: var(--secondary-text-color); stroke-dasharray: 2 6; }
        .zone-group:hover .zone-shape,
        .zone-group:focus-visible .zone-shape,
        .zone-group.selected .zone-shape { fill-opacity: .4; stroke-width: 4; }
        .zone-group.editing .zone-shape { stroke-width: 4; stroke-dasharray: 8 4; }
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
        .zone-label { font-size: 29px; font-weight: 700; }
        .zone-type-label { font-size: 21px; fill: var(--secondary-text-color); }
        .empty-map-label { font-size: 25px; fill: var(--secondary-text-color); }
        .vertex-handle {
            vector-effect: non-scaling-stroke;
            fill: var(--card-background-color, white);
            stroke: var(--primary-color, #526dcc);
            stroke-width: 3;
            cursor: move;
            touch-action: none;
        }
        .vertex-handle.active,
        .vertex-handle:focus-visible { fill: var(--primary-color, #526dcc); stroke: var(--card-background-color, white); stroke-width: 4; }
        .robot-shadow { fill: var(--card-background-color, white); stroke: var(--primary-color, #526dcc); stroke-width: 4; vector-effect: non-scaling-stroke; }
        .robot-body { fill: var(--primary-color, #526dcc); stroke: var(--card-background-color, white); stroke-width: 2; vector-effect: non-scaling-stroke; }
        .robot-center { fill: var(--card-background-color, white); }
        .robot { pointer-events: none; }
        .robot.stale { opacity: .56; }
        .pose-stale svg.map { filter: saturate(.65); }
        .map-overlay {
            position: absolute;
            inset: auto 9px 9px;
            padding: 7px 10px;
            color: var(--primary-text-color);
            background: color-mix(in srgb, var(--card-background-color, white) 90%, transparent);
            border: 1px solid var(--zk-card-border);
            border-radius: 9px;
            font-size: .78rem;
        }
        .map-meta { justify-content: flex-start; flex-wrap: wrap; margin-top: 9px; color: var(--secondary-text-color); font-size: .74rem; }
        .empty-map { display: flex; justify-content: space-between; gap: 10px; margin-top: 9px; color: var(--secondary-text-color); font-size: .82rem; }
        .empty-list { padding: 14px 3px; color: var(--secondary-text-color); font-size: .85rem; }
        .zone-list { display: grid; gap: 5px; max-height: 320px; overflow: auto; margin: 0; padding: 0; list-style: none; }
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
        .zone-row.selected { border-color: var(--primary-color); background: color-mix(in srgb, var(--primary-color, #526dcc) 9%, var(--card-background-color, white)); }
        .zone-row.forbidden { border-left: 3px dashed var(--zk-zone-forbid); }
        .zone-row:disabled { opacity: .62; cursor: not-allowed; }
        .zone-row-mark { display: grid; place-items: center; width: 29px; height: 29px; border-radius: 8px; color: var(--primary-color); background: var(--secondary-background-color); font-size: .8rem; font-weight: 700; }
        .zone-row.forbidden .zone-row-mark { color: var(--zk-zone-forbid); }
        .zone-row-text { min-width: 0; }
        .zone-row-text strong,
        .zone-row-text small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .zone-row-text strong { font-size: .84rem; }
        .zone-row-text small { margin-top: 3px; color: var(--secondary-text-color); font-size: .7rem; }
        .zone-row-action { color: var(--primary-color); font-size: .78rem; font-weight: 700; }
        .selection-actions { margin-top: 9px; }
        .selection-actions .button { flex: 1; }
        .text-button {
            min-height: 35px;
            padding: 4px 7px;
            color: var(--primary-color);
            background: transparent;
            border: 0;
            border-radius: 8px;
            font-size: .78rem;
            font-weight: 600;
            text-align: left;
        }
        .text-button:hover:not(:disabled) { background: var(--secondary-background-color); }
        .edit-controls { margin-top: 16px; padding-top: 13px; border-top: 1px solid var(--zk-card-border); }
        .draft-panel { display: grid; gap: 9px; }
        .draft-panel > p,
        .draft-conflict-summary,
        .draft-panel small,
        .editor-help { color: var(--secondary-text-color); font-size: .78rem; line-height: 1.4; }
        .conflict-catalog { max-height: 150px; overflow: auto; padding: 9px 10px; border: 1px solid var(--zk-card-border); border-radius: 9px; font-size: .82rem; }
        .conflict-catalog ul { margin: 6px 0 0; padding-left: 20px; }
        .conflict-catalog li { padding: 2px 0; }
        .conflict-catalog p { margin: 6px 0 0; }
        .draft-title span { color: var(--secondary-text-color); font-size: .75rem; }
        .field-label { display: grid; gap: 5px; font-size: .76rem; font-weight: 600; }
        .field-label input,
        .field-label select { width: 100%; font-weight: 400; }
        .geometry-tools { padding-top: 2px; color: var(--secondary-text-color); font-size: .75rem; }
        .nudge-tools { display: flex; justify-content: center; gap: 6px; }
        .editor-help { margin: 0; }
        .delete-button { color: var(--error-color, #b3261e); }
        .validation { color: var(--error-color, #b3261e) !important; font-size: .78rem; }
        .draft-buttons { justify-content: flex-start; flex-wrap: wrap; }
        .draft-buttons .button { flex: 1; min-width: 82px; }
        .footer { margin-top: 12px; padding: 10px 2px 0; border-top: 1px solid var(--zk-card-border); color: var(--secondary-text-color); font-size: .68rem; }
        .loading,
        .setup { padding: 18px; color: var(--secondary-text-color); }
        .incompatible { display: grid; gap: 10px; }
        :focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
        @media (max-width: 720px) {
            ha-card.card { padding: 13px; border-radius: 15px; }
            .workspace { grid-template-columns: minmax(0, 1fr); gap: 10px; }
            .map-stage { height: min(90vw, 420px); min-height: 290px; }
            .daily-controls { gap: 7px; }
            .daily-controls > .button { flex: 1 1 calc(50% - 7px); padding-inline: 8px; font-size: .8rem; }
            .power-control { flex: 1 1 100%; justify-content: space-between; }
            .power-control select { min-width: 130px; }
            .map-column, .zones-panel { padding: 10px; }
            .footer { align-items: flex-start; flex-direction: column; gap: 4px; }
        }
        @media (max-width: 390px) {
            .header { align-items: flex-start; }
            h2 { font-size: 1.04rem; }
            .battery { padding: 0 8px; }
            .section-heading { align-items: flex-start; }
            .fit-button { display: none; }
            .map-stage { min-height: 275px; }
            .selection-actions { align-items: stretch; flex-direction: column; }
            .selection-actions .button { width: 100%; }
            .empty-map { align-items: flex-start; flex-direction: column; }
        }
        @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after { transition-duration: 0.01ms !important; scroll-behavior: auto !important; }
        }
    `;
}

const cardsWindow = window as unknown as Window & { customCards?: Array<Record<string, unknown>> };
cardsWindow.customCards = cardsWindow.customCards ?? [];
if (!cardsWindow.customCards.some(item => item.type === CARD_CUSTOM_ELEMENT_NAME)) {
    cardsWindow.customCards.push({
        type: CARD_CUSTOM_ELEMENT_NAME,
        name: "Liectroux ZK901 Map Card",
        description: "Mapa vectorial de zonas, controles y edición de Liectroux ZK901.",
        preview: true,
        getEntitySuggestion: (hass: HomeAssistantFixed, entityId: string) => {
            const entity = hass.entities?.[entityId];
            if (entity?.platform !== INTEGRATION_DOMAIN || !entityId.startsWith("vacuum.")) return null;
            return { config: { type: CARD_CUSTOM_ELEMENT_NAME, entity: entityId } };
        },
    });
}

/* eslint-disable no-console */
console.info(`Liectroux ZK901 Map Card ${CARD_VERSION}`);
