"""Acción para limpiar la zona elegida en el selector."""

from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .entity import ZK901Entity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Publica el botón que limpia la zona seleccionada."""
    async_add_entities([ZK901CleanZoneButton(entry.runtime_data, entry)])


class ZK901CleanZoneButton(ZK901Entity, ButtonEntity):
    """Limpia una sola zona persistida: la que está elegida en el selector."""

    _attr_translation_key = "clean_zone"
    _attr_icon = "mdi:broom"

    def __init__(self, coordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry)
        self._attr_unique_id = f"{entry.entry_id}-clean-zone"

    @property
    def available(self) -> bool:
        return super().available and self.coordinator.selected_area_id is not None

    async def async_press(self) -> None:
        area_id = self.coordinator.selected_area_id
        if area_id is None:
            raise ServiceValidationError("No hay una zona limpiable seleccionada")
        await self._async_command(self.coordinator.client.clean_area, area_id)
