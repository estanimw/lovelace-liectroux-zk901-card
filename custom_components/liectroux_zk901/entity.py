"""Base de las entidades de una misma aspiradora."""

from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .client import ZK901Error
from .const import DOMAIN, MANUFACTURER, MODEL
from .coordinator import ZK901Coordinator


class ZK901Entity(CoordinatorEntity[ZK901Coordinator]):
    """Entidad que lee el coordinador y no abre su propia conexión."""

    _attr_has_entity_name = True

    def __init__(
        self,
        coordinator: ZK901Coordinator,
        entry: ConfigEntry,
    ) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            manufacturer=MANUFACTURER,
            model=MODEL,
            name="Liectroux ZK901",
        )

    def _parts(self) -> tuple[dict[str, Any], dict[str, Any]]:
        data = self.coordinator.data if isinstance(self.coordinator.data, dict) else {}
        status = data.get("status")
        areas = data.get("areas")
        if not isinstance(status, dict):
            status = {}
        if not isinstance(areas, dict):
            areas = {"map_id": None, "areas": []}
        return status, areas

    async def _async_command(self, func, *args) -> None:
        try:
            await self.hass.async_add_executor_job(func, *args)
        except ValueError as err:
            raise ServiceValidationError(str(err)) from err
        except ZK901Error as err:
            raise HomeAssistantError(str(err)) from err
        await self.coordinator.async_request_refresh()
