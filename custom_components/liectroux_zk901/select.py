"""Selector de la zona persistida que se va a limpiar."""

from __future__ import annotations

from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .client import area_option, cleanable_areas
from .entity import ZK901Entity

_EMPTY_OPTION = "Sin zonas limpiables"


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Publica el selector de zona. Elegir una zona no inicia la limpieza."""
    async_add_entities([ZK901ZoneSelect(entry.runtime_data, entry)])


class ZK901ZoneSelect(ZK901Entity, SelectEntity):
    """Zonas del catálogo que no están prohibidas."""

    _attr_translation_key = "zone"
    _attr_icon = "mdi:shape-polygon-plus"

    def __init__(self, coordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry)
        self._attr_unique_id = f"{entry.entry_id}-zone"

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self._ensure_selection()

    @callback
    def _handle_coordinator_update(self) -> None:
        self._ensure_selection()
        super()._handle_coordinator_update()

    def _choices(self) -> list[dict]:
        _status, areas = self._parts()
        return cleanable_areas(areas.get("areas"))

    def _ensure_selection(self) -> None:
        ids = [area["id"] for area in self._choices()]
        if self.coordinator.selected_area_id not in ids:
            self.coordinator.selected_area_id = ids[0] if ids else None

    @property
    def options(self) -> list[str]:
        labels = [area_option(area) for area in self._choices()]
        return labels or [_EMPTY_OPTION]

    @property
    def current_option(self) -> str | None:
        selected = self.coordinator.selected_area_id
        for area in self._choices():
            if area.get("id") == selected:
                return area_option(area)
        if not self._choices():
            return _EMPTY_OPTION
        return None

    @property
    def available(self) -> bool:
        return super().available and bool(self._choices())

    async def async_select_option(self, option: str) -> None:
        """Guarda la zona elegida. No envía el comando de limpieza."""
        for area in self._choices():
            if area_option(area) == option:
                self.coordinator.selected_area_id = area["id"]
                self.async_write_ha_state()
                return
        raise ServiceValidationError("esa zona no está disponible para limpiar")
