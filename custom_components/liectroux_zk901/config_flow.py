"""Alta y actualización de credenciales de una ZK901."""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigFlow, SOURCE_RECONFIGURE
from homeassistant.helpers.selector import (
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)

from .client import (
    ZK901Client,
    ZK901ConnectionError,
    ZK901ProtocolError,
    ZK901Timeout,
)
from .const import (
    CONF_DEVICE_ID,
    CONF_HOST,
    CONF_LOCAL_KEY,
    CONF_SN,
    CONF_UID,
    DOMAIN,
)

_LOGGER = logging.getLogger(__name__)

_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_HOST): str,
        vol.Required(CONF_DEVICE_ID): str,
        vol.Required(CONF_LOCAL_KEY): TextSelector(
            TextSelectorConfig(type=TextSelectorType.PASSWORD)
        ),
        vol.Required(CONF_UID): str,
        vol.Required(CONF_SN): str,
    }
)


def _clean(user_input: dict[str, Any]) -> dict[str, str]:
    cleaned: dict[str, str] = {}
    for key in (CONF_HOST, CONF_DEVICE_ID, CONF_LOCAL_KEY, CONF_UID, CONF_SN):
        value = user_input.get(key)
        if not isinstance(value, str) or not value.strip():
            raise vol.Invalid("requerido")
        cleaned[key] = value.strip()
    return cleaned


def _validate(data: dict[str, str]) -> str | None:
    """Abre una sesión corta y pide un 20001. Devuelve la clave de error."""
    client = ZK901Client(
        device_id=data[CONF_DEVICE_ID],
        address=data[CONF_HOST],
        local_key=data[CONF_LOCAL_KEY],
        uid=data[CONF_UID],
        sn=data[CONF_SN],
    )
    try:
        client.connect()
        status = client.get_status(timeout=8)
    except ZK901Timeout:
        return "timeout"
    except ZK901ConnectionError as err:
        if err.code == "914":
            return "invalid_auth"
        return "cannot_connect"
    except ZK901ProtocolError:
        return "invalid_response"
    except Exception:
        _LOGGER.debug("la validación de la aspiradora falló", exc_info=True)
        return "unknown"
    finally:
        client.close()
    if not isinstance(status, dict) or not isinstance(status.get("mode"), str):
        return "invalid_response"
    return None


class ZK901ConfigFlow(ConfigFlow, domain=DOMAIN):
    """Configura una aspiradora y permite sustituir sus credenciales."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None):
        return await self._async_form("user", user_input)

    async def async_step_reconfigure(self, user_input: dict[str, Any] | None = None):
        return await self._async_form("reconfigure", user_input)

    async def _async_form(self, step_id: str, user_input: dict[str, Any] | None):
        errors: dict[str, str] = {}
        if user_input is not None:
            try:
                data = _clean(user_input)
            except vol.Invalid:
                errors["base"] = "unknown"
            else:
                error = await self.hass.async_add_executor_job(_validate, data)
                if error is None:
                    return await self._async_finish(data)
                errors["base"] = error

        suggested = None
        if step_id == "reconfigure" and user_input is None:
            suggested = dict(self._get_reconfigure_entry().data)
        schema = _SCHEMA
        if suggested is not None:
            schema = self.add_suggested_values_to_schema(_SCHEMA, suggested)
        return self.async_show_form(step_id=step_id, data_schema=schema, errors=errors)

    async def _async_finish(self, data: dict[str, str]):
        existing = await self.async_set_unique_id(data[CONF_SN])
        if self.source == SOURCE_RECONFIGURE:
            current = self._get_reconfigure_entry()
            if existing is not None and existing.entry_id != current.entry_id:
                return self.async_abort(reason="already_configured")
            return self.async_update_reload_and_abort(
                current,
                unique_id=data[CONF_SN],
                data=data,
                title="Liectroux ZK901",
            )
        if existing is not None:
            return self.async_abort(reason="already_configured")
        return self.async_create_entry(title="Liectroux ZK901", data=data)
