"""Home Assistant software update entity for the integration and Lovelace card."""

from __future__ import annotations

import json
from pathlib import Path

from homeassistant.components.update import UpdateEntity, UpdateEntityFeature
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .updater import UpdaterError, ZK901UpdateManager

DATA_UPDATER = f"{DOMAIN}_update_manager"


def _installed_version(hass: HomeAssistant) -> str:
    manifest = Path(__file__).with_name("manifest.json")
    try:
        value = json.loads(manifest.read_text(encoding="utf-8"))
        version = value.get("version")
    except (OSError, json.JSONDecodeError, AttributeError) as err:
        raise HomeAssistantError("No se pudo leer la versión de la integración ZK901") from err
    if not isinstance(version, str) or not version:
        raise HomeAssistantError("La integración ZK901 no declara una versión válida")
    return version


def get_update_manager(hass: HomeAssistant) -> ZK901UpdateManager:
    manager = hass.data.get(DATA_UPDATER)
    if manager is None:
        manager = ZK901UpdateManager(hass, _installed_version(hass))
        hass.data[DATA_UPDATER] = manager
    return manager


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Register one domain-wide updater, shared by all configured vacuums."""
    manager = get_update_manager(hass)
    await manager.async_process_startup_state()
    manager.register_platform(entry, async_add_entities, ZK901SoftwareUpdate)
    hass.async_create_task(manager.async_check(force=True))


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Move the shared entity to another loaded config entry when needed."""
    manager = hass.data.get(DATA_UPDATER)
    if manager is not None:
        manager.unregister_platform(entry.entry_id, ZK901SoftwareUpdate)
    return True


class ZK901SoftwareUpdate(UpdateEntity):
    """Installs the checked integration and dashboard card release as a pair."""

    _attr_has_entity_name = True
    _attr_translation_key = "software"
    _attr_entity_category = EntityCategory.CONFIG
    _attr_icon = "mdi:package-up"
    _attr_title = "Liectroux ZK901"
    _attr_auto_update = False
    _attr_supported_features = (
        UpdateEntityFeature.INSTALL | UpdateEntityFeature.RELEASE_NOTES
    )

    def __init__(self, manager: ZK901UpdateManager) -> None:
        super().__init__()
        self.manager = manager
        self._attr_unique_id = "software-update"
        self._sync_manager_state()

    def _sync_manager_state(self) -> None:
        release = self.manager.release
        self._attr_installed_version = self.manager.installed_version
        self._attr_latest_version = release.version if release else None
        self._attr_release_url = release.release_url if release else None
        self._attr_release_summary = self.manager.summary

    @property
    def available(self) -> bool:
        """GitHub reachability is independent of the vacuum's LAN connection."""
        return True

    async def async_update(self) -> None:
        """Refresh stable GitHub releases without affecting vacuum control."""
        await self.manager.async_check()
        self._sync_manager_state()

    async def async_install(
        self,
        version: str | None,
        backup: bool,
        **kwargs,
    ) -> None:
        """Prepare the paired package; Home Assistant is never restarted here."""
        del backup, kwargs
        try:
            await self.manager.async_install(version)
        except UpdaterError as err:
            raise HomeAssistantError(str(err)) from err
        self._sync_manager_state()

    async def async_release_notes(self) -> str | None:
        """Return the full notes published with the complete release."""
        release = self.manager.release
        return release.notes if release else None

    async def async_restore_previous(self) -> None:
        """Restore the last backend/card pairing, leaving restart to the owner."""
        try:
            await self.manager.async_restore_previous()
        except UpdaterError as err:
            raise HomeAssistantError(str(err)) from err
        self._sync_manager_state()
