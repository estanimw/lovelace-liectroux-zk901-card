"""Integración local Liectroux ZK901."""

from __future__ import annotations

import logging

import voluptuous as vol
from homeassistant.components.vacuum import DOMAIN as VACUUM_DOMAIN
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryNotReady
from homeassistant.helpers import config_validation as cv, service
from homeassistant.helpers.typing import ConfigType

from .client import ZK901Client, ZK901Error
from .const import (
    ATTR_AREA_ID,
    ATTR_TAG,
    CONF_DEVICE_ID,
    CONF_HOST,
    CONF_LOCAL_KEY,
    CONF_SN,
    CONF_UID,
    DOMAIN,
    SERVICE_CLEAN_AREA,
)
from .coordinator import ZK901Coordinator
from .zone_editor import register_zone_editor_commands

_LOGGER = logging.getLogger(__name__)

PLATFORMS = (
    Platform.VACUUM,
    Platform.SENSOR,
    Platform.SELECT,
    Platform.BUTTON,
)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Registra la acción de zona incluso si aún no se cargó el robot."""
    register_zone_editor_commands(hass)
    service.async_register_platform_entity_service(
        hass,
        DOMAIN,
        SERVICE_CLEAN_AREA,
        entity_domain=VACUUM_DOMAIN,
        schema={
            vol.Optional(ATTR_AREA_ID): vol.All(vol.Coerce(int), vol.Range(min=1)),
            vol.Optional(ATTR_TAG): cv.string,
        },
        func="async_clean_persisted_area",
    )
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Abre la única conexión de esta aspiradora y carga sus entidades."""
    data = entry.data
    client = ZK901Client(
        device_id=data[CONF_DEVICE_ID],
        address=data[CONF_HOST],
        local_key=data[CONF_LOCAL_KEY],
        uid=data[CONF_UID],
        sn=data[CONF_SN],
    )
    coordinator = ZK901Coordinator(hass, client)
    client.set_status_listener(coordinator.handle_status)
    try:
        await hass.async_add_executor_job(client.connect)
        await coordinator.async_config_entry_first_refresh()
    except Exception as err:
        await hass.async_add_executor_job(client.close)
        if isinstance(err, (ZK901Error, ConfigEntryNotReady)):
            raise ConfigEntryNotReady("La aspiradora no está disponible") from err
        raise
    client.set_connection_listener(coordinator.handle_connection)
    entry.runtime_data = coordinator
    try:
        await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    except Exception:
        await hass.async_add_executor_job(client.close)
        raise
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Cierra el socket al quitar o recargar la integración."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        coordinator: ZK901Coordinator = entry.runtime_data
        await hass.async_add_executor_job(coordinator.client.close)
    else:
        _LOGGER.debug("no se pudieron descargar las plataformas")
    return unload_ok
