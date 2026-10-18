import type { ApplyAreaEditRequest, ZoneArea } from "../data/zk901";
import { addVertex, type Point, validVertices, vertexValidationMessage } from "./zone-geometry";

export type AreaKind = "normal" | "depth" | "forbid";
export type DraftOperation = "create" | "update" | "delete";

export interface EditableArea extends Omit<ZoneArea, "id" | "vertexs"> {
    id: number | null;
    tag: string;
    active: AreaKind;
    vertexs: Point[];
}

interface DraftState {
    area: EditableArea | null;
    deleted: boolean;
}

function cloneArea(area: EditableArea | null): EditableArea | null {
    return area ? structuredClone(area) : null;
}

function sameValue(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

export class ZoneDraft {
    readonly baseMapId: number | string;
    readonly baseRevision: string;
    readonly operation: DraftOperation;
    readonly baseArea: EditableArea | null;
    area: EditableArea | null;
    deleted = false;
    private readonly history: DraftState[] = [];

    private constructor(
        baseMapId: number | string,
        baseRevision: string,
        operation: DraftOperation,
        baseArea: EditableArea | null,
        area: EditableArea | null,
    ) {
        this.baseMapId = baseMapId;
        this.baseRevision = baseRevision;
        this.operation = operation;
        this.baseArea = cloneArea(baseArea);
        this.area = cloneArea(area);
    }

    static create(
        mapId: number | string,
        revision: string,
        vertices: Point[],
    ): ZoneDraft {
        return new ZoneDraft(mapId, revision, "create", null, {
            id: null,
            name: "",
            tag: "Zona nueva",
            active: "normal",
            vertexs: structuredClone(vertices),
        });
    }

    static update(
        mapId: number | string,
        revision: string,
        area: ZoneArea,
    ): ZoneDraft {
        if (!Number.isSafeInteger(area.id) || area.id <= 0) {
            throw new Error("Solo se pueden editar zonas persistidas con ID positivo.");
        }
        const active = area.active;
        if (active !== "normal" && active !== "depth" && active !== "forbid") {
            throw new Error("Esta zona usa un tipo no compatible con el editor.");
        }
        if (!validVertices(area.vertexs)) {
            throw new Error("La geometría guardada no se puede editar con seguridad.");
        }
        const editable: EditableArea = {
            ...structuredClone(area),
            id: area.id,
            tag: typeof area.tag === "string" ? area.tag : "",
            active,
            vertexs: structuredClone(area.vertexs),
        };
        return new ZoneDraft(mapId, revision, "update", editable, editable);
    }

    get canUndo(): boolean {
        return this.history.length > 0;
    }

    get isDirty(): boolean {
        if (this.operation === "create" || this.deleted) return true;
        return !sameValue(this.area, this.baseArea);
    }

    get validationMessage(): string | null {
        if (this.deleted) return null;
        if (!this.area) return "No hay una zona en edición.";
        const tag = this.area.tag.trim();
        if (!tag) return "El nombre de la zona no puede estar vacío.";
        if (tag.length > 80) return "El nombre no puede superar 80 caracteres.";
        if (!["normal", "depth", "forbid"].includes(this.area.active)) {
            return "Elegí un tipo de zona compatible.";
        }
        return vertexValidationMessage(this.area.vertexs);
    }

    updateProperties(patch: { tag?: string; active?: AreaKind }): void {
        if (!this.area) return;
        const next = { ...this.area, ...patch };
        if (sameValue(next, this.area)) return;
        this.saveUndoPoint();
        this.area = next;
    }

    addVertex(): void {
        if (!this.area || this.area.vertexs.length >= 128) return;
        this.saveUndoPoint();
        this.area = { ...this.area, vertexs: addVertex(this.area.vertexs) };
    }

    removeVertex(index: number): void {
        if (!this.area || this.area.vertexs.length <= 3 || index < 0 || index >= this.area.vertexs.length) {
            return;
        }
        this.saveUndoPoint();
        this.area = {
            ...this.area,
            vertexs: this.area.vertexs.filter((_point, pointIndex) => pointIndex !== index),
        };
    }

    delete(): void {
        if (this.operation !== "update" || this.deleted) return;
        this.saveUndoPoint();
        this.deleted = true;
    }

    restoreFromUndo(state: DraftState): void {
        this.area = cloneArea(state.area);
        this.deleted = state.deleted;
    }

    undo(): boolean {
        const state = this.history.pop();
        if (!state) return false;
        this.restoreFromUndo(state);
        return true;
    }

    beginGesture(): DraftState {
        return this.snapshot();
    }

    moveVertex(index: number, point: Point): void {
        if (!this.area || index < 0 || index >= this.area.vertexs.length) return;
        const vertexs = this.area.vertexs.map((current, pointIndex) =>
            pointIndex === index ? [Math.round(point[0]), Math.round(point[1])] as Point : current,
        );
        this.area = { ...this.area, vertexs };
    }

    movePolygon(dx: number, dy: number): void {
        if (!this.area) return;
        this.area = {
            ...this.area,
            vertexs: this.area.vertexs.map(([x, y]) => [Math.round(x + dx), Math.round(y + dy)] as Point),
        };
    }

    finishGesture(before: DraftState): void {
        if (!sameValue(before.area, this.area) || before.deleted !== this.deleted) {
            this.history.push({ area: cloneArea(before.area), deleted: before.deleted });
        }
    }

    toRequest(entityId: string): ApplyAreaEditRequest {
        const operation = this.deleted ? "delete" : this.operation;
        const request: ApplyAreaEditRequest = {
            entity_id: entityId,
            base_map_id: this.baseMapId,
            base_revision: this.baseRevision,
            operation,
        };
        if (operation === "delete") {
            if (!this.baseArea?.id) throw new Error("No hay una zona para eliminar.");
            request.area_id = this.baseArea.id;
        } else {
            if (!this.area) throw new Error("No hay una zona para guardar.");
            request.tag = this.area.tag.trim();
            request.active = this.area.active;
            request.vertexs = this.area.vertexs.map(([x, y]) => [Math.round(x), Math.round(y)]);
            if (operation === "update") {
                if (!this.area.id) throw new Error("La zona a editar no tiene un ID válido.");
                request.area_id = this.area.id;
            }
        }
        return request;
    }

    private snapshot(): DraftState {
        return { area: cloneArea(this.area), deleted: this.deleted };
    }

    private saveUndoPoint(): void {
        this.history.push(this.snapshot());
    }
}
