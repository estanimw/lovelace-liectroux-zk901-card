import type { HomeAssistantFixed } from "../types/fixes";
import { INTEGRATION_DOMAIN } from "../const";

export const CARD_API_VERSION = 1;

export interface ZoneArea {
    id: number;
    tag?: string;
    name?: string;
    active?: string;
    vertexs?: number[][];
    [key: string]: unknown;
}

export interface ZonePose {
    pos: [number, number];
    phi: number | null;
    observed_at: string | null;
}

export interface RouteSession {
    id: string;
    started_at: string;
    ended_at: string | null;
    incomplete: boolean;
    segments: { kind: "cleaning" | "return" | "unknown"; points: number[][] }[];
}

export interface CardSnapshot {
    ok?: boolean;
    api_version: number;
    generation: string;
    sequence: number;
    entity_id: string;
    available: boolean;
    status: {
        battery: number | null;
        mode: string | null;
        sub_mode: string | null;
        cleaning_level: string | null;
        cleaning_level_kind: "suction" | "water" | null;
        error: unknown;
        observed_at: string | null;
    };
    pose: ZonePose | null;
    trajectory?: {
        sessions: RouteSession[];
        current_id: string | null;
        updated_at: string | null;
        error: string | null;
        capturing: boolean;
        interval_seconds: number;
        coverage?: { cell_size: number; cells: number[][] };
    };
    catalog: {
        map_id: number | string | null;
        revision: string | null;
        areas: ZoneArea[];
        observed_at: string | null;
        age_seconds: number | null;
        fresh: boolean;
        available: boolean;
        error: string | null;
    };
    capabilities: {
        subscribe: boolean;
        clean_areas: boolean;
        zone_edit: boolean;
        current_position: boolean;
        cleaning_level: boolean;
    };
}

export interface AreaCatalogResponse {
    ok: boolean;
    error?: string;
    detail?: string;
    map_id?: number | string;
    revision?: string;
    areas?: ZoneArea[];
    pose?: ZonePose | null;
    observed_at?: string | null;
}

export interface ApplyAreaEditRequest {
    entity_id: string;
    base_map_id: number | string;
    base_revision: string;
    operation: "create" | "update" | "delete";
    area_id?: number;
    tag?: string;
    active?: string;
    vertexs?: number[][];
}

export interface ApplyAreaEditResponse {
    ok: boolean;
    error?: string;
    detail?: string;
    phase?: string;
    map_id?: number | string;
    revision?: string;
    areas?: ZoneArea[];
    operation?: "create" | "update" | "delete";
    area_id?: number;
}

export function subscribeCard(
    hass: HomeAssistantFixed,
    entityId: string,
    callback: (snapshot: CardSnapshot) => void,
): Promise<() => void> {
    return hass.connection.subscribeMessage<CardSnapshot>(
        callback,
        { type: `${INTEGRATION_DOMAIN}/card/subscribe`, entity_id: entityId },
    );
}

export function refreshCard(
    hass: HomeAssistantFixed,
    entityId: string,
): Promise<CardSnapshot & { ok: boolean; error?: string }> {
    return hass.callWS({
        type: `${INTEGRATION_DOMAIN}/card/refresh`,
        entity_id: entityId,
    });
}

export function getAreaCatalog(
    hass: HomeAssistantFixed,
    entityId: string,
): Promise<AreaCatalogResponse> {
    return hass.callWS({
        type: `${INTEGRATION_DOMAIN}/zone_editor/get`,
        entity_id: entityId,
    });
}

export function applyAreaEdit(
    hass: HomeAssistantFixed,
    request: ApplyAreaEditRequest,
): Promise<ApplyAreaEditResponse> {
    return hass.callWS({
        type: `${INTEGRATION_DOMAIN}/zone_editor/apply`,
        ...request,
    });
}

export function callVacuumAction(
    hass: HomeAssistantFixed,
    entityId: string,
    service: "start" | "pause" | "stop" | "return_to_base" | "clean_spot" | "set_fan_speed",
    data: Record<string, unknown> = {},
): Promise<void> {
    return hass.callService("vacuum", service, { entity_id: entityId, ...data });
}

export function callCleanAreas(
    hass: HomeAssistantFixed,
    entityId: string,
    areaIds: number[],
): Promise<void> {
    return hass.callService(INTEGRATION_DOMAIN, "clean_areas", {
        entity_id: entityId,
        area_ids: areaIds,
    });
}

export function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    try {
        return JSON.stringify(error);
    } catch {
        return "Error desconocido";
    }
}
