"""WebSocket API used by the visual zone editor card."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv, entity_registry as er
from homeassistant.helpers.dispatcher import async_dispatcher_connect

from .client import (
    ZK901AreaConflict,
    ZK901AreaUncertain,
    ZK901Error,
    ZK901ProtocolError,
    area_catalog_revision,
)
from .const import DOMAIN
from .coordinator import ZK901Coordinator, card_update_signal

_GET_TYPE = f"{DOMAIN}/zone_editor/get"
_APPLY_TYPE = f"{DOMAIN}/zone_editor/apply"
_CARD_SUBSCRIBE_TYPE = f"{DOMAIN}/card/subscribe"
_CARD_REFRESH_TYPE = f"{DOMAIN}/card/refresh"


def _not_bool(value: object) -> object:
    if isinstance(value, bool):
        raise vol.Invalid("boolean is not a map ID")
    return value


def _positive_area_id(value: object) -> object:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value <= 0
    ):
        raise vol.Invalid("area_id debe ser un entero positivo")
    return value


_GET_SCHEMA = {
    vol.Required("type"): _GET_TYPE,
    vol.Required("entity_id"): cv.entity_id,
}

_APPLY_SCHEMA = {
    vol.Required("type"): _APPLY_TYPE,
    vol.Required("entity_id"): cv.entity_id,
    vol.Required("base_map_id"): vol.All(vol.Any(str, int), _not_bool),
    vol.Required("base_revision"): vol.Match(r"^[0-9a-f]{64}$"),
    vol.Required("operation"): vol.In({"create", "update", "delete"}),
    vol.Optional("area_id"): _positive_area_id,
    vol.Optional("tag"): str,
    vol.Optional("active"): str,
    vol.Optional("vertexs"): list,
}

_CARD_SUBSCRIBE_SCHEMA = {
    vol.Required("type"): _CARD_SUBSCRIBE_TYPE,
    vol.Required("entity_id"): cv.entity_id,
}

_CARD_REFRESH_SCHEMA = {
    vol.Required("type"): _CARD_REFRESH_TYPE,
    vol.Required("entity_id"): cv.entity_id,
}


def register_zone_editor_commands(hass: HomeAssistant) -> None:
    """Register the editor API once when the integration domain is set up."""
    websocket_api.async_register_command(hass, websocket_get_area_catalog)
    websocket_api.async_register_command(hass, websocket_apply_area_edit)
    websocket_api.async_register_command(hass, websocket_subscribe_card)
    websocket_api.async_register_command(hass, websocket_refresh_card)
    websocket_api.async_register_command(hass, websocket_clear_trajectory)


def _coordinator_for_entity(
    hass: HomeAssistant, entity_id: str
) -> ZK901Coordinator | None:
    if not entity_id.startswith("vacuum."):
        return None
    registry_entry = er.async_get(hass).entities.get(entity_id)
    if registry_entry is None or registry_entry.platform != DOMAIN:
        return None
    config_entry = hass.config_entries.async_get_entry(
        registry_entry.config_entry_id
    )
    if config_entry is None:
        return None
    coordinator: Any = getattr(config_entry, "runtime_data", None)
    if not isinstance(coordinator, ZK901Coordinator):
        return None
    return coordinator


def _send(connection: websocket_api.ActiveConnection, msg: dict, result: dict) -> None:
    connection.send_result(msg["id"], result)


@websocket_api.require_admin
@websocket_api.websocket_command(_GET_SCHEMA)
@websocket_api.async_response
async def websocket_get_area_catalog(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Read a fresh catalog and the most recently observed robot pose."""
    coordinator = _coordinator_for_entity(hass, msg["entity_id"])
    if coordinator is None:
        _send(connection, msg, {"ok": False, "error": "not_found"})
        return

    try:
        catalog = await hass.async_add_executor_job(
            coordinator.client.get_areas, 10.0
        )
        revision = area_catalog_revision(catalog)
    except ZK901ProtocolError:
        _send(connection, msg, {"ok": False, "error": "invalid_catalog"})
        return
    except ZK901Error:
        _send(connection, msg, {"ok": False, "error": "unavailable"})
        return
    except Exception:
        _send(connection, msg, {"ok": False, "error": "invalid_catalog"})
        return

    coordinator.set_area_catalog(catalog)
    _send(
        connection,
        msg,
        {
            "ok": True,
            "map_id": catalog["map_id"],
            "revision": revision,
            "areas": catalog["areas"],
            "pose": coordinator.editor_pose(),
            "observed_at": coordinator.areas_observed_at,
        },
    )


@websocket_api.require_admin
@websocket_api.websocket_command(_CARD_SUBSCRIBE_SCHEMA)
@websocket_api.async_response
async def websocket_subscribe_card(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Subscribe to coordinator snapshots without adding a robot socket."""
    coordinator = _coordinator_for_entity(hass, msg["entity_id"])
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "ZK901 entity not found")
        return

    generation = uuid4().hex
    sequence = 0
    state = {"ready": False, "changed": False}

    def forward_update() -> None:
        nonlocal coordinator, generation, sequence
        current = _coordinator_for_entity(hass, msg["entity_id"])
        if current is not None and current is not coordinator:
            coordinator = current
            generation = uuid4().hex
            sequence = 0
        if not state["ready"]:
            state["changed"] = True
            return
        sequence += 1
        connection.send_event(
            msg["id"],
            coordinator.card_snapshot(
                entity_id=msg["entity_id"],
                generation=generation,
                sequence=sequence,
            ),
        )

    unsubscribe = async_dispatcher_connect(
        hass, card_update_signal(coordinator.entry_id), forward_update
    )
    connection.subscriptions[msg["id"]] = unsubscribe

    try:
        catalog = await hass.async_add_executor_job(
            coordinator.client.get_areas, 10.0
        )
        coordinator.set_area_catalog(catalog)
    except ZK901ProtocolError:
        coordinator.set_area_error("invalid_catalog")
    except ZK901Error:
        coordinator.set_area_error("unavailable")
    except Exception:
        coordinator.set_area_error("invalid_catalog")

    result = coordinator.card_snapshot(
        entity_id=msg["entity_id"], generation=generation, sequence=sequence
    )
    result["ok"] = True
    connection.send_result(msg["id"], result)
    state["ready"] = True
    if state["changed"]:
        state["changed"] = False
        forward_update()


@websocket_api.require_admin
@websocket_api.websocket_command(_CARD_REFRESH_SCHEMA)
@websocket_api.async_response
async def websocket_refresh_card(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Explicitly refresh 20001 and 21004 from the existing LAN client."""
    coordinator = _coordinator_for_entity(hass, msg["entity_id"])
    if coordinator is None:
        _send(connection, msg, {"ok": False, "error": "not_found"})
        return

    try:
        status = await hass.async_add_executor_job(coordinator.client.get_status, 10.0)
    except ZK901Error:
        _send(connection, msg, {"ok": False, "error": "unavailable"})
        return
    try:
        catalog = await hass.async_add_executor_job(
            coordinator.client.get_areas, 10.0
        )
    except ZK901ProtocolError:
        coordinator.set_status(status)
        coordinator.set_area_error("invalid_catalog")
        _send(connection, msg, {"ok": False, "error": "invalid_catalog"})
        return
    except ZK901Error:
        coordinator.set_status(status)
        coordinator.set_area_error("unavailable")
        _send(connection, msg, {"ok": False, "error": "unavailable"})
        return

    coordinator.set_status(status)
    coordinator.set_area_catalog(catalog)
    _send(
        connection,
        msg,
        {
            "ok": True,
            **coordinator.card_snapshot(
                entity_id=msg["entity_id"], generation=uuid4().hex, sequence=0
            ),
        },
    )


@websocket_api.require_admin
@websocket_api.websocket_command(_APPLY_SCHEMA)
@websocket_api.async_response
async def websocket_apply_area_edit(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Apply one validated edit against the catalog revision in the card."""
    coordinator = _coordinator_for_entity(hass, msg["entity_id"])
    if coordinator is None:
        _send(connection, msg, {"ok": False, "error": "not_found"})
        return

    try:
        result = await hass.async_add_executor_job(
            lambda: coordinator.client.apply_area_edit(
                base_map_id=msg["base_map_id"],
                base_revision=msg["base_revision"],
                operation=msg["operation"],
                area_id=msg.get("area_id"),
                tag=msg.get("tag"),
                active=msg.get("active"),
                vertexs=msg.get("vertexs"),
                timeout=10.0,
            )
        )
    except ZK901AreaConflict as err:
        coordinator.set_area_catalog(
            {"map_id": err.current["map_id"], "areas": err.current["areas"]}
        )
        _send(
            connection,
            msg,
            {
                "ok": False,
                "error": "conflict",
                "map_id": err.current["map_id"],
                "revision": err.current["revision"],
                "areas": err.current["areas"],
            },
        )
        return
    except ZK901AreaUncertain as err:
        _send(
            connection,
            msg,
            {"ok": False, "error": "uncertain", "phase": err.phase},
        )
        return
    except ValueError as err:
        _send(
            connection,
            msg,
            {"ok": False, "error": "invalid", "detail": str(err)},
        )
        return
    except ZK901ProtocolError as err:
        _send(
            connection,
            msg,
            {"ok": False, "error": "rejected", "detail": str(err)},
        )
        return
    except ZK901Error:
        _send(connection, msg, {"ok": False, "error": "unavailable"})
        return
    except Exception:
        _send(connection, msg, {"ok": False, "error": "failed"})
        return

    coordinator.set_area_catalog(
        {"map_id": result["map_id"], "areas": result["areas"]}
    )
    _send(
        connection,
        msg,
        {
            "ok": True,
            "map_id": result["map_id"],
            "revision": result["revision"],
            "areas": result["areas"],
            "operation": result["operation"],
            "area_id": result.get("area_id"),
            "observed_at": coordinator.areas_observed_at,
        },
    )


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/trajectory/clear", vol.Required("entity_id"): cv.entity_id})
@websocket_api.async_response
async def websocket_clear_trajectory(hass, connection, msg) -> None:
    """Explicitly discard stored routes and start a fresh coordinate epoch."""
    coordinator = _coordinator_for_entity(hass, msg["entity_id"])
    if coordinator is None:
        _send(connection, msg, {"ok": False, "error": "not_found"})
        return
    await coordinator.trajectory.clear()
    _send(connection, msg, {"ok": True})
