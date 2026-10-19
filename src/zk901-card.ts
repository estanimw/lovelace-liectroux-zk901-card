/* eslint-disable @typescript-eslint/no-unused-vars */
import { css, html, nothing, svg, type PropertyValues, type TemplateResult, type CSSResultGroup } from "lit";
import { customElement } from "lit/decorators";
import "./editor";
import { CommunityMapCard } from "./community/xiaomi-vacuum-map-card";
import { actionHandler } from "./community/action-handler-directive";
import { ToastRenderer } from "./community/renderers/toast-renderer";
import { Room } from "./community/model/map_objects/room";
import type { Context } from "./community/model/map_objects/context";
import type {
    ActionableObjectConfig,
    CardPresetConfig,
    IconActionConfig,
    RoomConfig,
    TileConfig,
    XiaomiVacuumMapCardConfig,
} from "./community/types/types";
import {
    ZK901Controller,
    zoneName,
    zoneType,
    statusName,
    timestampLabel,
    errorText,
    type CardConfig,
} from "./zk901-controller";
import { MapSurface } from "./model/map-surface";
import { polygonCenter, validVertices, type Point } from "./model/zone-geometry";
import type { HomeAssistantFixed } from "./types/fixes";
import { CARD_CUSTOM_ELEMENT_NAME, CARD_VERSION, INTEGRATION_DOMAIN } from "./const";

class PersistedRoom extends Room {
    constructor(config: RoomConfig, context: Context, readonly activate: () => void, selected: boolean) {
        super(config, context);
        this._selected = selected;
    }
    protected async _click(): Promise<void> {
        this.activate();
    }
    public render() {
        return svg`<g data-area-id=${this._config.id} class=${`zk-persisted-room ${
            this._config.variables?.kind ?? "normal"
        }`}>${super.render()}</g>`;
    }
}

@customElement(CARD_CUSTOM_ELEMENT_NAME)
export class LiectrouxZK901MapCard extends CommunityMapCard {
    readonly controller = new ZK901Controller(
        () => this.requestUpdate(),
        (x, y) => this._worldAt(x, y),
        () => this._fitSurface(),
    );
    private _zkConfig?: CardConfig;
    private _surface?: MapSurface;
    private _imageUrl = "";
    private _imageSource = "";
    private _retiredUrls: string[] = [];
    public _panel: "zones" | "layers" | "info" | null = null;
    private _mapId: unknown;
    private _toastSequence = -1;
    private _themeObserver?: MutationObserver;
    private _frameResize?: ResizeObserver;

    public setConfig(config: CardConfig): void {
        if (this._zkConfig?.entity !== config.entity && this.controller._draft?.isDirty)
            throw new Error("Guardá o descartá el borrador antes de cambiar de entidad.");
        this.controller.setConfig(config);
        this._zkConfig = { ...config };
        this._surface = new MapSurface(this.controller._routeBounds());
        super.setConfig({
            type: config.type,
            entity: config.entity,
            title: config.title,
            language: "es",
            map_source: { image: "local-svg" },
            calibration_source: { calibration_points: this._surface.calibration },
            map_modes: [
                {
                    name: "Zonas",
                    icon: "mdi:floor-plan",
                    selection_type: "ROOM",
                    run_immediately: false,
                    service_call_schema: {
                        service: "liectroux_zk901.clean_areas",
                        service_data: { entity_id: "[[entity_id]]", area_ids: "[[selection]]" },
                    },
                },
            ],
            icons: [],
            tiles: [],
        } as XiaomiVacuumMapCardConfig);
    }
    static getStubConfig(hass: HomeAssistantFixed): XiaomiVacuumMapCardConfig | undefined {
        const entity = Object.values(hass.entities ?? {}).find(
            e => e.platform === INTEGRATION_DOMAIN && e.entity_id.startsWith("vacuum."),
        );
        return entity
            ? ({ type: `custom:${CARD_CUSTOM_ELEMENT_NAME}`, entity: entity.entity_id } as XiaomiVacuumMapCardConfig)
            : undefined;
    }
    connectedCallback(): void {
        super.connectedCallback();
        this.controller.connect();
        this._themeObserver = new MutationObserver(() => this.requestUpdate());
        this._themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["style", "class"],
        });
        this._themeObserver.observe(this, { attributes: true, attributeFilter: ["style", "class"] });
        this._frameResize = new ResizeObserver(() => {
            this._calculateBasicScale();
            this.requestUpdate();
        });
        this._frameResize.observe(this);
    }
    disconnectedCallback(): void {
        this.controller.disconnect();
        this._themeObserver?.disconnect();
        this._frameResize?.disconnect();
        this._releaseImages();
        super.disconnectedCallback();
    }
    protected shouldUpdate(): boolean {
        return this.isConnected && !!this._zkConfig;
    }
    protected updated(changed: PropertyValues): void {
        this.controller.hass = this.hass;
        this.controller._ensureSubscription();
        super.updated(changed);
        const c = this.controller;
        if (c.messageSequence !== this._toastSequence && c.notifyMessage && c._message && c._messageKind !== "error") {
            this._toastSequence = c.messageSequence;
            ToastRenderer.showToast(
                this.shadowRoot,
                value => value,
                "map-card",
                c._message,
                c._messageKind === "success" ? "mdi:check" : "mdi:alert",
                c._messageKind === "success",
                "",
                3000,
            );
        }
        const overlay = this._getSvgWrapper();
        if (overlay && !overlay.hasAttribute("data-editor-bound")) {
            overlay.setAttribute("data-editor-bound", "true");
            overlay.addEventListener("pointerdown", this.controller._mapPointerDown as EventListener);
            overlay.addEventListener("pointermove", this.controller._mapPointerMove as EventListener);
            overlay.addEventListener("pointerup", this.controller._mapPointerUp as EventListener);
            overlay.addEventListener("pointercancel", this.controller._mapPointerUp as EventListener);
        }
        const image = this._getMapImage();
        if (image)
            image.onload = () => {
                this._calculateBasicScale();
                this._retiredUrls.splice(0).forEach(url => URL.revokeObjectURL(url));
            };
    }
    protected _getIconsAndTiles(config: CardPresetConfig): Promise<[IconActionConfig[], TileConfig[]]> {
        return Promise.resolve([config.icons ?? [], config.tiles ?? []]);
    }
    protected _firstHass(): void {
        if (this._zkConfig) super._firstHass();
    }
    protected _getMapSrc(): string {
        return this._imageUrl;
    }
    protected _getCalibration() {
        return this._surface?.calibration;
    }
    protected _restoreMap(): void {
        this._fitSurface();
        super._restoreMap();
    }
    protected _setCurrentMode(index: number): void {
        super._setCurrentMode(index, false);
    }
    private _fitSurface(): void {
        if (!this.controller) return;
        this._surface = new MapSurface(this.controller._routeBounds());
        this.requestUpdate();
    }
    private _worldAt(x: number, y: number): Point {
        const image = this._getMapImage();
        if (!image || !this._surface) return [0, 0];
        const rect = image.getBoundingClientRect();
        return this._surface.toWorld([
            ((x - rect.left) / Math.max(1, rect.width)) * this._surface.width,
            ((y - rect.top) / Math.max(1, rect.height)) * this._surface.height,
        ]);
    }
    private _releaseImages(): void {
        if (this._imageUrl) URL.revokeObjectURL(this._imageUrl);
        this._retiredUrls.forEach(url => URL.revokeObjectURL(url));
        this._retiredUrls = [];
        this._imageUrl = "";
        this._imageSource = "";
    }
    private _syncMap(): void {
        const c = this.controller,
            snapshot = c._snapshot;
        if (!this._surface) this._fitSurface();
        if (snapshot && snapshot.catalog.map_id !== this._mapId && !c._draft) {
            this._mapId = snapshot.catalog.map_id;
            this._fitSurface();
        }
        if (!this._surface) return;
        const style = getComputedStyle(this);
        const color = (name: string, fallback: string): string => {
            const value = style.getPropertyValue(name).trim();
            return /^[#\w\s(),.%/-]+$/.test(value) && value ? value : fallback;
        };
        const source = this._surface.svg(snapshot, c._showRoute, c._showCoverage, c._routeSession, {
            background: color("--secondary-background-color", "#eaf0f2"),
            route: color("--primary-color", "#009688"),
            coverage: color("--primary-color", "#009688"),
            robot: color("--primary-color", "#009688"),
        });
        if (source !== this._imageSource) {
            if (this._imageUrl) this._retiredUrls.push(this._imageUrl);
            while (this._retiredUrls.length > 2) URL.revokeObjectURL(this._retiredUrls.shift() as string);
            this._imageSource = source;
            this._imageUrl = URL.createObjectURL(new Blob([source], { type: "image/svg+xml" }));
        }
        const variables = {
            state: statusName(snapshot),
            battery:
                snapshot?.status.battery === null || snapshot?.status.battery === undefined
                    ? "—"
                    : `${snapshot.status.battery}%`,
            fan: snapshot?.status.cleaning_level ?? "unknown",
        };
        if (JSON.stringify(this.internalVariables) !== JSON.stringify(variables)) this.internalVariables = variables;
        const fanLabels =
            snapshot?.status.cleaning_level_kind === "suction"
                ? ["Silenciosa", "Automática", "Fuerte"]
                : ["Baja", "Media", "Alta"];
        const icons: IconActionConfig[] = [
            {
                icon: snapshot?.status.mode === "pause" ? "mdi:play" : "mdi:play",
                icon_id: "start",
                tooltip: snapshot?.status.mode === "pause" ? "Continuar limpieza" : "Iniciar limpieza total",
            },
            { icon: "mdi:pause", icon_id: "pause", tooltip: "Pausar" },
            { icon: "mdi:stop", icon_id: "stop", tooltip: "Detener" },
            { icon: "mdi:home-map-marker", icon_id: "return_to_base", tooltip: "Volver a la base" },
            ...["quiet", "auto", "strong"].map((level, index) => ({
                icon: ["mdi:fan-speed-1", "mdi:fan-speed-2", "mdi:fan-speed-3"][index],
                icon_id: `fan_${level}`,
                menu_id: "intensity",
                label: fanLabels[index],
                tooltip: `Intensidad: ${fanLabels[index]}`,
                conditions: [{ internal_variable: "fan", value: level }],
            })),
            {
                icon: "mdi:fan",
                icon_id: "fan_unknown",
                menu_id: "intensity",
                label: "Sin lectura",
                tooltip: "Intensidad: sin lectura",
                disabled: true,
                conditions: [{ internal_variable: "fan", value: "unknown" }],
            },
            { icon: "mdi:target", icon_id: "clean_spot", tooltip: "Limpiar posición actual" },
            { icon: "mdi:floor-plan", icon_id: "zones", tooltip: "Zonas guardadas" },
            { icon: "mdi:pencil-outline", icon_id: "edit", tooltip: "Editar zonas" },
            { icon: "mdi:layers-outline", icon_id: "layers", tooltip: "Capas e historial" },
            { icon: "mdi:information-outline", icon_id: "info", tooltip: "Información" },
        ];
        const blocked = !snapshot?.available || !c._apiCompatible || !!c._pendingAction || c._uncertainAction;
        icons.forEach(icon => {
            (icon as { disabled?: boolean }).disabled =
                icon.disabled || (blocked && !["zones", "edit", "layers", "info"].includes(icon.icon_id ?? ""));
        });
        this.currentPreset = {
            ...this.currentPreset,
            icons,
            tiles: [
                { tile_id: "state", label: "Estado", icon: "mdi:robot-vacuum", internal_variable: "state" },
                { tile_id: "battery", label: "Batería", icon: "mdi:battery", internal_variable: "battery" },
            ],
        };
    }
    protected render(): TemplateResult | void {
        if (!this.hass || !this._zkConfig) return html`<ha-card>Cargando…</ha-card>`;
        this.controller.hass = this.hass;
        const title =
            this._zkConfig.title ??
            this.hass.states[this._zkConfig.entity]?.attributes.friendly_name ??
            "Liectroux ZK901";
        if (this.config.title !== title) this.config = { ...this.config, title };
        this._syncMap();
        return super.render();
    }
    protected _renderHeader(): unknown {
        const c = this.controller,
            s = c._snapshot;
        const error = errorText(s?.status.error);
        const scene = c._routeBounds();
        const bounds = this._surface?.bounds;
        const outside =
            bounds &&
            (scene.minX < bounds.minX - 1 ||
                scene.maxX > bounds.maxX + 1 ||
                scene.minY < bounds.minY - 1 ||
                scene.maxY > bounds.maxY + 1);
        const stale = s?.pose?.observed_at ? Date.now() - Date.parse(s.pose.observed_at) > 60000 : true;
        return html`
            ${c._loading ? html`<div class="zk-status" role="status">Conectando con la aspiradora…</div>` : nothing}
            ${!c._apiCompatible || (!c._loading && !s?.available)
                ? html`<div class="zk-notice" role="alert">
                      ${c._message || "Sin conexión con la aspiradora"}<button
                          @click=${() => this._do(() => c._refreshData())}>
                          Volver a comprobar
                      </button>
                  </div>`
                : nothing}
            ${error ? html`<div class="zk-notice" role="alert">Error ${error}</div>` : nothing}
            ${c._messageKind === "error" && c._apiCompatible
                ? html`<div class="zk-notice" role="alert">
                      ${c._message}${c._uncertainAction
                          ? html`<button @click=${() => this._do(() => c._refreshData())}>Recargar estado</button>`
                          : nothing}
                  </div>`
                : nothing}
            ${c._selectionNeedsReview
                ? html`<div class="zk-notice" role="alert">
                      El catálogo cambió. Revisá y vaciá la selección anterior antes de limpiar.<button
                          @click=${() => this._do(() => c._clearSelection())}>
                          Vaciar selección y volver a elegir
                      </button>
                  </div>`
                : nothing}
            ${s && !s.catalog.fresh
                ? html`<div class="zk-status">Recargá el catálogo para confirmar las zonas seleccionadas.</div>`
                : nothing}
            ${outside
                ? html`<div class="zk-status">
                      Hay datos fuera del encuadre. <button @click=${() => this._restoreMap()}>Ajustar mapa</button>
                  </div>`
                : nothing}
            ${stale && s
                ? html`<div class="zk-status" role="status">
                      Última posición conocida · ${timestampLabel(s.pose?.observed_at ?? null)}
                  </div>`
                : nothing}
        `;
    }
    protected async _run(): Promise<void> {
        await this.controller._cleanSelected();
    }
    protected _createMapControls(): TemplateResult[] {
        const c = this.controller;
        const blocked =
            !c._snapshot?.available ||
            !c._apiCompatible ||
            c._editMode ||
            !!c._pendingAction ||
            c._uncertainAction ||
            c._selectionNeedsReview ||
            !c._snapshot?.catalog.fresh ||
            !c._snapshot?.catalog.available ||
            !c._selectionIsValid();
        return [
            html`<paper-button
                    class="map-actions-item main clickable ripple"
                    role="button"
                    tabindex="0"
                    aria-label=${`Limpiar seleccionadas${c._selectedIds.length ? ` (${c._selectedIds.length})` : ""}`}
                    aria-disabled=${blocked ? "true" : "false"}
                    title="Limpiar seleccionadas"
                    @keydown=${(event: KeyboardEvent) => {
                        if (!blocked && (event.key === "Enter" || event.key === " ")) {
                            event.preventDefault();
                            void this._do(() => c._cleanSelected());
                        }
                    }}
                    @action=${() => {
                        if (!blocked) void this._do(() => c._cleanSelected());
                    }}
                    .actionHandler=${actionHandler({ hasHold: false, hasDoubleClick: false })}>
                    <ha-icon icon="mdi:play"></ha-icon
                    ><ha-icon
                        icon="mdi:floor-plan"
                        style="position:absolute;transform:scale(.5) translate(15px,-20px)"></ha-icon>
                    ${c._selectedIds.length
                        ? html`<span class="zk-selection-count">${c._selectedIds.length}</span>`
                        : nothing} </paper-button
                >${c._selectedIds.length
                    ? html`<button
                          class="zk-clear"
                          aria-label="Vaciar selección"
                          title="Vaciar selección"
                          @click=${() => this._do(() => c._clearSelection())}>
                          <ha-icon icon="mdi:selection-remove"></ha-icon>
                      </button>`
                    : nothing}`,
        ];
    }
    protected _drawSelection(): ReturnType<CommunityMapCard["_drawSelection"]> {
        const c = this.controller;
        const areas = c._snapshot?.catalog.areas ?? [];
        this.selectableRooms = areas
            .filter(a => validVertices(a.vertexs) && a.id !== c._draft?.area?.id)
            .map(area => {
                const center = polygonCenter(area.vertexs as Point[]);
                const room = new PersistedRoom(
                    {
                        id: area.id,
                        outline: area.vertexs as Point[],
                        variables: {
                            kind: area.id > 0 ? String(area.active) : "system",
                            aria_label: `${zoneName(area)}, ${zoneType(area.active)}`,
                        },
                        label: { text: zoneName(area), x: center[0], y: center[1] },
                    },
                    this._getContext(),
                    () => this._do(() => c._zoneRowActivated(area, areas)),
                    c._selectedIds.includes(area.id),
                );
                return room;
            });
        const original = super._drawSelection();
        const s = this._surface;
        if (s) c.handleRadius = 8 / Math.max(0.001, s.scale * this.realScale * this.mapScale);
        return svg`${original}${
            c._editMode && c._draft?.area && !c._draft.deleted && s
                ? svg`<g transform=${`translate(${-s.bounds.minX * s.scale * this.realScale} ${
                      s.bounds.maxY * s.scale * this.realScale
                  }) scale(${s.scale * this.realScale})`} style=${`--zk-world-font-size: ${
                      13 / Math.max(0.001, s.scale * this.realScale * this.mapScale)
                  }px`}>${c._renderDraftArea(c._draft.area)}</g>`
                : nothing
        }`;
    }
    protected _actionHandler(config: ActionableObjectConfig): () => void {
        return () => {
            if (!config.disabled) void this._activate((config as IconActionConfig).icon_id ?? "");
        };
    }
    private async _activate(action: string): Promise<void> {
        const c = this.controller;
        if (["zones", "edit", "layers", "info"].includes(action)) {
            if (c._editMode && action !== "edit") {
                await c._toggleEditMode();
                if (c._editMode) return;
            }
            if (action === "edit") {
                await c._toggleEditMode();
                this._panel = "zones";
            } else this._panel = this._panel === action ? null : (action as "zones" | "layers" | "info");
            this.requestUpdate();
            return;
        }
        if (!c._apiCompatible) return;
        if (action.startsWith("fan_")) {
            const level = action.slice(4);
            if (!["quiet", "auto", "strong"].includes(level)) return;
            await c._performAction("intensidad", () =>
                this.hass.callService("vacuum", "set_fan_speed", {
                    entity_id: this._zkConfig?.entity,
                    fan_speed: level,
                }),
            );
        } else if (["start", "pause", "stop", "return_to_base", "clean_spot"].includes(action)) {
            const service = action as "start" | "pause" | "stop" | "return_to_base" | "clean_spot";
            const labels = {
                start: "limpieza total",
                pause: "pausa",
                stop: "detención",
                return_to_base: "volver a la base",
                clean_spot: "limpieza de posición actual",
            };
            await c._performAction(labels[service], () =>
                this.hass.callService("vacuum", service, { entity_id: this._zkConfig?.entity }),
            );
        }
        this.requestUpdate();
    }
    private async _closePanel(): Promise<void> {
        if (this.controller._editMode) {
            await this.controller._toggleEditMode();
            if (this.controller._editMode) return;
        }
        this._panel = null;
        this.requestUpdate();
    }
    private async _do(action: () => unknown): Promise<void> {
        await action();
        this.requestUpdate();
    }
    protected _renderAuxiliary(): unknown {
        const c = this.controller,
            s = c._snapshot;
        if (!this._panel) return nothing;
        return html`<section
            class="zk-secondary"
            aria-label=${this._panel === "zones"
                ? c._editMode
                    ? "Editor de zonas"
                    : "Zonas guardadas"
                : this._panel === "layers"
                ? "Capas e historial"
                : "Información"}>
            <div class="zk-panel-heading">
                <h3>
                    ${this._panel === "zones"
                        ? c._editMode
                            ? "Editar zonas"
                            : "Zonas guardadas"
                        : this._panel === "layers"
                        ? "Capas e historial"
                        : "Información"}
                </h3>
                <button aria-label="Cerrar panel" @click=${() => this._closePanel()}>×</button>
            </div>
            ${this._panel === "zones"
                ? html`<button @click=${() => this._activate("edit")}>${c._editMode ? "Salir" : "Editar"}</button>
                      <button @click=${() => this._do(() => c._loadFreshCatalog(false))}>Recargar</button>${c._editMode
                          ? c._renderDraftPanel()
                          : nothing}${c._renderZoneList()}<button
                          @click=${() => this._do(() => c._expandDrawingSpace())}>
                          Ampliar espacio de dibujo
                      </button>`
                : nothing}
            ${this._panel === "layers" ? c._renderRouteTools() : nothing}
            ${this._panel === "info"
                ? html`<p>${statusName(s)}</p>
                      <p>Posición ${timestampLabel(s?.pose?.observed_at ?? null)}</p>
                      <p>
                          Catálogo ${s?.catalog.fresh && s?.catalog.available ? "actualizado" : "antiguo o sin lectura"}
                      </p>
                      <p>API 1 · Tarjeta ${CARD_VERSION}</p>
                      <p>Trayectoria por telemetría y cobertura estimada. Sin paredes reconstruidas.</p>
                      ${c._message ? html`<p role="status">${c._message}</p>` : nothing}<button
                          @click=${() => this._do(() => c._refreshData())}>
                          Recargar estado
                      </button>`
                : nothing}
        </section>`;
    }
    static get styles(): CSSResultGroup {
        return [
            super.styles,
            ZK901Controller.styles,
            css`
                :host {
                    display: block;
                    font-family: var(--paper-font-body1_-_font-family, Roboto, system-ui, sans-serif);
                    --zk-zone-normal: var(--primary-color, #009688);
                    --zk-zone-depth: #607d8b;
                    --zk-zone-forbid: #cf6679;
                    --map-card-primary-color: var(--primary-color, #009688);
                    --map-card-primary-text-color: #fff;
                    --map-card-room-outline-line-color: var(--primary-color, #009688);
                    --map-card-room-outline-line-color-selected: var(--primary-color, #009688);
                    --map-card-room-outline-fill-color-selected: color-mix(
                        in srgb,
                        var(--primary-color, #009688) 25%,
                        transparent
                    );
                    --map-card-room-label-color-selected: var(--primary-text-color, #263238);
                    --map-card-secondary-text-color: var(--primary-text-color, #333);
                }
                .zk-status {
                    padding: 8px 16px;
                    color: var(--secondary-text-color, #666);
                    font-size: 0.85rem;
                }
                .zk-notice {
                    overflow-wrap: anywhere;
                    padding: 12px 16px;
                    color: var(--error-color, #b23);
                    background: var(--secondary-background-color, #eee);
                }
                .zk-run,
                .zk-clear {
                    border: 0;
                    padding: 10px 18px;
                    border-radius: 25px;
                    background: var(--primary-color, #009688);
                    color: white;
                    font: inherit;
                    cursor: pointer;
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                }
                .map-actions-item[aria-disabled="true"] {
                    opacity: 0.4;
                    cursor: default;
                }
                .zk-selection-count {
                    position: absolute;
                    right: 0;
                    bottom: 0;
                    font-size: 11px;
                }
                .zk-clear {
                    background: transparent;
                    color: var(--primary-text-color, #333);
                }
                .zk-panel-heading {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                }
                .zk-panel-heading h3 {
                    margin: 0 0 12px;
                    font-size: 1rem;
                }
                .toast {
                    pointer-events: none;
                }
                .zk-persisted-room.forbid .room-outline {
                    fill: #cf6679;
                    fill-opacity: 0.12;
                    stroke: #cf6679;
                    stroke-dasharray: 5 4;
                }
                .zk-persisted-room.depth .room-outline {
                    stroke-dasharray: 9 4;
                }
                .zk-persisted-room.system {
                    opacity: 0.5;
                }
                .room-label {
                    pointer-events: none;
                }
                #map-zoomer {
                    max-height: 650px;
                }
                @media (max-width: 500px) {
                    #map-zoomer {
                        max-height: 480px;
                    }
                }
            `,
        ];
    }
}

const registry = window as unknown as Window & { customCards: unknown[] };
registry.customCards = registry.customCards ?? [];
registry.customCards.push({
    type: CARD_CUSTOM_ELEMENT_NAME,
    name: "Liectroux ZK901 Map Card",
    description: "Mapa y controles locales de Liectroux ZK901",
});

// Export the restored base for the local reference preview; only the ZK901 card is registered.
export { CommunityMapCard };
