import type { ZoneArea, ZonePose } from "../data/zk901";

export type Point = [number, number];

export interface WorldBounds {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
}

function isPoint(value: unknown): value is Point {
    return (
        Array.isArray(value) &&
        value.length === 2 &&
        Number.isSafeInteger(value[0]) &&
        Number.isSafeInteger(value[1])
    );
}

export function validVertices(value: unknown): value is Point[] {
    if (!Array.isArray(value) || value.length < 3 || value.length > 128 || !value.every(isPoint)) {
        return false;
    }
    const vertices = value as Point[];
    if (new Set(vertices.map(([x, y]) => `${x},${y}`)).size < 3) return false;
    if (vertices.some((point, index) => samePoint(point, vertices[(index + 1) % vertices.length]))) {
        return false;
    }
    const twiceArea = vertices.reduce((area, point, index) => {
        const next = vertices[(index + 1) % vertices.length];
        return area + point[0] * next[1] - next[0] * point[1];
    }, 0);
    if (!Number.isSafeInteger(twiceArea) || twiceArea === 0) return false;

    for (let first = 0; first < vertices.length; first += 1) {
        const a = vertices[first];
        const b = vertices[(first + 1) % vertices.length];
        for (let second = first + 1; second < vertices.length; second += 1) {
            if (second === first + 1 || (first === 0 && second === vertices.length - 1)) continue;
            const c = vertices[second];
            const d = vertices[(second + 1) % vertices.length];
            if (segmentsIntersect(a, b, c, d)) return false;
        }
    }
    return true;
}

function samePoint(a: Point, b: Point): boolean {
    return a[0] === b[0] && a[1] === b[1];
}

function orientation(a: Point, b: Point, c: Point): number {
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    return (cross > 0 ? 1 : 0) - (cross < 0 ? 1 : 0);
}

function onSegment(a: Point, b: Point, point: Point): boolean {
    return (
        Math.min(a[0], b[0]) <= point[0] &&
        point[0] <= Math.max(a[0], b[0]) &&
        Math.min(a[1], b[1]) <= point[1] &&
        point[1] <= Math.max(a[1], b[1])
    );
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
    const first = orientation(a, b, c);
    const second = orientation(a, b, d);
    const third = orientation(c, d, a);
    const fourth = orientation(c, d, b);
    if (first * second < 0 && third * fourth < 0) return true;
    return (
        (first === 0 && onSegment(a, b, c)) ||
        (second === 0 && onSegment(a, b, d)) ||
        (third === 0 && onSegment(c, d, a)) ||
        (fourth === 0 && onSegment(c, d, b))
    );
}

export function polygonCenter(vertices: Point[]): Point {
    const total = vertices.reduce(
        ([x, y], point) => [x + point[0], y + point[1]] as Point,
        [0, 0] as Point,
    );
    return [total[0] / vertices.length, total[1] / vertices.length];
}

export function createInitialRectangle(areas: ZoneArea[], pose: ZonePose | null): Point[] {
    const bounds = computeSceneBounds(areas, pose);
    const center = pose?.pos ?? [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2];
    const width = Math.max(120, Math.min((bounds.maxX - bounds.minX) * 0.28, 1800));
    const height = Math.max(120, Math.min((bounds.maxY - bounds.minY) * 0.28, 1800));
    const halfWidth = width / 2;
    const halfHeight = height / 2;
    return [
        [Math.round(center[0] - halfWidth), Math.round(center[1] - halfHeight)],
        [Math.round(center[0] + halfWidth), Math.round(center[1] - halfHeight)],
        [Math.round(center[0] + halfWidth), Math.round(center[1] + halfHeight)],
        [Math.round(center[0] - halfWidth), Math.round(center[1] + halfHeight)],
    ];
}

export function addVertex(vertices: Point[]): Point[] {
    if (vertices.length >= 128) return vertices;
    let longestIndex = 0;
    let longestDistance = -1;
    vertices.forEach((point, index) => {
        const next = vertices[(index + 1) % vertices.length];
        const distance = (next[0] - point[0]) ** 2 + (next[1] - point[1]) ** 2;
        if (distance > longestDistance) {
            longestDistance = distance;
            longestIndex = index;
        }
    });
    const point = vertices[longestIndex];
    const next = vertices[(longestIndex + 1) % vertices.length];
    const expanded = [...vertices];
    expanded.splice(longestIndex + 1, 0, [Math.round((point[0] + next[0]) / 2), Math.round((point[1] + next[1]) / 2)]);
    return expanded;
}

export function computeSceneBounds(
    areas: ZoneArea[],
    pose: ZonePose | null,
    expansion = 1,
): WorldBounds {
    const points: Point[] = [];
    areas.forEach(area => {
        if (validVertices(area.vertexs)) points.push(...area.vertexs);
    });
    if (pose && isPoint(pose.pos)) points.push(pose.pos);

    if (points.length === 0) {
        const center = pose?.pos ?? [0, 0];
        const radius = 1000 * Math.max(1, expansion);
        return {
            minX: center[0] - radius,
            maxX: center[0] + radius,
            minY: center[1] - radius,
            maxY: center[1] + radius,
        };
    }

    const raw = points.reduce(
        (bounds, [x, y]) => ({
            minX: Math.min(bounds.minX, x),
            maxX: Math.max(bounds.maxX, x),
            minY: Math.min(bounds.minY, y),
            maxY: Math.max(bounds.maxY, y),
        }),
        { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
    );
    const rawWidth = Math.max(1, raw.maxX - raw.minX);
    const rawHeight = Math.max(1, raw.maxY - raw.minY);
    const padding = Math.max(rawWidth, rawHeight, 200) * 0.18;
    const centerX = (raw.minX + raw.maxX) / 2;
    const centerY = (raw.minY + raw.maxY) / 2;
    const halfWidth = (rawWidth / 2 + padding) * Math.max(1, expansion);
    const halfHeight = (rawHeight / 2 + padding) * Math.max(1, expansion);
    return {
        minX: centerX - halfWidth,
        maxX: centerX + halfWidth,
        minY: centerY - halfHeight,
        maxY: centerY + halfHeight,
    };
}

export function moveVertices(vertices: Point[], dx: number, dy: number): Point[] {
    return vertices.map(([x, y]) => [Math.round(x + dx), Math.round(y + dy)]);
}

export function vertexValidationMessage(vertices: Point[]): string | null {
    if (!Array.isArray(vertices) || vertices.length < 3) return "La zona necesita al menos tres vértices.";
    if (vertices.length > 128) return "La zona supera el máximo de 128 vértices.";
    if (!validVertices(vertices)) return "Revisá el polígono: debe tener área y no cruzarse.";
    return null;
}
