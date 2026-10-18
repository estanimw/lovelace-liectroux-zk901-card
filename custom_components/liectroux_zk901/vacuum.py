"""Entidad vacuum de la ZK901."""

from __future__ import annotations

from typing import Any

from homeassistant.components.vacuum import (
    StateVacuumEntity,
    VacuumActivity,
    VacuumEntityFeature,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import FAN_SPEEDS
from .entity import ZK901Entity

_ACTIVITIES = {
    "sweep": VacuumActivity.CLEANING,
    "pause": VacuumActivity.PAUSED,
    "backcharge": VacuumActivity.RETURNING,
    "charge": VacuumActivity.DOCKED,
    "fullcharge": VacuumActivity.DOCKED,
}


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Crea la entidad aspiradora."""
    async_add_entities([ZK901Vacuum(entry.runtime_data, entry)])


class ZK901Vacuum(ZK901Entity, StateVacuumEntity):
    """Control de limpieza confirmado por LAN."""

    _attr_translation_key = "zk901"
    _attr_name = None
    _attr_supported_features = (
        VacuumEntityFeature.STATE
        | VacuumEntityFeature.START
        | VacuumEntityFeature.PAUSE
        | VacuumEntityFeature.STOP
        | VacuumEntityFeature.RETURN_HOME
        | VacuumEntityFeature.FAN_SPEED
        | VacuumEntityFeature.CLEAN_SPOT
    )
    _attr_fan_speed_list = list(FAN_SPEEDS)

    def __init__(self, coordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry)
        self._attr_unique_id = f"{entry.entry_id}-vacuum"

    @property
    def activity(self) -> VacuumActivity | None:
        mode = self._parts()[0].get("mode")
        if not isinstance(mode, str):
            return None
        return _ACTIVITIES.get(mode)

    @property
    def fan_speed(self) -> str | None:
        level = self._parts()[0].get("workNoisy")
        if level in FAN_SPEEDS:
            return level
        return None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        status, _areas = self._parts()
        attributes: dict[str, Any] = {}
        for source, target in (
            ("mode", "mode"),
            ("subMode", "sub_mode"),
            ("windPower", "wind_power"),
            ("mop", "mop"),
            ("errorState", "error_state"),
        ):
            if source in status:
                attributes[target] = status[source]
        mop = status.get("mop")
        if mop == 1:
            attributes["cleaning_level_kind"] = "water"
        elif mop == 0:
            attributes["cleaning_level_kind"] = "suction"
        return attributes

    async def async_start(self) -> None:
        """Inicia la limpieza total, o la continúa si el robot está en pause."""
        await self._async_command(self.coordinator.client.start)

    async def async_pause(self) -> None:
        await self._async_command(self.coordinator.client.pause)

    async def async_stop(self, **kwargs: Any) -> None:
        await self._async_command(self.coordinator.client.stop)

    async def async_return_to_base(self, **kwargs: Any) -> None:
        await self._async_command(self.coordinator.client.return_to_base)

    async def async_set_fan_speed(self, fan_speed: str, **kwargs: Any) -> None:
        if fan_speed not in FAN_SPEEDS:
            raise ServiceValidationError("la potencia debe ser quiet, auto o strong")
        await self._async_command(self.coordinator.client.set_cleaning_level, fan_speed)

    async def async_clean_spot(self, **kwargs: Any) -> None:
        """Limpia alrededor de la posición actual. No es el spot de la pantalla principal OEM."""
        await self._async_command(self.coordinator.client.clean_current_position)

    async def async_clean_persisted_area(
        self,
        area_id: int | None = None,
        tag: str | None = None,
    ) -> None:
        """Limpia una zona persistida, por ID o por nombre."""
        name = tag.strip() if isinstance(tag, str) else ""
        if area_id is not None and name:
            raise ServiceValidationError("Indica el ID o el nombre de la zona, no ambos")
        if area_id is None and not name:
            raise ServiceValidationError("Indica el ID o el nombre de la zona")
        if area_id is not None:
            await self._async_command(self.coordinator.client.clean_area, area_id)
            return
        await self._async_command(self.coordinator.client.clean_area_by_name, name)

    async def async_clean_persisted_areas(self, area_ids: list[int]) -> None:
        """Start one compound cleaning operation for the selected zones."""
        await self._async_command(self.coordinator.client.clean_areas, area_ids)
