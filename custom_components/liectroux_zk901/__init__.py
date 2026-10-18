"""Integración local Liectroux ZK901."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
import shutil
import uuid


def _recover_interrupted_install_before_import() -> bool:
    """Restore an interrupted package before importing its Python modules."""
    config_dir = Path(__file__).absolute().parents[2]
    state_dir = config_dir / ".liectroux_zk901_updater"
    if state_dir.is_symlink() or (state_dir / "backups").is_symlink():
        raise RuntimeError("ZK901 updater recovery state contains a symbolic link")
    journal_path = state_dir / "transaction.json"
    try:
        if journal_path.stat().st_size > 64 * 1024:
            return False
        journal = json.loads(journal_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return False
    if not isinstance(journal, dict) or journal.get("phase") not in {"applying", "restoring"}:
        if isinstance(journal, dict) and journal.get("phase") == "complete":
            journal_path.unlink(missing_ok=True)
        return False

    relative_backup = journal.get("backup")
    if not isinstance(relative_backup, str):
        raise RuntimeError("ZK901 updater recovery has no valid backup path")
    backup = (config_dir / relative_backup).absolute()
    backup_root = (state_dir / "backups").absolute()
    if backup.is_symlink() or not backup.is_relative_to(backup_root) or ".." in Path(relative_backup).parts:
        raise RuntimeError("ZK901 updater recovery backup escaped its allowed directory")
    backend_backup = backup / "backend"
    if backend_backup.is_symlink() or not backend_backup.is_dir():
        raise RuntimeError("ZK901 updater recovery backup is missing")

    target = config_dir / "custom_components" / "liectroux_zk901"
    if target.is_symlink() or not target.parent.is_dir():
        raise RuntimeError("ZK901 updater recovery target is not a safe directory")
    staging = target.parent / f".liectroux_zk901.recovery-{uuid.uuid4().hex}"
    displaced = target.parent / f".liectroux_zk901.displaced-{uuid.uuid4().hex}"
    shutil.copytree(backend_backup, staging, symlinks=True)
    try:
        if target.exists():
            os.replace(target, displaced)
        os.replace(staging, target)
    except Exception:
        if displaced.exists() and not target.exists():
            os.replace(displaced, target)
        raise
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
    if displaced.exists():
        shutil.rmtree(displaced, ignore_errors=True)

    version = journal.get("version")
    expected_asset = f"www/liectroux-zk901/liectroux-zk901-map-card-{version}.js"
    if (
        journal.get("new_asset_owned") is True
        and journal.get("new_asset") == expected_asset
        and isinstance(version, str)
    ):
        asset = config_dir / expected_asset
        if (
            not (config_dir / "www").is_symlink()
            and not asset.is_symlink()
            and not asset.parent.is_symlink()
            and asset.parent.resolve().is_relative_to((config_dir / "www").resolve())
        ):
            asset.unlink(missing_ok=True)
    pending_path = state_dir / "pending.json"
    try:
        pending = json.loads(pending_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        pending = None
    if isinstance(pending, dict) and pending.get("version") == version:
        pending_path.unlink(missing_ok=True)
    journal_path.unlink(missing_ok=True)
    return True


_RECOVERED_INTERRUPTED_INSTALL = _recover_interrupted_install_before_import()

import voluptuous as vol
from homeassistant.components.vacuum import DOMAIN as VACUUM_DOMAIN
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryNotReady, HomeAssistantError
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
    SERVICE_RESTORE_PREVIOUS_VERSION,
)
from .coordinator import ZK901Coordinator, card_update_signal
from .update import DATA_UPDATER, get_update_manager
from .updater import UpdaterError
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
    Platform.UPDATE,
)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Registra la acción de zona incluso si aún no se cargó el robot."""
    register_zone_editor_commands(hass)
    get_update_manager(hass)
    if _RECOVERED_INTERRUPTED_INSTALL:
        _LOGGER.warning("Se recuperó una instalación interrumpida de Liectroux ZK901")
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

    async def async_restore_previous_version(_call) -> None:
        """Restore the last local backend/card backup without restarting HA."""
        manager = hass.data[DATA_UPDATER]
        try:
            await manager.async_restore_previous()
        except UpdaterError as err:
            raise HomeAssistantError(str(err)) from err

    service.async_register_admin_service(
        hass,
        DOMAIN,
        SERVICE_RESTORE_PREVIOUS_VERSION,
        async_restore_previous_version,
        schema=vol.Schema({}),
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
    client.set_connection_listener(coordinator.handle_connection)
    try:
        await hass.async_add_executor_job(client.connect)
    except Exception as err:
        await hass.async_add_executor_job(client.close)
        if isinstance(err, (ZK901Error, ConfigEntryNotReady)):
            raise ConfigEntryNotReady("La aspiradora no está disponible") from err
        raise
    try:
        await coordinator.async_config_entry_first_refresh()
    except ConfigEntryNotReady as err:
        # Keep the local reconnect loop and updater available while the robot is offline.
        _LOGGER.warning("La ZK901 no respondió durante la carga inicial: %s", err)
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
