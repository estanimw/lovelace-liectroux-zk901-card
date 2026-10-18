"""Estado compartido de una ZK901.

Las entidades y la tarjeta leen esta memoria. Ninguna abre su propia consulta
al socket; las suscripciones WebSocket se notifican a través del dispatcher.
"""

from __future__ import annotations

import copy
import logging
import math
import time
from datetime import datetime, timezone
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .client import ZK901Client, ZK901Error, area_catalog_revision
from .const import AREA_INTERVAL_SECONDS, CARD_API_VERSION, DOMAIN, STATUS_INTERVAL

_LOGGER = logging.getLogger(__name__)


def card_update_signal(entry_id: str) -> str:
    """Return the dispatcher signal shared by cards for one config entry."""
    return f"{DOMAIN}_card_update_{entry_id}"


def _empty_areas() -> dict:
    return {"map_id": None, "areas": []}


class ZK901Coordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Consulta 20001 y reparte estado y catálogo a las entidades y tarjetas."""

    def __init__(
        self, hass: HomeAssistant, client: ZK901Client, entry: ConfigEntry
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            config_entry=entry,
            name=DOMAIN,
            update_interval=STATUS_INTERVAL,
        )
        self.client = client
        self.entry_id = entry.entry_id
        self.selected_area_id: int | None = None
        self._areas_at = 0.0
        self._areas_error_logged_at = 0.0
        self._areas_observed_at: str | None = None
        self._areas_error: str | None = None
        self._status_observed_at: str | None = None
        self._available = False

    @property
    def available(self) -> bool:
        """The LAN link has answered a status request and the refresh succeeded."""
        return self._available and self.last_update_success

    @property
    def areas_observed_at(self) -> str | None:
        """UTC timestamp of the last successful 21004 catalog read."""
        return self._areas_observed_at

    def _publish_card_update(self) -> None:
        async_dispatcher_send(self.hass, card_update_signal(self.entry_id))

    def async_set_updated_data(self, data: dict[str, Any]) -> None:
        """Publish coordinator and card updates from the same state change."""
        super().async_set_updated_data(data)
        self._publish_card_update()

    def _current_parts(self) -> tuple[dict[str, Any], dict[str, Any]]:
        data = self.data if isinstance(self.data, dict) else {}
        status = data.get("status")
        areas = data.get("areas")
        if not isinstance(status, dict):
            status = {}
        if not isinstance(areas, dict):
            areas = _empty_areas()
        return status, areas

    def _set_data(self, status: dict, areas: dict) -> None:
        self.async_set_updated_data(
            {
                "status": status,
                "status_observed_at": self._status_observed_at,
                "areas": areas,
                "areas_observed_at": self._areas_observed_at,
                "areas_error": self._areas_error,
            }
        )

    def handle_status(self, status: dict) -> None:
        """Aplica un 20001 que llegó por el enlace, sin leer el socket aquí."""
        observed_at = datetime.now(timezone.utc).isoformat()

        def _apply() -> None:
            _current_status, areas = self._current_parts()
            self._available = True
            self._status_observed_at = observed_at
            self._set_data(status, areas)

        self.hass.loop.call_soon_threadsafe(_apply)

    def set_status(self, status: dict) -> None:
        """Publish a status returned by an explicit card refresh."""
        current_status, areas = self._current_parts()
        del current_status
        self._available = True
        self._status_observed_at = datetime.now(timezone.utc).isoformat()
        self._set_data(status, areas)

    def set_area_catalog(self, catalog: dict) -> None:
        """Publish a fresh catalog read or verified by an edit transaction."""
        status, _current_areas = self._current_parts()
        self._areas_at = time.monotonic()
        self._areas_observed_at = datetime.now(timezone.utc).isoformat()
        self._areas_error = None
        self._areas_error_logged_at = 0.0
        self._set_data(status, copy.deepcopy(catalog))

    def set_area_error(self, error: str = "unavailable") -> None:
        """Keep the last catalog visible while marking its read as stale."""
        self._areas_error = error
        self._publish_card_update()

    def editor_pose(self) -> dict[str, Any] | None:
        """Return the last finite pose from status 20001."""
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
        phi = status.get("phi")
        if (
            isinstance(phi, bool)
            or not isinstance(phi, (int, float))
            or not math.isfinite(phi)
        ):
            phi = None
        return {
            "pos": list(position),
            "phi": phi,
            "observed_at": data.get("status_observed_at"),
        }

    def card_snapshot(
        self, *, entity_id: str, generation: str, sequence: int
    ) -> dict[str, Any]:
        """Build the public, versioned snapshot used by the ZK901 card."""
        status, areas = self._current_parts()
        age_seconds = (
            max(0.0, time.monotonic() - self._areas_at)
            if self._areas_at
            else None
        )
        try:
            revision = area_catalog_revision(areas)
        except ZK901Error:
            revision = None

        mop = status.get("mop")
        if isinstance(mop, bool):
            level_kind = None
        elif mop == 0:
            level_kind = "suction"
        elif mop == 1:
            level_kind = "water"
        else:
            level_kind = None

        return {
            "api_version": CARD_API_VERSION,
            "generation": generation,
            "sequence": sequence,
            "entity_id": entity_id,
            "available": self.available,
            "status": {
                "battery": status.get("elec"),
                "mode": status.get("mode"),
                "sub_mode": status.get("subMode"),
                "cleaning_level": status.get("workNoisy"),
                "cleaning_level_kind": level_kind,
                "error": status.get("errorState"),
                "observed_at": self._status_observed_at,
            },
            "pose": self.editor_pose(),
            "catalog": {
                "map_id": areas.get("map_id"),
                "revision": revision,
                "areas": copy.deepcopy(areas.get("areas", [])),
                "observed_at": self._areas_observed_at,
                "age_seconds": age_seconds,
                "fresh": age_seconds is not None
                and age_seconds < AREA_INTERVAL_SECONDS,
                "available": self._areas_error is None,
                "error": self._areas_error,
            },
            "capabilities": {
                "subscribe": True,
                "clean_areas": True,
                "zone_edit": True,
                "current_position": True,
                "cleaning_level": True,
            },
        }

    def handle_connection(self, online: bool) -> None:
        """Marca el enlace y vuelve a consultar el estado tras reconectar."""

        def _apply() -> None:
            self._available = online
            if not online:
                if self.last_update_success:
                    self.async_set_update_error(
                        UpdateFailed("Sin conexión con la aspiradora")
                    )
                self._publish_card_update()
                return
            self._publish_card_update()
            if not self.last_update_success:
                self.hass.async_create_task(self.async_request_refresh())

        self.hass.loop.call_soon_threadsafe(_apply)

    def mark_unloaded(self) -> None:
        """Notify live cards before the config entry closes the LAN client."""
        self._available = False
        if self.last_update_success:
            self.async_set_update_error(UpdateFailed("Integración descargada"))
        self._publish_card_update()

    async def _async_update_data(self) -> dict[str, Any]:
        try:
            status = await self.hass.async_add_executor_job(self.client.get_status)
        except ZK901Error as err:
            self._available = False
            self._publish_card_update()
            raise UpdateFailed("No se pudo leer el estado") from err
        self._available = True
        status_observed_at = datetime.now(timezone.utc).isoformat()
        self._status_observed_at = status_observed_at

        _current_status, areas = self._current_parts()
        now = time.monotonic()
        if not isinstance(self.data, dict) or now - self._areas_at >= AREA_INTERVAL_SECONDS:
            try:
                areas = await self.hass.async_add_executor_job(
                    self.client.get_areas, 10.0
                )
                self._areas_at = time.monotonic()
                self._areas_observed_at = datetime.now(timezone.utc).isoformat()
                self._areas_error = None
                self._areas_error_logged_at = 0.0
            except ZK901Error as err:
                self._areas_error = "unavailable"
                if now - self._areas_error_logged_at >= AREA_INTERVAL_SECONDS:
                    _LOGGER.warning("No se pudo consultar el catálogo de zonas: %s", err)
                    self._areas_error_logged_at = now
                if not isinstance(areas, dict):
                    areas = _empty_areas()
        return {
            "status": status,
            "status_observed_at": status_observed_at,
            "areas": areas,
            "areas_observed_at": self._areas_observed_at,
            "areas_error": self._areas_error,
        }
