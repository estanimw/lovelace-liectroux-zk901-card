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
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.typing import ConfigType

from .client import ZK901Client, ZK901Error
from .const import (
    ATTR_AREA_ID,
    ATTR_AREA_IDS,
    ATTR_TAG,
    CONF_DEVICE_ID,
    CONF_HOST,
    CONF_LOCAL_KEY,
    CONF_SN,
    CONF_UID,
    DOMAIN,
    SERVICE_CLEAN_AREA,
    SERVICE_CLEAN_AREAS,
)
from .coordinator import ZK901Coordinator, card_update_signal
from .zone_editor import register_zone_editor_commands

_LOGGER = logging.getLogger(__name__)


def _positive_area_ids(value: object) -> list[int]:
    if not isinstance(value, list) or not value:
        raise vol.Invalid("area_ids debe ser una lista no vacía")
    seen: set[int] = set()
    for area_id in value:
        if (
            not isinstance(area_id, int)
            or isinstance(area_id, bool)
            or area_id <= 0
        ):
            raise vol.Invalid("cada area_id debe ser un entero positivo")
        if area_id in seen:
            raise vol.Invalid(f"el area_id {area_id} está duplicado")
        seen.add(area_id)
    return value


def _positive_area_id(value: object) -> object:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value <= 0
    ):
        raise vol.Invalid("area_id debe ser un entero positivo")
    return value

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
            vol.Optional(ATTR_AREA_ID): _positive_area_id,
            vol.Optional(ATTR_TAG): cv.string,
        },
        func="async_clean_persisted_area",
    )
    service.async_register_platform_entity_service(
        hass,
        DOMAIN,
        SERVICE_CLEAN_AREAS,
        entity_domain=VACUUM_DOMAIN,
        schema={vol.Required(ATTR_AREA_IDS): _positive_area_ids},
        func="async_clean_persisted_areas",
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
    coordinator = ZK901Coordinator(hass, client, entry)
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
    # Existing WebSocket subscriptions survive an integration reload.
    async_dispatcher_send(hass, card_update_signal(entry.entry_id))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Cierra el socket al quitar o recargar la integración."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        coordinator: ZK901Coordinator = entry.runtime_data
        coordinator.mark_unloaded()
        await hass.async_add_executor_job(coordinator.client.close)
    else:
        _LOGGER.debug("no se pudieron descargar las plataformas")
    return unload_ok
