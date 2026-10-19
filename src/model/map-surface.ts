/** Local SVG image for the community map container; protocol coordinates stay in the adapter. */
import type { CardSnapshot } from "../data/zk901";
import type { WorldBounds, Point } from "./zone-geometry";

export class MapSurface {
    readonly width = 1000;
    readonly height: number;
    readonly scale: number;
    constructor(readonly bounds: WorldBounds) {
        this.scale = this.width / Math.max(1, bounds.maxX - bounds.minX);
        this.height = Math.max(1, (bounds.maxY - bounds.minY) * this.scale);
    }
    toPixel(point: Point): Point {
        return [(point[0] - this.bounds.minX) * this.scale, (this.bounds.maxY - point[1]) * this.scale];
    }
    toWorld(point: Point): Point {
        return [point[0] / this.scale + this.bounds.minX, this.bounds.maxY - point[1] / this.scale];
    }
    get calibration(): { vacuum: { x: number; y: number }; map: { x: number; y: number } }[] {
        return [
            [this.bounds.minX, this.bounds.minY],
            [this.bounds.maxX, this.bounds.minY],
            [this.bounds.minX, this.bounds.maxY],
        ].map(([x, y]) => {
            const p = this.toPixel([x, y]);
            return { vacuum: { x, y }, map: { x: p[0], y: p[1] } };
        });
    }
    svg(
        snapshot: CardSnapshot | undefined,
        showRoute: boolean,
        showCoverage: boolean,
        session: string,
        colors: { background: string; route: string; coverage: string; robot: string },
    ): string {
        const point = (p: number[]): string => this.toPixel(p as Point).join(",");
        const route = snapshot?.trajectory;
        const sessions = route?.sessions ?? [];
        const selected =
            session === "all"
                ? sessions
                : session === "latest"
                ? sessions.slice(-1)
                : sessions.filter(s => s.id === session);
        const coverage = route?.coverage;
        const size = coverage?.cell_size ?? 100;
        const cells = showCoverage
            ? (coverage?.cells ?? [])
                  .map(([x, y]) => {
                      const p = this.toPixel([x * size, (y + 1) * size]);
                      const step = size * this.scale;
                      return `M${p[0]},${p[1]}h${step}v${step}h${-step}z`;
                  })
                  .join(" ")
            : "";
        const paths = showRoute
            ? selected
                  .flatMap(s =>
                      s.segments.map(
                          seg =>
                              `<polyline points="${seg.points.map(point).join(" ")}" fill="none" stroke="${
                                  seg.kind === "return" ? "#d9a441" : seg.kind === "cleaning" ? colors.route : "#8c96a1"
                              }" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" ${
                                  seg.kind === "cleaning" ? "" : 'stroke-dasharray="5 5"'
                              }/>`,
                      ),
                  )
                  .join("")
            : "";
        const pose = snapshot?.pose;
        const p = pose ? this.toPixel(pose.pos) : null;
        const age = pose?.observed_at ? Date.now() - Date.parse(pose.observed_at) : Number.POSITIVE_INFINITY;
        const stale = !snapshot?.available || !Number.isFinite(age) || age > 60000;
        const robot = p
            ? `<g opacity="${stale ? ".45" : "1"}" transform="translate(${p[0]},${p[1]}) rotate(${
                  ((-(pose?.phi ?? 0) / 1000) * 180) / Math.PI
              })"><circle r="14" fill="${
                  colors.robot
              }" stroke="#fff" stroke-width="3"/><path d="M0,-9 L5,4 L0,1 L-5,4 Z" fill="#fff"/></g>`
            : "";
        return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}"><rect width="100%" height="100%" fill="${colors.background}"/><path d="${cells}" fill="${colors.coverage}" opacity=".24"/>${paths}${robot}</svg>`;
    }
}
