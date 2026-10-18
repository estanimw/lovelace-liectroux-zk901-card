"""Estado compartido de una ZK901.

Las entidades leen esta memoria. Ninguna abre su propia consulta al socket.
"""

from __future__ import annotations

import logging
import math
import time
from datetime import datetime, timezone
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .client import ZK901Client, ZK901Error
from .const import AREA_INTERVAL_SECONDS, DOMAIN, STATUS_INTERVAL

_LOGGER = logging.getLogger(__name__)

def _empty_areas() -> dict:
    return {"map_id": None, "areas": []}


class ZK901Coordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Consulta 20001 y reparte el estado. El catálogo de zonas va aparte."""

    def __init__(self, hass: HomeAssistant, client: ZK901Client) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=STATUS_INTERVAL,
        )
        self.client = client
        self.selected_area_id: int | None = None
        self._areas_at = 0.0
        self._areas_error_logged_at = 0.0
        self._status_observed_at: str | None = None

    def handle_status(self, status: dict) -> None:
        """Aplica un 20001 que llegó por el enlace, sin leer el socket aquí."""
        observed_at = datetime.now(timezone.utc).isoformat()

        def _apply() -> None:
            current = self.data if isinstance(self.data, dict) else {}
            areas = current.get("areas")
            if not isinstance(areas, dict):
                areas = _empty_areas()
            self._status_observed_at = observed_at
            self.async_set_updated_data(
                {
                    "status": status,
                    "status_observed_at": observed_at,
                    "areas": areas,
                }
            )

        self.hass.loop.call_soon_threadsafe(_apply)

    def set_area_catalog(self, catalog: dict) -> None:
        """Publica un catálogo fresco o verificado desde un comando WebSocket."""
        self._areas_at = time.monotonic()
        self._areas_error_logged_at = 0.0
        current = self.data if isinstance(self.data, dict) else {}
        self.async_set_updated_data(
            {
                "status": current.get("status", {}),
                "status_observed_at": current.get("status_observed_at"),
                "areas": catalog,
            }
        )

    def editor_pose(self) -> dict[str, Any] | None:
        """Vista pequeña de la última pose que llegó por 20001."""
        data = self.data if isinstance(self.data, dict) else {}
        status = data.get("status")
        position = status.get("pos") if isinstance(status, dict) else None
        if (
            not isinstance(position, list)
            or len(position) != 2
            or any(
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
                for value in position
            )
        ):
            return None
        return {
            "pos": list(position),
            "phi": status.get("phi"),
            "observed_at": data.get("status_observed_at"),
        }

    def handle_connection(self, online: bool) -> None:
        """Marca la aspiradora no disponible al perder el enlace."""

        def _apply() -> None:
            if not online:
                if self.last_update_success:
                    self.async_set_update_error(
                        UpdateFailed("Sin conexión con la aspiradora")
                    )
                return
            if not self.last_update_success:
                self.hass.async_create_task(self.async_request_refresh())

        self.hass.loop.call_soon_threadsafe(_apply)

    async def _async_update_data(self) -> dict[str, Any]:
        try:
            status = await self.hass.async_add_executor_job(self.client.get_status)
        except ZK901Error as err:
            raise UpdateFailed("No se pudo leer el estado") from err
        status_observed_at = datetime.now(timezone.utc).isoformat()
        self._status_observed_at = status_observed_at

        areas = None
        if isinstance(self.data, dict):
            areas = self.data.get("areas")
        now = time.monotonic()
        if (
            not isinstance(areas, dict)
            or now - self._areas_at >= AREA_INTERVAL_SECONDS
        ):
            try:
                areas = await self.hass.async_add_executor_job(self.client.get_areas, 10.0)
                self._areas_at = now
                self._areas_error_logged_at = 0.0
            except ZK901Error as err:
                if now - self._areas_error_logged_at >= AREA_INTERVAL_SECONDS:
                    _LOGGER.warning("No se pudo consultar el catálogo de zonas: %s", err)
                    self._areas_error_logged_at = now
                if not isinstance(areas, dict):
                    areas = _empty_areas()
        return {
            "status": status,
            "status_observed_at": status_observed_at,
            "areas": areas,
        }
