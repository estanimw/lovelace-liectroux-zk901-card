import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { applyToPoint, fromTriangles } from "transformation-matrix";
const compiled = ts.transpileModule(readFileSync(new URL("../../src/model/map-surface.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const exports = {};
new Function("exports", compiled)(exports);
const { MapSurface } = exports;

test("generated frame and community affine converter agree in both directions", () => {
    const surface = new MapSurface({ minX: -2600, minY: -4600, maxX: 3200, maxY: 4000 });
    const calibration = surface.calibration;
    const transform = fromTriangles(
        calibration.map(p => p.vacuum),
        calibration.map(p => p.map),
    );
    for (const point of [
        [-2600, -4600],
        [0, 0],
        [336, 1667],
        [3200, 4000],
    ]) {
        const pixel = surface.toPixel(point);
        const mapped = applyToPoint(transform, point);
        const world = surface.toWorld(pixel);
        for (let i = 0; i < 2; i++) {
            assert.ok(Math.abs(world[i] - point[i]) < 1e-7);
            assert.ok(Math.abs(mapped[i] - pixel[i]) < 1e-7);
        }
    }
});

test("map content ignores timestamps and renders only selected route and coverage", () => {
    const surface = new MapSurface({ minX: -100, minY: -100, maxX: 1000, maxY: 1000 });
    const snapshot = {
        available: true, pose: { pos: [0, 0], phi: 0, observed_at: "2099-01-01" },
        trajectory: {
            sessions: [
                {
                    id: "a",
                    segments: [
                        {
                            kind: "cleaning",
                            points: [
                                [0, 0],
                                [100, 200],
                            ],
                        },
                    ],
                },
                {
                    id: "b",
                    segments: [
                        {
                            kind: "return",
                            points: [
                                [300, 400],
                                [200, 300],
                            ],
                        },
                    ],
                },
            ],
            coverage: { cell_size: 100, cells: [[0, 0]] },
        },
    };
    const colors = { background: "#fff", route: "#090", coverage: "#090", robot: "#090" };
    const svg = surface.svg(snapshot, true, true, "latest", colors);
    const later = structuredClone(snapshot);
    later.pose.observed_at = "2099-02-01";
    assert.equal(surface.svg(later, true, true, "latest", colors), svg);
    assert.equal((svg.match(/<polyline/g) ?? []).length, 1);
    assert.equal((surface.svg(snapshot, true, false, "all", colors).match(/<polyline/g) ?? []).length, 2);
    assert.equal((surface.svg(snapshot, false, false, "all", colors).match(/<polyline/g) ?? []).length, 0);
    assert.ok(svg.includes('stroke-dasharray="5 5"'));
    assert.ok(!svg.includes("observed_at"));
});

test("last known or disconnected pose is visibly distinct from a fresh pose", () => {
    const surface = new MapSurface({ minX: -100, minY: -100, maxX: 1000, maxY: 1000 });
    const colors = { background: "#fff", route: "#090", coverage: "#090", robot: "#090" };
    const snapshot = { available: true, pose: { pos: [0, 0], phi: 0, observed_at: "2099-01-01" } };
    assert.ok(surface.svg(snapshot, false, false, "latest", colors).includes('opacity="1"'));
    snapshot.pose.observed_at = "2000-01-01";
    assert.ok(surface.svg(snapshot, false, false, "latest", colors).includes('opacity=".45"'));
    snapshot.pose.observed_at = "2099-01-01";
    snapshot.available = false;
    assert.ok(surface.svg(snapshot, false, false, "latest", colors).includes('opacity=".45"'));
});
