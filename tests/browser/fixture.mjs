export const installBackend = ({ storageKey }) => {
    const initial = {
        generation: `browser-${Math.random().toString(16).slice(2)}`,
        revisionNumber: 1,
        nextId: 10,
        mapId: 554722792,
        areas: [
            {
                id: 1,
                tag: "Cocina",
                active: "normal",
                vertexs: [
                    [0, 0],
                    [800, 0],
                    [800, 600],
                    [0, 600],
                ],
                opaque: { keep: true },
            },
            {
                id: 2,
                tag: "Pasillo",
                active: "depth",
                vertexs: [
                    [900, 0],
                    [1300, 0],
                    [1300, 500],
                    [900, 500],
                ],
            },
            {
                id: 3,
                tag: "Prohibida",
                active: "forbid",
                vertexs: [
                    [0, 700],
                    [300, 700],
                    [300, 1000],
                    [0, 1000],
                ],
            },
            {
                id: 4,
                tag: "Pieza",
                active: "normal",
                vertexs: [
                    [1400, 300],
                    [1650, 300],
                    [1650, 550],
                    [1400, 550],
                ],
            },
            {
                id: 5,
                tag: "Pieza",
                active: "normal",
                vertexs: [
                    [1400, 650],
                    [1650, 650],
                    [1650, 900],
                    [1400, 900],
                ],
            },
            {
                id: 6,
                tag: "Geometría inválida",
                active: "normal",
                vertexs: [
                    [0, 0],
                    [1, 1],
                ],
            },
            {
                id: -3,
                tag: "Sistema",
                active: "normal",
                vertexs: [
                    [1500, 0],
                    [1700, 0],
                    [1700, 200],
                    [1500, 200],
                ],
            },
        ],
        status: {
            battery: 87,
            mode: "charge",
            sub_mode: null,
            cleaning_level: "auto",
            cleaning_level_kind: "suction",
            error: 0,
            observed_at: new Date().toISOString(),
        },
        pose: { pos: [400, 300], phi: 1000, observed_at: new Date().toISOString() },
    };
    const getState = () => JSON.parse(localStorage.getItem(storageKey) || "null") || initial;
    if (!localStorage.getItem(storageKey)) localStorage.setItem(storageKey, JSON.stringify(initial));
    let state = getState();
    let subscribers = [];
    let catalogFresh = true;
    let available = true;
    let apiVersion = 1;
    let rejectSubscription = false;
    let serviceDelay = 0;
    let holdNextApply = false;
    let releaseApply = null;
    let failNextApplyAfterWrite = false;
    let shouldFailService = false;
    window.__zkCalls = [];
    window.__zkWsCalls = [];

    const revision = () => state.revisionNumber.toString(16).padStart(64, "0");
    const emit = () => {
        state = getState();
        subscribers.forEach(subscription => {
            subscription.sequence += 1;
            subscription.callback(snapshot(subscription));
        });
    };
    const persist = () => {
        localStorage.setItem(storageKey, JSON.stringify(state));
        emit();
    };
    const catalog = () => ({
        map_id: state.mapId,
        revision: revision(),
        areas: structuredClone(state.areas),
        observed_at: new Date().toISOString(),
        age_seconds: 0,
        fresh: catalogFresh,
        available: true,
        error: null,
    });
    const snapshot = subscription => ({
        api_version: apiVersion,
        generation: subscription.generation,
        sequence: subscription.sequence,
        entity_id: "vacuum.liectroux_zk901",
        available,
        status: structuredClone(state.status),
        pose: structuredClone(state.pose),
        catalog: catalog(),
        trajectory: state.trajectory,
        capabilities: {
            subscribe: true,
            clean_areas: true,
            zone_edit: true,
            current_position: true,
            cleaning_level: true,
        },
    });
    const mutate = callback => {
        callback(state);
        state.revisionNumber += 1;
        persist();
    };

    window.__zkBackend = {
        externalRename(areaId, tag) {
            mutate(current => {
                const area = current.areas.find(item => item.id === areaId);
                if (area) area.tag = tag;
            });
        },
        changeMapId(mapId) {
            mutate(current => {
                current.mapId = mapId;
            });
        },
        setAreas(areas) {
            state.areas = structuredClone(areas);
            state.revisionNumber += 1;
            persist();
        },
        setError(error) {
            state.status.error = structuredClone(error);
            persist();
        },
        setPose(pose) {
            state.pose = structuredClone(pose);
            persist();
        },
        setTrajectory(trajectory) {
            state.trajectory = structuredClone(trajectory);
            persist();
        },
        setCatalogFresh(value) {
            catalogFresh = value;
            emit();
        },
        setAvailable(value) {
            available = value;
            emit();
        },
        setApiVersion(value) {
            apiVersion = value;
        },
        rejectSubscriptions(value) {
            rejectSubscription = value;
        },
        delayNextService(milliseconds) {
            serviceDelay = milliseconds;
        },
        failNextService() {
            shouldFailService = true;
        },
        failNextApplyAfterWrite() {
            failNextApplyAfterWrite = true;
        },
        holdNextApplyResponse() {
            holdNextApply = true;
        },
        applyResponsePending() {
            return releaseApply !== null;
        },
        releaseApplyResponse() {
            const release = releaseApply;
            releaseApply = null;
            release?.();
        },
        subscriberCount() {
            return subscribers.length;
        },
        getState,
    };
    window.addEventListener("storage", event => {
        if (event.key === storageKey && event.newValue) {
            state = JSON.parse(event.newValue);
            emit();
        }
    });

    window.hass = {
        entities: {
            "vacuum.liectroux_zk901": {
                entity_id: "vacuum.liectroux_zk901",
                platform: "liectroux_zk901",
                name: "ZK901",
            },
        },
        states: {
            "vacuum.liectroux_zk901": {
                state: "docked",
                attributes: { friendly_name: "ZK901" },
            },
        },
        connection: {
            async subscribeMessage(callback, message) {
                if (message.type !== "liectroux_zk901/card/subscribe") throw new Error("Unexpected subscription");
                if (rejectSubscription) throw new Error("Unauthorized: administrator access required");
                const subscription = {
                    callback,
                    generation: `tab-${Math.random().toString(16).slice(2)}`,
                    sequence: 0,
                };
                subscribers.push(subscription);
                queueMicrotask(() => {
                    subscription.sequence += 1;
                    callback(snapshot(subscription));
                });
                return () => {
                    subscribers = subscribers.filter(item => item !== subscription);
                };
            },
        },
        async callWS(message) {
            window.__zkWsCalls.push(structuredClone(message));
            if (message.type === "liectroux_zk901/zone_editor/get") {
                return { ok: true, ...catalog(), pose: structuredClone(state.pose) };
            }
            if (message.type === "liectroux_zk901/card/refresh") {
                const sub = { generation: `refresh-${Date.now()}`, sequence: 0 };
                return { ok: true, ...snapshot(sub) };
            }
            if (message.type === "liectroux_zk901/trajectory/clear") {
                state.trajectory = {
                    ...state.trajectory,
                    sessions: [],
                    current_id: null,
                    coverage: { cell_size: 100, cells: [] },
                };
                persist();
                return { ok: true };
            }
            if (message.type !== "liectroux_zk901/zone_editor/apply")
                throw new Error(`Unexpected WebSocket command: ${message.type}`);
            if (message.base_map_id !== state.mapId || message.base_revision !== revision()) {
                return {
                    ok: false,
                    error: "conflict",
                    map_id: state.mapId,
                    revision: revision(),
                    areas: structuredClone(state.areas),
                };
            }
            let areaId = message.area_id;
            if (message.operation === "create") {
                areaId = state.nextId++;
                state.areas.push({
                    id: areaId,
                    name: `Backend ${areaId}`,
                    ...Object.fromEntries(
                        Object.entries(message).filter(([key]) => ["tag", "active", "vertexs"].includes(key)),
                    ),
                });
            } else if (message.operation === "update") {
                const area = state.areas.find(item => item.id === areaId);
                if (!area) return { ok: false, error: "invalid", detail: "zona no encontrada" };
                Object.assign(area, {
                    tag: message.tag,
                    active: message.active,
                    vertexs: structuredClone(message.vertexs),
                });
            } else if (message.operation === "delete") {
                state.areas = state.areas.filter(item => item.id !== areaId);
            }
            state.revisionNumber += 1;
            persist();
            if (failNextApplyAfterWrite) {
                failNextApplyAfterWrite = false;
                throw new Error("ERR_CONNECTION_LOST");
            }
            const response = {
                ok: true,
                map_id: state.mapId,
                revision: revision(),
                areas: structuredClone(state.areas),
                operation: message.operation,
                area_id: areaId,
                observed_at: new Date().toISOString(),
            };
            if (holdNextApply) {
                holdNextApply = false;
                await new Promise(resolve => {
                    releaseApply = resolve;
                });
            }
            return response;
        },
        async callService(domain, service, data) {
            window.__zkCalls.push({ domain, service, data: structuredClone(data) });
            const delay = serviceDelay;
            serviceDelay = 0;
            if (delay) await new Promise(resolve => setTimeout(resolve, delay));
            if (service === "start") state.status.mode = "sweep";
            if (service === "pause") state.status.mode = "pause";
            if (service === "stop") state.status.mode = "pause";
            if (service === "return_to_base") state.status.mode = "backcharge";
            if (service === "clean_spot") {
                state.status.mode = "sweep";
                state.status.sub_mode = "curpoint";
            }
            if (service === "set_fan_speed") state.status.cleaning_level = data.fan_speed;
            if (service === "clean_areas") {
                assert(Array.isArray(data.area_ids));
                assert(data.area_ids.length > 0);
            }
            state.status.observed_at = new Date().toISOString();
            persist();
            if (shouldFailService) {
                shouldFailService = false;
                throw new Error("ERR_CONNECTION_LOST");
            }
        },
    };
};

export const installHaElements = () => {
    const paths = {
        play: "M8 5v14l11-7z",
        pause: "M6 5h4v14H6zM14 5h4v14h-4z",
        stop: "M6 6h12v12H6z",
        home: "M3 10l9-8 9 8v11h-6v-7H9v7H3z",
        pencil: "M3 17v4h4L21 7l-4-4z",
        layers: "M12 2L1 8l11 6 11-6zM1 13l11 6 11-6M1 18l11 6 11-6",
        information: "M11 10h2v8h-2zM11 6h2v2h-2z",
        floor: "M3 3h18v18H3zM3 12h9V3M12 21v-6h9",
        fan: "M12 12C2 4 12-1 14 5s-2 7-2 7C22 4 25 15 19 16s-7-4-7-4C19 22 7 26 6 20s6-8 6-8",
        target: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m0 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10",
        battery: "M9 2h6v2h3v18H6V4h3z",
        lock: "M6 10h12v12H6zM8 10V6a4 4 0 0 1 8 0v4",
        magnify: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14m5 12l7 7",
        robot: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M5 8h14",
        check: "M3 12l6 6L21 4",
        image: "M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6",
        chevron: "M5 9l7 7 7-7",
    };
    class Icon extends HTMLElement {
        static get observedAttributes() {
            return ["icon"];
        }
        constructor() {
            super();
            this.attachShadow({ mode: "open" });
        }
        get icon() {
            return this.getAttribute("icon");
        }
        set icon(value) {
            this.setAttribute("icon", value ?? "");
        }
        connectedCallback() {
            this.render();
        }
        attributeChangedCallback() {
            this.render();
        }
        render() {
            const key = Object.keys(paths).find(key => (this.icon ?? "").includes(key)) ?? "robot";
            this.shadowRoot.innerHTML = `<style>:host{display:inline-flex;width:24px;height:24px;vertical-align:middle}svg{width:100%;height:100%;fill:currentColor}</style><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[key]}"/></svg>`;
        }
    }
    customElements.define(
        "ha-card",
        class extends HTMLElement {
            constructor() {
                super();
                this.attachShadow({ mode: "open" });
                this.shadowRoot.innerHTML =
                    "<style>:host{display:block;background:var(--card-background-color,white);color:var(--primary-text-color);border-radius:12px;position:relative;box-shadow:0 1px 4px #0002}::slotted(.card-header){font-size:24px;font-weight:400;line-height:32px;padding:24px 16px 16px;margin:0}</style><slot></slot>";
            }
        },
    );
    customElements.define("ha-icon", Icon);
    customElements.define("ha-state-icon", class extends Icon {});
    customElements.define(
        "ha-dropdown",
        class extends HTMLElement {
            constructor() {
                super();
                this.attachShadow({ mode: "open" });
                this.shadowRoot.innerHTML =
                    '<style>:host{position:relative;display:inline-block}#items{display:none;position:absolute;z-index:20;min-width:170px;background:var(--card-background-color,white);box-shadow:0 3px 12px #0004;border-radius:12px;padding:8px}:host([open]) #items{display:block}</style><slot name="trigger"></slot><div id="items"><slot></slot></div>';
            }
            connectedCallback() {
                this.addEventListener("click", event => {
                    if (event.target.closest('[slot="trigger"]')) this.toggleAttribute("open");
                });
            }
            hideMenu() {
                this.removeAttribute("open");
            }
        },
    );
    document.addEventListener("DOMContentLoaded", () => {
        const style = document.createElement("style");
        style.textContent =
            ":root{--primary-color:#009688;--slider-color:#009688;--slider-secondary-color:#dce7e5;--primary-text-color:#263238;--secondary-text-color:#607d8b;--text-light-primary-color:#fff;--primary-background-color:#f5f7f8;--secondary-background-color:#e7eef0;--card-background-color:#fff;--divider-color:#d5dfe2}body{margin:16px;background:var(--primary-background-color);font:14px Roboto,system-ui,sans-serif}main{max-width:540px;margin:auto}ha-card{display:block;background:var(--card-background-color);border-radius:12px;box-shadow:0 1px 4px #0002}paper-button{cursor:pointer}";
        document.head.append(style);
    });
};
