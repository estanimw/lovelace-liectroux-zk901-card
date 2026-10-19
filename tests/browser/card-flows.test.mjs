import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bundlePath = path.join(root, "dist/liectroux-zk901-map-card.js");
const legacyEditorPath = path.join(root, "custom_components/liectroux_zk901/www/liectroux-zk901-zone-editor.js");

const installBackend = ({ storageKey }) => {
    const initial = {
        generation: `browser-${Math.random().toString(16).slice(2)}`,
        revisionNumber: 1,
        nextId: 10,
        mapId: 554722792,
        areas: [
            { id: 1, tag: "Cocina", active: "normal", vertexs: [[0, 0], [800, 0], [800, 600], [0, 600]], opaque: { keep: true } },
            { id: 2, tag: "Pasillo", active: "depth", vertexs: [[900, 0], [1300, 0], [1300, 500], [900, 500]] },
            { id: 3, tag: "Prohibida", active: "forbid", vertexs: [[0, 700], [300, 700], [300, 1000], [0, 1000]] },
            { id: 4, tag: "Pieza", active: "normal", vertexs: [[1400, 300], [1650, 300], [1650, 550], [1400, 550]] },
            { id: 5, tag: "Pieza", active: "normal", vertexs: [[1400, 650], [1650, 650], [1650, 900], [1400, 900]] },
            { id: 6, tag: "Geometría inválida", active: "normal", vertexs: [[0, 0], [1, 1]] },
            { id: -3, tag: "Sistema", active: "normal", vertexs: [[1500, 0], [1700, 0], [1700, 200], [1500, 200]] },
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
        capabilities: { subscribe: true, clean_areas: true, zone_edit: true, current_position: true, cleaning_level: true },
    });
    const mutate = (callback) => {
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
        changeMapId(mapId) { mutate(current => { current.mapId = mapId; }); },
        setAreas(areas) { state.areas = structuredClone(areas); state.revisionNumber += 1; persist(); },
        setError(error) { state.status.error = structuredClone(error); persist(); },
        setPose(pose) { state.pose = structuredClone(pose); persist(); },
        setTrajectory(trajectory) { state.trajectory = structuredClone(trajectory); persist(); },
        setCatalogFresh(value) { catalogFresh = value; emit(); },
        setAvailable(value) { available = value; emit(); },
        setApiVersion(value) { apiVersion = value; },
        rejectSubscriptions(value) { rejectSubscription = value; },
        delayNextService(milliseconds) { serviceDelay = milliseconds; },
        failNextService() { shouldFailService = true; },
        failNextApplyAfterWrite() { failNextApplyAfterWrite = true; },
        holdNextApplyResponse() { holdNextApply = true; },
        applyResponsePending() { return releaseApply !== null; },
        releaseApplyResponse() { const release = releaseApply; releaseApply = null; release?.(); },
        subscriberCount() { return subscribers.length; },
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
                return () => { subscribers = subscribers.filter(item => item !== subscription); };
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
                state.trajectory = { ...state.trajectory, sessions: [], current_id: null, coverage: { cell_size: 100, cells: [] } };
                persist();
                return { ok: true };
            }
            if (message.type !== "liectroux_zk901/zone_editor/apply") throw new Error(`Unexpected WebSocket command: ${message.type}`);
            if (message.base_map_id !== state.mapId || message.base_revision !== revision()) {
                return { ok: false, error: "conflict", map_id: state.mapId, revision: revision(), areas: structuredClone(state.areas) };
            }
            let areaId = message.area_id;
            if (message.operation === "create") {
                areaId = state.nextId++;
                state.areas.push({ id: areaId, name: `Backend ${areaId}`, ...Object.fromEntries(Object.entries(message).filter(([key]) => ["tag", "active", "vertexs"].includes(key))) });
            } else if (message.operation === "update") {
                const area = state.areas.find(item => item.id === areaId);
                if (!area) return { ok: false, error: "invalid", detail: "zona no encontrada" };
                Object.assign(area, { tag: message.tag, active: message.active, vertexs: structuredClone(message.vertexs) });
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
                await new Promise(resolve => { releaseApply = resolve; });
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

test("minimum setup, daily actions, multi-zone and persisted CRUD", { timeout: 60_000 }, async () => {
    const bundle = await readFile(bundlePath);
    const legacyEditor = await readFile(legacyEditorPath);
    const server = createServer((request, response) => {
        if (request.url === "/legacy-editor.js") {
            response.writeHead(200, { "content-type": "text/javascript" });
            response.end(legacyEditor);
            return;
        }
        if (request.url === "/card.js") {
            response.writeHead(200, { "content-type": "text/javascript" });
            response.end(bundle);
            return;
        }
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<!doctype html><html><head><meta name=viewport content='width=device-width,initial-scale=1'></head><body><main></main></body></html>");
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const origin = `http://127.0.0.1:${address.port}`;
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, hasTouch: true });
    const storageKey = `zk901-card-${Date.now()}`;
    await context.addInitScript(installBackend, { storageKey });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));

    try {
        await page.goto(origin);
        await page.addScriptTag({ url: `${origin}/legacy-editor.js` });
        assert.equal(await page.evaluate(() => !!customElements.get("liectroux-zk901-zone-editor")), true);
        await page.addScriptTag({ url: `${origin}/card.js`, type: "module" });
        assert.equal(await page.evaluate(() => !!customElements.get("liectroux-zk901-map-card")), true);
        await page.evaluate(async () => {
            const editor = await customElements.get("liectroux-zk901-map-card").getConfigElement();
            editor.hass = window.hass;
            editor.setConfig({ type: "custom:liectroux-zk901-map-card", entity: "vacuum.liectroux_zk901" });
            document.querySelector("main").append(editor);
            const card = document.createElement("liectroux-zk901-map-card");
            card.setConfig({ type: "custom:liectroux-zk901-map-card", entity: "vacuum.liectroux_zk901" });
            card.hass = window.hass;
            document.querySelector("main").append(card);
            window.__card = card;
        });

        const rows = page.locator("button.zone-row");
        await rows.first().waitFor();
        assert.equal(await page.getByText("87%", { exact: true }).count(), 1);
        assert.equal(await page.locator("button.zone-row").filter({ hasText: "Prohibida" }).count(), 1);
        assert.equal(await page.locator("button.zone-row").filter({ hasText: "Pieza" }).count(), 2);
        const invalidGeometryRow = page.locator("button.zone-row").filter({ hasText: "Geometría inválida" });
        assert.equal(await invalidGeometryRow.count(), 1);
        assert.equal(await page.locator(".zone-group[data-area-id='6']").count(), 0);
        assert.equal(await page.locator("img, camera-card").count(), 0);
        assert.equal(await page.locator("select#entity option[value='vacuum.liectroux_zk901']").count(), 1);

        const cardElement = page.locator("liectroux-zk901-map-card").first();
        await cardElement.evaluate(node => { node.style.width = "440px"; });
        const narrowCardLayout = await cardElement.locator(".workspace").evaluate(node => getComputedStyle(node).gridTemplateColumns);
        assert.equal(narrowCardLayout.trim().split(/\s+/).length, 1);
        assert.ok(await page.evaluate(() => window.innerWidth > 720));
        await cardElement.evaluate(node => { node.style.width = ""; });

        await page.evaluate(() => window.__zkBackend.setError([]));
        assert.equal(await cardElement.locator(".error-state").count(), 0);
        await page.evaluate(() => window.__zkBackend.setError(["brush", 7]));
        await cardElement.getByText('Error ["brush",7]', { exact: true }).waitFor();
        await page.evaluate(() => window.__zkBackend.setError(0));
        assert.equal(await cardElement.locator(".error-state").count(), 0);

        await page.getByRole("button", { name: "Editar", exact: true }).click();
        assert.equal(await invalidGeometryRow.isDisabled(), true);
        await page.getByRole("button", { name: "Salir", exact: true }).click();

        const initialAreas = await page.evaluate(() => window.__zkBackend.getState().areas);
        await page.evaluate(() => window.__zkBackend.setAreas([]));
        await page.getByText("El catálogo no tiene zonas guardadas.").waitFor();
        await page.getByRole("button", { name: "Editar", exact: true }).click();
        await page.getByRole("button", { name: "Crear zona" }).click();
        assert.match(await page.locator(".geometry-tools").innerText(), /4 vértices/);
        assert.equal(
            await page.locator(".zone-group[data-draft-area='true'] polygon").getAttribute("points"),
            "340,-240 460,-240 460,-360 340,-360",
        );
        page.once("dialog", dialog => dialog.accept());
        await page.getByRole("button", { name: "Descartar", exact: true }).click();
        await page.getByRole("button", { name: "Salir", exact: true }).click();
        await page.evaluate(areas => window.__zkBackend.setAreas(areas), initialAreas);
        await rows.first().waitFor();
        await page.evaluate(() => window.__zkBackend.setPose(null));
        await page.getByText("La última posición es antigua; no se muestra como actual.").waitFor();
        await page.evaluate(() => window.__zkBackend.setPose({ pos: [400, 300], phi: 1000, observed_at: new Date(Date.now() - 120_000).toISOString() }));
        await page.getByText("La última posición es antigua; no se muestra como actual.").waitFor();
        await page.evaluate(() => window.__zkBackend.setPose({ pos: [400, 300], phi: 1000, observed_at: new Date().toISOString() }));

        await page.evaluate(() => window.__zkBackend.setCatalogFresh(false));
        assert.equal(await page.getByRole("button", { name: "Limpiar seleccionadas" }).isDisabled(), true);
        assert.match(await page.getByText("Recargá el catálogo para confirmar", { exact: false }).innerText(), /zonas seleccionadas/);
        await page.evaluate(() => window.__zkBackend.setCatalogFresh(true));

        await page.evaluate(() => window.__zkBackend.setAvailable(false));
        assert.equal(await page.getByRole("button", { name: "Iniciar limpieza total" }).isDisabled(), true);
        await page.evaluate(() => window.__zkBackend.setAvailable(true));

        await page.evaluate(() => window.__zkBackend.delayNextService(120));
        await page.getByRole("button", { name: "Iniciar limpieza total" }).click();
        await page.waitForFunction(() => window.__zkCalls.length === 1);
        assert.equal(await page.getByRole("button", { name: "Iniciar limpieza total" }).isDisabled(), true);
        await page.getByRole("button", { name: "Pausar" }).click();
        await page.getByRole("button", { name: "Continuar limpieza" }).click();
        await page.getByRole("button", { name: "Detener" }).click();
        await page.getByRole("button", { name: "Volver a la base" }).click();
        await page.getByRole("button", { name: "Limpiar posición actual" }).click();
        await page.getByLabel("Intensidad de limpieza").selectOption("strong");
        await page.waitForFunction(() => window.__zkCalls.length >= 7);
        const dailyCalls = await page.evaluate(() => window.__zkCalls.slice(0, 7));
        assert.deepEqual(dailyCalls.map(call => call.service), [
            "start", "pause", "start", "stop", "return_to_base", "clean_spot", "set_fan_speed",
        ]);
        assert.equal(dailyCalls[0].data.entity_id, "vacuum.liectroux_zk901");

        const callsBeforeUncertainAction = await page.evaluate(() => window.__zkCalls.length);
        await page.evaluate(() => window.__zkBackend.failNextService());
        await page.getByRole("button", { name: "Volver a la base" }).click();
        await page.waitForFunction(before => window.__zkCalls.length === before + 1, callsBeforeUncertainAction);
        await page.getByText(/Se perdió la confirmación de volver a la base/i).waitFor();
        assert.equal(await page.evaluate(() => window.__zkCalls.length), callsBeforeUncertainAction + 1);
        await page.getByRole("button", { name: "Recargar estado" }).click();
        await page.getByText("Estado y catálogo releídos. Revisá la actividad observada antes de iniciar otra operación.").waitFor();
        assert.equal(await page.evaluate(() => window.__zkCalls.length), callsBeforeUncertainAction + 1);

        await page.getByRole("button", { name: /Cocina, Normal/ }).click();
        assert.equal(await page.locator("button.zone-row").filter({ hasText: "Cocina" }).getAttribute("aria-pressed"), "true");
        await page.locator("button.zone-row").filter({ hasText: "Pasillo" }).click();
        assert.equal(await page.locator("button.zone-row[aria-pressed='true']").count(), 2);
        await page.evaluate(() => window.__zkBackend.setCatalogFresh(false));
        assert.equal(await page.getByRole("button", { name: "Limpiar seleccionadas (2)" }).isDisabled(), true);
        await page.evaluate(() => window.__zkBackend.setCatalogFresh(true));
        await page.getByRole("button", { name: "Limpiar seleccionadas (2)" }).click();
        await page.waitForFunction(() => window.__zkCalls.some(call => call.service === "clean_areas"));
        const zoneCalls = await page.evaluate(() => window.__zkCalls.filter(call => call.service === "clean_areas"));
        assert.equal(zoneCalls.length, 1);
        assert.deepEqual(zoneCalls[0].data.area_ids, [1, 2]);
        await page.locator("button.zone-row").filter({ hasText: "Prohibida" }).click();
        assert.match(await page.locator("div.notice[role='alert']").last().innerText(), /prohibida/i);

        await page.getByRole("button", { name: "Editar", exact: true }).click();
        await page.getByRole("button", { name: "Crear zona" }).click();
        const nameInput = page.locator("input[maxlength='80']");
        await nameInput.fill("Estudio");
        await page.locator(".field-label select").selectOption("depth");
        await page.getByRole("button", { name: "Añadir vértice" }).click();
        await page.getByRole("button", { name: "Deshacer" }).click();
        assert.match(await page.locator(".geometry-tools").innerText(), /4 vértices/);
        await page.getByRole("button", { name: "Vértice 1" }).click();
        await page.getByRole("button", { name: "Quitar vértice seleccionado" }).click();
        assert.match(await page.locator(".geometry-tools").innerText(), /3 vértices/);
        await page.getByRole("button", { name: "Deshacer" }).click();
        assert.match(await page.locator(".geometry-tools").innerText(), /4 vértices/);
        await page.getByRole("button", { name: "Mover derecha" }).click();
        await page.getByRole("button", { name: "Guardar" }).click();
        await page.getByText("Cambios guardados y verificados contra el catálogo del robot.").waitFor();
        let state = await page.evaluate(() => window.__zkBackend.getState());
        const created = state.areas.find(area => area.tag === "Estudio");
        assert.ok(created);
        assert.equal(created.active, "depth");
        const createRequest = await page.evaluate(() => window.__zkWsCalls.find(message => message.operation === "create"));
        assert.equal(createRequest.entity_id, "vacuum.liectroux_zk901");
        assert.deepEqual(createRequest.vertexs[0], [86, 74]);

        await page.locator("button.zone-row").filter({ hasText: "Cocina" }).click();
        await page.locator("input[maxlength='80']").fill("Cocina editada");
        await page.getByRole("button", { name: "Deshacer" }).click();
        assert.equal(await page.locator("input[maxlength='80']").inputValue(), "Cocina");
        await page.locator("input[maxlength='80']").fill("Cocina editada");
        await page.locator(".field-label select").selectOption("forbid");
        await page.evaluate(() => window.__zkBackend.holdNextApplyResponse());
        await page.getByRole("button", { name: "Guardar" }).click();
        await page.waitForFunction(() => window.__zkBackend.applyResponsePending());
        await page.evaluate(() => window.__zkBackend.externalRename(4, "Cambio durante guardado"));
        await page.evaluate(() => window.__zkBackend.releaseApplyResponse());
        await page.getByText("Cambios guardados y verificados contra el catálogo del robot.").waitFor();
        await page.locator("button.zone-row").filter({ hasText: "Cambio durante guardado" }).waitFor();
        state = await page.evaluate(() => window.__zkBackend.getState());
        assert.equal(state.areas.find(area => area.id === 1).tag, "Cocina editada");
        assert.equal(state.areas.find(area => area.id === 1).opaque.keep, true);
        assert.equal(state.areas.find(area => area.id === 1).active, "forbid");

        await page.locator("button.zone-row").filter({ hasText: "Pasillo" }).click();
        await page.locator("input[maxlength='80']").fill("Borrador propio");
        await page.evaluate(() => window.__zkBackend.externalRename(2, "Cambio externo"));
        await page.getByRole("button", { name: "Descartar borrador y cargar catálogo actualizado" }).waitFor();
        assert.match(await page.locator(".draft-conflict-summary").innerText(), /Borrador propio/);
        page.on("dialog", dialog => dialog.accept());
        await page.getByRole("button", { name: "Descartar borrador y cargar catálogo actualizado" }).click();
        await page.locator("button.zone-row").filter({ hasText: "Cambio externo" }).waitFor();

        await page.locator("button.zone-row").filter({ hasText: "Cambio externo" }).click();
        await page.locator("input[maxlength='80']").fill("Borrador ante mapa nuevo");
        await page.evaluate(() => window.__zkBackend.changeMapId(987654321));
        await page.getByRole("button", { name: "Descartar borrador y cargar catálogo actualizado" }).waitFor();
        assert.match(await page.locator(".draft-conflict-summary").innerText(), /Borrador ante mapa nuevo/);
        assert.match(await page.locator(".conflict-catalog").innerText(), /987654321/);
        await page.getByRole("button", { name: "Descartar borrador y cargar catálogo actualizado" }).click();

        await page.locator("button.zone-row").filter({ hasText: "Estudio" }).click();
        await page.getByRole("button", { name: "Eliminar zona…" }).click();
        await page.getByRole("button", { name: "Guardar" }).click();
        await page.getByText("Cambios guardados y verificados contra el catálogo del robot.").waitFor();
        state = await page.evaluate(() => window.__zkBackend.getState());
        assert.equal(state.areas.some(area => area.id === created.id), false);
        const operations = await page.evaluate(() => window.__zkWsCalls.filter(message => message.type === "liectroux_zk901/zone_editor/apply").map(message => message.operation));
        assert.deepEqual(operations, ["create", "update", "delete"]);

        await page.getByRole("button", { name: "Crear zona" }).click();
        await page.locator("input[maxlength='80']").fill("Zona incierta");
        await page.evaluate(() => window.__zkBackend.failNextApplyAfterWrite());
        const applyCount = await page.evaluate(() => window.__zkWsCalls.filter(message => message.type === "liectroux_zk901/zone_editor/apply").length);
        await page.getByRole("button", { name: "Guardar" }).click();
        await page.getByText(/Se perdió la respuesta del guardado/).waitFor();
        assert.equal(await page.evaluate(() => window.__zkWsCalls.filter(message => message.type === "liectroux_zk901/zone_editor/apply").length), applyCount + 1);
        await page.getByRole("button", { name: "Recargar catálogo" }).click();
        await page.getByRole("button", { name: "Descartar borrador y cargar catálogo actualizado" }).waitFor();
        assert.match(await page.locator(".conflict-catalog").innerText(), /Zona incierta/);
        assert.equal(await page.evaluate(() => window.__zkWsCalls.filter(message => message.type === "liectroux_zk901/zone_editor/apply").length), applyCount + 1);
        await page.getByRole("button", { name: "Descartar borrador y cargar catálogo actualizado" }).click();
        await page.getByRole("button", { name: "Salir", exact: true }).waitFor();
        await page.getByRole("button", { name: "Salir", exact: true }).click();

        await page.getByRole("button", { name: "Vaciar selección y volver a elegir" }).click();
        let zoneBox = await page.locator(".zone-group[data-area-id='2']").boundingBox();
        assert.ok(zoneBox);
        await page.touchscreen.tap(zoneBox.x + zoneBox.width / 2, zoneBox.y + zoneBox.height / 2);
        const renamedRow = page.locator("button.zone-row").filter({ hasText: "Cambio externo" });
        assert.equal(await renamedRow.getAttribute("aria-pressed"), "true");
        await page.getByRole("button", { name: "Limpiar selección" }).click();

        const keyboardZone = page.locator(".zone-group[data-area-id='2']");
        await keyboardZone.focus();
        await keyboardZone.press("Enter");
        assert.equal(await renamedRow.getAttribute("aria-pressed"), "true");
        await keyboardZone.press("Space");
        assert.equal(await renamedRow.getAttribute("aria-pressed"), "false");

        await page.evaluate(() => {
            document.documentElement.style.setProperty("--primary-background-color", "#f6f7fb");
            document.documentElement.style.setProperty("--primary-color", "#526dcc");
        });
        const lightFill = await page.locator(".map-background").evaluate(node => getComputedStyle(node).fill);
        await page.evaluate(() => {
            document.documentElement.style.setProperty("--primary-background-color", "#151923");
            document.documentElement.style.setProperty("--primary-color", "#9bb7ff");
        });
        const darkFill = await page.locator(".map-background").evaluate(node => getComputedStyle(node).fill);
        assert.notEqual(darkFill, lightFill);
        await page.evaluate(() => {
            document.documentElement.style.setProperty("--primary-background-color", "#f6f7fb");
            document.documentElement.style.setProperty("--primary-color", "#526dcc");
        });

        await page.setViewportSize({ width: 360, height: 800 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
        await page.screenshot({ path: path.join(tmpdir(), "zk901-card-mobile.png"), fullPage: true });
        await page.setViewportSize({ width: 1280, height: 1000 });
        await page.screenshot({ path: path.join(tmpdir(), "zk901-card-desktop.png"), fullPage: true });

        await page.evaluate(() => {
            const card = document.createElement("liectroux-zk901-map-card");
            card.setConfig({ type: "custom:liectroux-zk901-map-card", entity: "vacuum.liectroux_zk901" });
            card.hass = window.hass;
            document.querySelector("main").append(card);
            window.__secondCard = card;
        });
        await page.locator("liectroux-zk901-map-card").nth(1).locator("button.zone-row").first().waitFor();
        const secondPage = await context.newPage();
        await secondPage.goto(origin);
        await secondPage.addScriptTag({ url: `${origin}/card.js`, type: "module" });
        await secondPage.evaluate(() => {
            const card = document.createElement("liectroux-zk901-map-card");
            card.setConfig({ type: "custom:liectroux-zk901-map-card", entity: "vacuum.liectroux_zk901" });
            card.hass = window.hass;
            document.querySelector("main").append(card);
        });
        await secondPage.locator("button.zone-row").first().waitFor();
        await page.evaluate(() => window.__zkBackend.externalRename(2, "Cambio entre pestañas"));
        await page.locator("liectroux-zk901-map-card").first().locator("button.zone-row").filter({ hasText: "Cambio entre pestañas" }).waitFor();
        await page.locator("liectroux-zk901-map-card").nth(1).locator("button.zone-row").filter({ hasText: "Cambio entre pestañas" }).waitFor();
        await secondPage.locator("button.zone-row").filter({ hasText: "Cambio entre pestañas" }).waitFor();
        const firstTabCalls = await page.evaluate(() => window.__zkCalls.length);
        await page.evaluate(() => {
            const card = window.__card;
            card.hass = { ...window.hass, connection: { subscribeMessage: window.hass.connection.subscribeMessage } };
        });
        await page.waitForFunction(() => window.__zkBackend.subscriberCount() === 2);
        assert.equal(await page.evaluate(() => window.__zkCalls.length), firstTabCalls);
        await page.evaluate(() => window.__secondCard.remove());
        await page.waitForFunction(() => window.__zkBackend.subscriberCount() === 1);

        // Persistent routes arrive as snapshots, never through frontend LAN polling.
        await page.evaluate(() => window.__zkBackend.setTrajectory({
            current_id: "second", updated_at: new Date().toISOString(), error: null,
            capturing: true, interval_seconds: 20,
            coverage: { cell_size: 100, cells: [[0, 0], [1, 1], [10, 10]] },
            sessions: [
                { id: "first", started_at: "2026-10-19T10:00:00Z", ended_at: "2026-10-19T10:10:00Z", incomplete: true,
                  segments: [{ kind: "cleaning", points: [[0, 0], [100, 200]] }] },
                { id: "second", started_at: "2026-10-19T11:00:00Z", ended_at: null, incomplete: false,
                  segments: [{ kind: "cleaning", points: [[1000, 1000], [1200, 1400]] }, { kind: "return", points: [[1400, 1400], [1500, 1300]] }] },
            ],
        }));
        await page.getByText("Capturando cada 20 s", { exact: false }).waitFor();
        assert.equal(await page.locator(".route-layer polyline").count(), 2);
        assert.equal(await page.locator(".coverage-layer").count(), 1);
        await page.getByLabel("Cobertura estimada", { exact: true }).uncheck();
        assert.equal(await page.locator(".coverage-layer").count(), 0);
        assert.equal(await page.locator(".route-layer polyline").count(), 2);
        await page.getByLabel("Sesión del recorrido").selectOption("first");
        assert.equal(await page.locator(".route-layer polyline").count(), 1);
        assert.equal(await page.locator(".route-layer polyline").first().getAttribute("points"), "0,0 100,-200");
        await page.getByLabel("Sesión del recorrido").selectOption("all");
        assert.equal(await page.locator(".route-layer polyline").count(), 3);
        await page.getByLabel("Recorrido", { exact: true }).uncheck();
        assert.equal(await page.locator(".route-layer polyline").count(), 0);
        await page.getByLabel("Recorrido", { exact: true }).check();
        await page.getByLabel("Cobertura estimada", { exact: true }).check();
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        await page.screenshot({ path: path.join(tmpdir(), "zk901-route-mobile.png"), fullPage: true });
        await page.setViewportSize({ width: 1280, height: 1000 });
        await page.screenshot({ path: path.join(tmpdir(), "zk901-route-desktop.png"), fullPage: true });
        await page.getByRole("button", { name: "Reiniciar reconstrucción", exact: true }).click();
        const clearCalls = () => page.evaluate(() => window.__zkWsCalls.filter(call => call.type === "liectroux_zk901/trajectory/clear").length);
        assert.equal(await clearCalls(), 0);
        await page.getByRole("button", { name: "Cancelar", exact: true }).click();
        assert.equal(await clearCalls(), 0);
        await page.getByRole("button", { name: "Reiniciar reconstrucción", exact: true }).click();
        await page.getByRole("button", { name: "Borrar recorridos", exact: true }).click();
        await page.waitForFunction(() => window.__zkWsCalls.some(call => call.type === "liectroux_zk901/trajectory/clear"));
        assert.equal(await page.locator(".route-layer polyline").count(), 0);

        const deniedPage = await context.newPage();
        await deniedPage.goto(origin);
        await deniedPage.addScriptTag({ url: `${origin}/card.js`, type: "module" });
        await deniedPage.evaluate(() => {
            window.__zkBackend.rejectSubscriptions(true);
            const card = document.createElement("liectroux-zk901-map-card");
            card.setConfig({ type: "custom:liectroux-zk901-map-card", entity: "vacuum.liectroux_zk901" });
            card.hass = window.hass;
            document.querySelector("main").append(card);
        });
        await deniedPage.getByText("La lectura y edición de zonas requiere permisos de administrador en Home Assistant.").waitFor();
        const oldApiPage = await context.newPage();
        await oldApiPage.goto(origin);
        await oldApiPage.addScriptTag({ url: `${origin}/card.js`, type: "module" });
        await oldApiPage.addScriptTag({ url: `${origin}/legacy-editor.js` });
        assert.equal(await oldApiPage.evaluate(() => !!customElements.get("liectroux-zk901-zone-editor")), true);
        await oldApiPage.evaluate(() => {
            window.__zkBackend.setApiVersion(2);
            const card = document.createElement("liectroux-zk901-map-card");
            card.setConfig({ type: "custom:liectroux-zk901-map-card", entity: "vacuum.liectroux_zk901" });
            card.hass = window.hass;
            document.querySelector("main").append(card);
        });
        await oldApiPage.getByText(/versión de API incompatible/).waitFor();
        assert.deepEqual(pageErrors, []);
    } finally {
        await context.close();
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
});
