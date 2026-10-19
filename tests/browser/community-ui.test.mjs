import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { installBackend, installHaElements } from "./fixture.mjs";

test(
    "community composition, live map gestures, editor alignment, resource lifecycle and reference previews",
    { timeout: 60000 },
    async () => {
        const bundle = await readFile(new URL("../../dist/liectroux-zk901-map-card.js", import.meta.url));
        const server = createServer((req, res) => {
            res.setHeader("content-type", req.url === "/card.js" ? "text/javascript" : "text/html");
            res.end(
                req.url === "/card.js"
                    ? bundle
                    : '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><main></main>',
            );
        });
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        const origin = `http://127.0.0.1:${server.address().port}`;
        const browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, hasTouch: true });
        await context.addInitScript(installHaElements);
        await context.addInitScript(installBackend, { storageKey: "community-ui" });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", e => errors.push(e.message));
        const previews = path.join(tmpdir(), "zk901-community-preview");
        await mkdir(previews, { recursive: true });
        try {
            await page.goto(origin);
            await page.evaluate(async () => {
                // A co-installed community card owns these names. The fork must not overwrite them.
                customElements.define("pinch-zoom", class extends HTMLElement {});
                customElements.define("xvmc-icons-wrapper", class extends HTMLElement {});
                const create = URL.createObjectURL.bind(URL),
                    revoke = URL.revokeObjectURL.bind(URL);
                window.__liveUrls = new Set();
                URL.createObjectURL = blob => {
                    const url = create(blob);
                    window.__liveUrls.add(url);
                    return url;
                };
                URL.revokeObjectURL = url => {
                    window.__liveUrls.delete(url);
                    revoke(url);
                };
                const module = await import("/card.js");
                window.__communityBase = module.CommunityMapCard;
                const card = document.createElement("liectroux-zk901-map-card");
                card.setConfig({ type: "custom:liectroux-zk901-map-card", entity: "vacuum.liectroux_zk901" });
                card.hass = window.hass;
                document.querySelector("main").append(card);
                window.__card = card;
            });
            const card = page.locator("liectroux-zk901-map-card");
            await card.locator(".room-outline").first().waitFor();
            await page.waitForFunction(
                () => window.__card.shadowRoot.querySelector("#map-image").naturalWidth === 1000,
            );
            assert.equal(await page.evaluate(() => window.__card instanceof window.__communityBase), true);
            assert.equal(await card.locator("zk901-community-icons-wrapper").count(), 1);
            assert.equal(await card.locator("zk901-community-tiles-wrapper").count(), 1);
            assert.equal(await card.locator(".zk-secondary").count(), 0);
            assert.equal(await card.getByText(/API 1/).count(), 0);

            const zoom = () => page.evaluate(() => window.__card.shadowRoot.querySelector("#map-zoomer").scale);
            await page.getByRole("button", { name: "Aumentar zoom", exact: true }).click();
            const scale = await zoom();
        const transform = await page.evaluate(() => { const z = window.__card.shadowRoot.querySelector("#map-zoomer"); return { x: z.x, y: z.y }; });
            assert.ok(scale > 1);
            const source = await card.locator("#map-image").getAttribute("src");
            await page.evaluate(() =>
                window.__zkBackend.setPose({ pos: [500, 350], phi: 700, observed_at: new Date().toISOString() }),
            );
            await page.waitForFunction(src => window.__card.shadowRoot.querySelector("#map-image").src !== src, source);
            assert.equal(await zoom(), scale);
            const stableSource = await card.locator("#map-image").getAttribute("src");
            await page.evaluate(() =>
                window.__zkBackend.setPose({ pos: [500, 350], phi: 700, observed_at: new Date(Date.now() - 5000).toISOString() }),
            );
            await page.waitForTimeout(60);
            assert.equal(await card.locator("#map-image").getAttribute("src"), stableSource);
            await page.evaluate(() =>
                window.__zkBackend.setPose({ pos: [500, 350], phi: 700, observed_at: new Date().toISOString() }),
            );
            await page.getByRole("button", { name: "Bloquear o desbloquear mapa" }).click();
            await card.locator("#map-zoomer").hover();
            await page.mouse.wheel(0, -200);
            assert.equal(await zoom(), scale);
            await page.getByRole("button", { name: "Bloquear o desbloquear mapa" }).press("Enter");
            await page.getByRole("button", { name: "Ajustar el plano", exact: true }).click();
            assert.equal(await zoom(), 1);
            // Pinch uses the restored pointer tracker, not the previous card's gesture code.
            const rect = await card.locator("#map-image").boundingBox();
            const cdp = await context.newCDPSession(page);
            const cx = rect.x + rect.width / 2,
                cy = rect.y + rect.height / 2;
            await cdp.send("Input.dispatchTouchEvent", {
                type: "touchStart",
                touchPoints: [
                    { x: cx - 30, y: cy, id: 0 },
                    { x: cx + 30, y: cy, id: 1 },
                ],
            });
            await cdp.send("Input.dispatchTouchEvent", {
                type: "touchMove",
                touchPoints: [
                    { x: cx - 60, y: cy, id: 0 },
                    { x: cx + 60, y: cy, id: 1 },
                ],
            });
            await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
            assert.ok((await zoom()) > 1);
            await page.getByRole("button", { name: "Ajustar el plano", exact: true }).click();

            await page.getByRole("button", { name: "Editar zonas", exact: true }).click();
            await card.locator("button.zone-row").filter({ hasText: "Cocina" }).click();
            const before = await page.evaluate(() => structuredClone(window.__card.controller._draft.area.vertexs));
            await page.getByRole("button", { name: "Reducir zoom", exact: true }).click();
        assert.notEqual(await zoom(), 1);
        const handle = card.getByRole("button", { name: "Vértice 1", exact: true });
            await handle.scrollIntoViewIfNeeded();
            const handleBox = await handle.boundingBox();
            await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
            await page.mouse.down();
            await page.mouse.move(handleBox.x + handleBox.width / 2 + 12, handleBox.y + handleBox.height / 2, {
                steps: 3,
            });
            await page.mouse.up();
            const after = await page.evaluate(() => window.__card.controller._draft.area.vertexs);
            assert.ok(after[0][0] > before[0][0]);
            assert.ok(Math.abs(after[0][1] - before[0][1]) <= 1);
            assert.equal(await page.evaluate(() => window.__zkWsCalls.filter(m => m.operation).length), 0);
            await page.getByRole("button", { name: "Deshacer", exact: true }).click();
            assert.deepEqual(await page.evaluate(() => window.__card.controller._draft.area.vertexs), before);
            await page.locator("input[maxlength='80']").fill("Borrador conservado");
            await page.getByRole("button", { name: "Capas e historial", exact: true }).click();
            assert.equal(await page.locator("input[maxlength='80']").inputValue(), "Borrador conservado");
            await card.screenshot({ path: path.join(previews, "editor-desktop.png") });
            await page.setViewportSize({ width: 390, height: 900 });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
            await card.screenshot({ path: path.join(previews, "editor-mobile.png") });
            await page.setViewportSize({ width: 1280, height: 1100 });
            page.once("dialog", d => d.accept());
            await page.getByRole("button", { name: "Descartar", exact: true }).click();
            await page.getByRole("button", { name: "Cerrar panel", exact: true }).click();
            assert.equal(await card.locator(".zk-secondary").count(), 0);
            await page.getByRole("button", { name: "Ajustar el plano", exact: true }).click();
        // Build comparable reference and adaptation images from the same SVG and snapshot.
            await page.evaluate(async () => {
                const card = window.__card;
                card.controller._message = "";
                const pose = window.__zkBackend.getState().pose;
                window.__zkBackend.setTrajectory({
                    current_id: "preview",
                    updated_at: new Date().toISOString(),
                    error: null,
                    capturing: false,
                    interval_seconds: 20,
                    sessions: [
                        {
                            id: "preview",
                            started_at: "2026-10-19T10:00:00Z",
                            ended_at: null,
                            incomplete: false,
                            segments: [
                                {
                                    kind: "cleaning",
                                    points: [
                                        [100, 100],
                                        [700, 100],
                                        [700, 200],
                                        [100, 200],
                                        [100, 300],
                                        [700, 300],
                                    ],
                                },
                            ],
                        },
                    ],
                    coverage: {
                        cell_size: 100,
                        cells: Array.from({ length: 28 }, (_, i) => [i % 7, Math.floor(i / 7)]),
                    },
                });
                await card.updateComplete;
                class Reference extends window.__communityBase {
                    _getIconsAndTiles(config) {
                        return Promise.resolve([config.icons ?? [], config.tiles ?? []]);
                    }
                    _actionHandler() {
                        return () => {};
                    }
                }
                customElements.define("xiaomi-vacuum-map-card", Reference);
                const reference = document.createElement("xiaomi-vacuum-map-card");
                const s = card.controller._snapshot;
                reference.setConfig({
                    type: "custom:xiaomi-vacuum-map-card",
                    title: "ZK901",
                    entity: "vacuum.liectroux_zk901",
                    language: "es",
                    map_source: { image: card._getMapSrc() },
                    calibration_source: { calibration_points: card._getCalibration() },
                    map_modes: [
                        {
                            name: "Zonas",
                            icon: "mdi:floor-plan",
                            selection_type: "ROOM",
                            service_call_schema: { service: "liectroux_zk901.clean_areas" },
                            predefined_selections: s.catalog.areas
                                .filter(a => a.id > 0 && a.vertexs?.length >= 3)
                                .map(a => ({
                                    id: a.id,
                                    outline: a.vertexs,
                                    label: {
                                        text: a.tag,
                                        x: a.vertexs.reduce((n, p) => n + p[0], 0) / a.vertexs.length,
                                        y: a.vertexs.reduce((n, p) => n + p[1], 0) / a.vertexs.length,
                                    },
                                })),
                        },
                    ],
                    icons: card._getCurrentPreset().icons,
                    tiles: card._getCurrentPreset().tiles,
                    internal_variables: card.internalVariables,
                });
                reference.hass = window.hass;
                reference.style.cssText = card.style.cssText;
                const main = document.querySelector("main");
                main.style.cssText =
                    "max-width:1120px;display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start";
                main.prepend(reference);
                window.__reference = reference;
            });
            await page.locator("xiaomi-vacuum-map-card #map-image").waitFor();
            await page.waitForTimeout(150);
            await card.locator(".toast").waitFor({ state: "hidden" });
            await page.screenshot({ path: path.join(previews, "comparison-desktop.png"), fullPage: true });
            await card.screenshot({ path: path.join(previews, "card-desktop.png") });
            await card.getByRole("button", { name: "Cocina, Normal", exact: true }).click();
            await page.locator("xiaomi-vacuum-map-card").getByRole("button", { name: "Cocina", exact: true }).click();
            await card.locator(".toast").waitFor({ state: "hidden" });
            await page.screenshot({ path: path.join(previews, "comparison-selected.png"), fullPage: true });
            await card.getByRole("button", { name: "Vaciar selección", exact: true }).click();
            for (const width of [360, 390]) {
                await page.evaluate(() => {
                    window.__reference.style.display = "none";
                    document.querySelector("main").style.display = "block";
                });
                await page.setViewportSize({ width, height: 900 });
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
                await card.screenshot({ path: path.join(previews, `card-mobile-${width}.png`) });
            }
            await page.evaluate(() => {
                document.documentElement.style.setProperty("--primary-background-color", "#111820");
                document.documentElement.style.setProperty("--secondary-background-color", "#25313a");
                document.documentElement.style.setProperty("--card-background-color", "#1b252d");
                document.documentElement.style.setProperty("--slider-secondary-color", "#344955");
                document.documentElement.style.setProperty("--primary-text-color", "#eef5f5");
                document.documentElement.style.setProperty("--secondary-text-color", "#a8bdc6");
            });
            await page.waitForTimeout(50);
            await card.screenshot({ path: path.join(previews, "card-mobile-dark.png") });
            // A full bounded history must remain a single local image, not thousands of DOM nodes.
            await page.evaluate(() =>
                window.__zkBackend.setTrajectory({
                    current_id: "large",
                    updated_at: new Date().toISOString(),
                    error: null,
                    capturing: true,
                    interval_seconds: 20,
                    sessions: [
                        {
                            id: "large",
                            started_at: "2026-10-19",
                            ended_at: null,
                            incomplete: false,
                            segments: [
                                {
                                    kind: "cleaning",
                                    points: Array.from({ length: 30000 }, (_, i) => [
                                        (i % 300) * 10,
                                        Math.floor(i / 300) * 10,
                                    ]),
                                },
                            ],
                        },
                    ],
                    coverage: {
                        cell_size: 100,
                        cells: Array.from({ length: 30000 }, (_, i) => [i % 300, Math.floor(i / 300)]),
                    },
                }),
            );
            await page.waitForTimeout(200);
            assert.ok(await page.evaluate(() => window.__liveUrls.size <= 3));
            assert.ok((await card.locator("#svg-wrapper *").count()) < 100);
            assert.equal(await page.evaluate(() => window.__zkBackend.subscriberCount()), 1);
            assert.equal(await page.evaluate(() => window.__zkCalls.length), 0);
            await page.evaluate(() => {
                window.__card.remove();
                window.__reference.remove();
            });
            assert.equal(await page.evaluate(() => window.__liveUrls.size), 0);
            assert.equal(await page.evaluate(() => window.__zkBackend.subscriberCount()), 0);
            assert.deepEqual(errors, []);
        } catch (e) {
            console.log(
                "UI verification errors",
                errors,
                (await page.locator("xiaomi-vacuum-map-card").count())
                    ? await page
                          .locator("xiaomi-vacuum-map-card")
                          .evaluate(node => node.shadowRoot?.textContent.slice(0, 300))
                    : "",
            );
            await page.screenshot({ path: path.join(previews, "failure.png"), fullPage: true });
            throw e;
        } finally {
            await context.close();
            await browser.close();
            await new Promise(resolve => server.close(resolve));
        }
    },
);
