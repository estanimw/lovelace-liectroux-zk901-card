"""Sensores leídos del estado compartido."""

from __future__ import annotations

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import PERCENTAGE
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .entity import ZK901Entity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Publica la batería. Tiempo y área no tienen unidad confirmada."""
    async_add_entities([ZK901BatterySensor(entry.runtime_data, entry)])


class ZK901BatterySensor(ZK901Entity, SensorEntity):
    """Porcentaje de batería informado en ``elec``."""

    _attr_translation_key = "battery"
    _attr_device_class = SensorDeviceClass.BATTERY
    _attr_native_unit_of_measurement = PERCENTAGE
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_suggested_display_precision = 0

    def __init__(self, coordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry)
        self._attr_unique_id = f"{entry.entry_id}-battery"

    @property
    def native_value(self) -> int | float | None:
        value = self._parts()[0].get("elec")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        return value

    @property
    def available(self) -> bool:
        return super().available and self.native_value is not None
