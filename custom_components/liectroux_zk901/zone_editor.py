"""WebSocket API used by the visual zone editor card."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv, entity_registry as er

from .client import (
    ZK901AreaConflict,
    ZK901AreaUncertain,
    ZK901Error,
    ZK901ProtocolError,
    area_catalog_revision,
)
from .const import DOMAIN
from .coordinator import ZK901Coordinator

_GET_TYPE = f"{DOMAIN}/zone_editor/get"
_APPLY_TYPE = f"{DOMAIN}/zone_editor/apply"


def _not_bool(value: object) -> object:
    if isinstance(value, bool):
        raise vol.Invalid("boolean is not a map ID")
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
    vol.Optional("area_id"): int,
    vol.Optional("tag"): str,
    vol.Optional("active"): str,
    vol.Optional("vertexs"): list,
}


def register_zone_editor_commands(hass: HomeAssistant) -> None:
    """Register the editor API once when the integration domain is set up."""
    websocket_api.async_register_command(hass, websocket_get_area_catalog)
    websocket_api.async_register_command(hass, websocket_apply_area_edit)


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
            "observed_at": datetime.now(timezone.utc).isoformat(),
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
        },
    )
