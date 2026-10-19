"""Versioned GitHub release discovery and guarded installation for the card."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from functools import partial
import hashlib
import json
import logging
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tempfile
import time
from typing import Any
from urllib.parse import quote, urlsplit
import zipfile

import aiohttp
from homeassistant.components import persistent_notification
from homeassistant.components.lovelace.const import LOVELACE_DATA, MODE_STORAGE
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import issue_registry as ir

try:
    from homeassistant.helpers import system_state
except ImportError:  # Home Assistant before the native restart indicator.
    system_state = None

from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

OWNER = "estanimw"
REPOSITORY = "lovelace-liectroux-zk901-card"
RELEASES_API = f"https://api.github.com/repos/{OWNER}/{REPOSITORY}/releases?per_page=100"
ARCHIVE_NAME = "liectroux-zk901-ha.zip"
MANIFEST_NAME = "release-manifest.json"
CHECKSUMS_NAME = "SHA256SUMS"
BUNDLE_NAME = "liectroux-zk901-map-card.js"
BUNDLE_PATH = "www/liectroux-zk901/liectroux-zk901-map-card.js"
BUNDLE_RESOURCE_RE = re.compile(
    r"^/local/liectroux-zk901/liectroux-zk901-map-card(?:-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))?\.js$"
)
VERSION_RE = re.compile(r"^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
SHA_LINE_RE = re.compile(r"^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$")
STATE_DIRECTORY = ".liectroux_zk901_updater"
TRANSACTION_FILE = "transaction.json"
PENDING_FILE = "pending.json"
LAST_INSTALL_FILE = "last_install.json"
MAX_RELEASES = 100
MAX_RELEASE_CANDIDATES = 12
MAX_RELEASES_JSON = 2 * 1024 * 1024
MAX_METADATA_SIZE = 256 * 1024
MAX_CHECKSUMS_SIZE = 16 * 1024
MAX_ARCHIVE_SIZE = 12 * 1024 * 1024
MAX_BUNDLE_SIZE = 4 * 1024 * 1024
MAX_UNPACKED_SIZE = 12 * 1024 * 1024
MAX_FILES = 100
HTTP_TIMEOUT = aiohttp.ClientTimeout(total=35, connect=8, sock_read=20)
API_HEADERS = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Liectroux-ZK901-Home-Assistant-Updater",
}
ASSET_REDIRECT_HOSTS = {
    "github.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
}
_EXPECTED_ASSETS = {BUNDLE_NAME, ARCHIVE_NAME, MANIFEST_NAME, CHECKSUMS_NAME}
_ALLOWED_ROOT_FILES = {"manifest.json", "services.yaml"}
_REQUIRED_BACKEND_FILES = {
    f"custom_components/{DOMAIN}/__init__.py",
    f"custom_components/{DOMAIN}/button.py",
    f"custom_components/{DOMAIN}/const.py",
    f"custom_components/{DOMAIN}/client.py",
    f"custom_components/{DOMAIN}/config_flow.py",
    f"custom_components/{DOMAIN}/coordinator.py",
    f"custom_components/{DOMAIN}/entity.py",
    f"custom_components/{DOMAIN}/manifest.json",
    f"custom_components/{DOMAIN}/select.py",
    f"custom_components/{DOMAIN}/sensor.py",
    f"custom_components/{DOMAIN}/services.yaml",
    f"custom_components/{DOMAIN}/translations/en.json",
    f"custom_components/{DOMAIN}/translations/es.json",
    f"custom_components/{DOMAIN}/vacuum.py",
    f"custom_components/{DOMAIN}/update.py",
    f"custom_components/{DOMAIN}/updater.py",
    f"custom_components/{DOMAIN}/zone_editor.py",
    BUNDLE_PATH,
}
_NOTIFICATION_ID = "liectroux_zk901_software_update"


class UpdaterError(HomeAssistantError):
    """A release or local installation could not be safely completed."""


@dataclass(frozen=True)
class ReleaseCandidate:
    """A complete, version-matched public release."""

    version: str
    tag: str
    release_url: str
    notes: str
    assets: dict[str, str]
    checksums: dict[str, str]
    metadata: dict[str, Any]


def _version_parts(value: object) -> tuple[int, int, int] | None:
    if not isinstance(value, str):
        return None
    match = VERSION_RE.fullmatch(value)
    if match is None:
        return None
    return tuple(int(part) for part in match.groups())


def _version_from_tag(value: object) -> str | None:
    parts = _version_parts(value)
    return ".".join(str(part) for part in parts) if parts is not None else None


def _release_asset_limits(name: str) -> int | None:
    return {
        BUNDLE_NAME: MAX_BUNDLE_SIZE,
        ARCHIVE_NAME: MAX_ARCHIVE_SIZE,
        MANIFEST_NAME: MAX_METADATA_SIZE,
        CHECKSUMS_NAME: MAX_CHECKSUMS_SIZE,
    }.get(name)


def _safe_archive_path(name: str) -> bool:
    if not isinstance(name, str) or not name or "\\" in name or "\x00" in name:
        return False
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        return False
    prefix = f"custom_components/{DOMAIN}/"
    if name.startswith(prefix):
        relative = name.removeprefix(prefix)
        return (
            "/" not in relative
            and (relative.endswith(".py") or relative in _ALLOWED_ROOT_FILES)
        ) or (
            relative.startswith("translations/")
            and relative.count("/") == 1
            and relative.endswith(".json")
        )
    return name == BUNDLE_PATH


def _parse_checksums(data: bytes) -> dict[str, str]:
    try:
        lines = data.decode("ascii").splitlines()
    except UnicodeDecodeError as err:
        raise UpdaterError("El archivo SHA256SUMS no es texto ASCII válido") from err
    result: dict[str, str] = {}
    for line in lines:
        match = SHA_LINE_RE.fullmatch(line)
        if match is None:
            raise UpdaterError("El archivo SHA256SUMS tiene un formato inesperado")
        digest, name = match.groups()
        if name in result:
            raise UpdaterError(f"SHA256SUMS repite el artefacto {name}")
        result[name] = digest
    if set(result) != _EXPECTED_ASSETS - {CHECKSUMS_NAME}:
        raise UpdaterError("SHA256SUMS no cubre exactamente los artefactos esperados")
    return result


def _validate_metadata(metadata: object, version: str) -> dict[str, Any]:
    if not isinstance(metadata, dict):
        raise UpdaterError("El manifest de release no es un objeto JSON")
    if metadata.get("format_version") != 2:
        raise UpdaterError("Formato de release-manifest.json no compatible")
    if metadata.get("archive") != ARCHIVE_NAME:
        raise UpdaterError("El manifest referencia un ZIP inesperado")
    if metadata.get("integration_domain") != DOMAIN:
        raise UpdaterError("El paquete pertenece a otra integración")
    if metadata.get("card_version") != version or metadata.get("integration_version") != version:
        raise UpdaterError("Las versiones de frontend y backend no coinciden con el tag")

    compatibility = metadata.get("compatibility")
    if not isinstance(compatibility, dict):
        raise UpdaterError("Falta el contrato de compatibilidad del paquete")
    if (
        compatibility.get("frontend_version") != version
        or compatibility.get("backend_version") != version
        or isinstance(compatibility.get("card_api_version"), bool)
        or not isinstance(compatibility.get("card_api_version"), int)
        or compatibility.get("card_api_version") < 1
        or not isinstance(compatibility.get("home_assistant_tested"), str)
    ):
        raise UpdaterError("Las versiones declaradas por el paquete no coinciden")

    files = metadata.get("files")
    if not isinstance(files, dict) or not _REQUIRED_BACKEND_FILES <= set(files):
        raise UpdaterError("El manifest no declara los archivos mínimos del paquete")
    if (_version_parts(version) or (0, 0, 0)) >= (0, 4, 0) and f"custom_components/{DOMAIN}/trajectory.py" not in files:
        raise UpdaterError("Falta el módulo de captura de trayectoria del paquete")
    if len(files) > MAX_FILES:
        raise UpdaterError("El manifest declara demasiados archivos")
    for name, digest in files.items():
        if not _safe_archive_path(name) or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise UpdaterError("El manifest contiene una ruta o hash no permitido")
    return metadata


def _expected_asset_url(tag: str, name: str) -> str:
    return (
        f"https://github.com/{OWNER}/{REPOSITORY}/releases/download/"
        f"{quote(tag, safe='')}/{quote(name, safe='')}"
    )


def _candidate_from_api(raw: object) -> tuple[str, str, str, str, dict[str, str]] | None:
    if not isinstance(raw, dict) or raw.get("draft") is not False or raw.get("prerelease") is not False:
        return None
    tag = raw.get("tag_name")
    version = _version_from_tag(tag)
    if version is None or not isinstance(tag, str) or not raw.get("published_at"):
        return None
    release_url = raw.get("html_url")
    expected_release_url = f"https://github.com/{OWNER}/{REPOSITORY}/releases/tag/{quote(tag, safe='')}"
    if release_url != expected_release_url:
        return None
    body = raw.get("body")
    notes = body[:64_000] if isinstance(body, str) else ""
    assets = raw.get("assets")
    if not isinstance(assets, list):
        return None
    urls: dict[str, str] = {}
    for asset in assets:
        if not isinstance(asset, dict):
            return None
        name = asset.get("name")
        limit = _release_asset_limits(name) if isinstance(name, str) else None
        size = asset.get("size")
        url = asset.get("browser_download_url")
        if limit is None or name in urls:
            return None
        if isinstance(size, bool) or not isinstance(size, int) or size <= 0 or size > limit:
            return None
        if url != _expected_asset_url(tag, name):
            return None
        urls[name] = url
    if set(urls) != _EXPECTED_ASSETS:
        return None
    return version, tag, release_url, notes, urls


async def _read_bounded_response(
    session: aiohttp.ClientSession,
    url: str,
    maximum: int,
    *,
    api: bool = False,
) -> bytes:
    """Download a bounded response, limiting redirect destinations for assets."""
    try:
        async with session.get(
            url,
            headers=API_HEADERS if api else {"User-Agent": API_HEADERS["User-Agent"]},
            timeout=HTTP_TIMEOUT,
            allow_redirects=True,
            max_redirects=5,
        ) as response:
            if response.status != 200:
                raise UpdaterError(f"GitHub respondió HTTP {response.status}")
            if api:
                if response.url.host != "api.github.com":
                    raise UpdaterError("La API redirigió a un host inesperado")
            else:
                if any(item.url.host not in ASSET_REDIRECT_HOSTS for item in response.history):
                    raise UpdaterError("El artefacto redirigió a un host inesperado")
                if response.url.host not in ASSET_REDIRECT_HOSTS:
                    raise UpdaterError("El artefacto final está en un host inesperado")
            if response.content_length is not None and response.content_length > maximum:
                raise UpdaterError("El artefacto supera el tamaño máximo permitido")
            chunks: list[bytes] = []
            size = 0
            async for chunk in response.content.iter_chunked(64 * 1024):
                size += len(chunk)
                if size > maximum:
                    raise UpdaterError("La descarga superó el tamaño máximo permitido")
                chunks.append(chunk)
            return b"".join(chunks)
    except UpdaterError:
        raise
    except (aiohttp.ClientError, asyncio.TimeoutError) as err:
        raise UpdaterError(f"No se pudo descargar desde GitHub: {err}") from err


async def async_find_latest_release(
    session: aiohttp.ClientSession,
    installed_version: str,
) -> ReleaseCandidate | None:
    """Return the newest complete stable release from the configured repository."""
    installed_parts = _version_parts(installed_version)
    if installed_parts is None:
        raise UpdaterError("La versión instalada no tiene el formato esperado")
    raw = await _read_bounded_response(session, RELEASES_API, MAX_RELEASES_JSON, api=True)
    try:
        releases = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as err:
        raise UpdaterError("La respuesta de releases no contiene JSON válido") from err
    if not isinstance(releases, list):
        raise UpdaterError("La API de GitHub no devolvió una lista de releases")

    indexed: list[tuple[tuple[int, int, int], str, str, str, str, dict[str, str]]] = []
    for item in releases[:MAX_RELEASES]:
        candidate = _candidate_from_api(item)
        if candidate is None:
            continue
        version, tag, release_url, notes, assets = candidate
        parts = _version_parts(version)
        if parts is not None and parts > installed_parts:
            indexed.append((parts, version, tag, release_url, notes, assets))
    indexed.sort(reverse=True)

    for _parts, version, tag, release_url, notes, assets in indexed[:MAX_RELEASE_CANDIDATES]:
        try:
            checksums_bytes, metadata_bytes = await asyncio.gather(
                _read_bounded_response(session, assets[CHECKSUMS_NAME], MAX_CHECKSUMS_SIZE),
                _read_bounded_response(session, assets[MANIFEST_NAME], MAX_METADATA_SIZE),
            )
            checksums = _parse_checksums(checksums_bytes)
            if hashlib.sha256(metadata_bytes).hexdigest() != checksums[MANIFEST_NAME]:
                raise UpdaterError("El hash de release-manifest.json no coincide")
            metadata = _validate_metadata(json.loads(metadata_bytes), version)
            if _version_from_tag(tag) != version:
                raise UpdaterError("El tag de GitHub no coincide con su versión")
            return ReleaseCandidate(
                version=version,
                tag=tag,
                release_url=release_url,
                notes=notes,
                assets=assets,
                checksums=checksums,
                metadata=metadata,
            )
        except (UpdaterError, json.JSONDecodeError, UnicodeDecodeError, TypeError, ValueError) as err:
            _LOGGER.debug("Se omite release incompleta %s: %s", tag, err)
    return None


def verify_release_archive(
    archive_bytes: bytes,
    bundle_bytes: bytes,
    *,
    version: str,
    metadata: object,
    checksums: dict[str, str],
) -> dict[str, bytes]:
    """Validate package versions, allowlisted paths, duplicate entries and hashes."""
    normalized = _validate_metadata(metadata, version)
    if len(archive_bytes) > MAX_ARCHIVE_SIZE or len(bundle_bytes) > MAX_BUNDLE_SIZE:
        raise UpdaterError("El paquete o su tarjeta supera el tamaño máximo permitido")
    if hashlib.sha256(archive_bytes).hexdigest() != checksums.get(ARCHIVE_NAME):
        raise UpdaterError("El hash del ZIP no coincide con SHA256SUMS")
    if hashlib.sha256(bundle_bytes).hexdigest() != checksums.get(BUNDLE_NAME):
        raise UpdaterError("El hash de la tarjeta no coincide con SHA256SUMS")

    declared = normalized["files"]
    result: dict[str, bytes] = {}
    total_size = 0
    try:
        from io import BytesIO

        with zipfile.ZipFile(BytesIO(archive_bytes)) as archive:
            infos = archive.infolist()
            if len(infos) > MAX_FILES:
                raise UpdaterError("El ZIP contiene demasiados archivos")
            for info in infos:
                name = info.filename
                if name in result or not _safe_archive_path(name):
                    raise UpdaterError("El ZIP contiene rutas duplicadas o no permitidas")
                mode = info.external_attr >> 16
                if stat.S_ISLNK(mode) or info.is_dir() or info.flag_bits & 0x1:
                    raise UpdaterError("El ZIP contiene enlaces, directorios o contenido cifrado")
                if info.file_size < 0 or info.file_size > MAX_UNPACKED_SIZE:
                    raise UpdaterError("Un archivo del ZIP supera el tamaño máximo")
                total_size += info.file_size
                if total_size > MAX_UNPACKED_SIZE:
                    raise UpdaterError("El contenido expandido supera el tamaño máximo")
                content = archive.read(info)
                expected_hash = declared.get(name)
                if expected_hash is None or hashlib.sha256(content).hexdigest() != expected_hash:
                    raise UpdaterError(f"El hash de {name} no coincide con el manifest")
                result[name] = content
    except UpdaterError:
        raise
    except (OSError, zipfile.BadZipFile, RuntimeError) as err:
        raise UpdaterError(f"El ZIP no es válido: {err}") from err

    if set(result) != set(declared):
        raise UpdaterError("El ZIP y release-manifest.json no contienen los mismos archivos")
    if not _REQUIRED_BACKEND_FILES <= set(result):
        raise UpdaterError("Faltan archivos necesarios para cargar la integración nueva")
    if result.get(BUNDLE_PATH) != bundle_bytes:
        raise UpdaterError("La tarjeta del ZIP no coincide con el artefacto independiente")

    try:
        integration_manifest = json.loads(result[f"custom_components/{DOMAIN}/manifest.json"])
        constants = result[f"custom_components/{DOMAIN}/const.py"].decode("utf-8")
        bundle_text = bundle_bytes.decode("utf-8")
    except (KeyError, json.JSONDecodeError, UnicodeDecodeError) as err:
        raise UpdaterError("No se pudo leer el contrato del paquete") from err
    api_match = re.search(r"^CARD_API_VERSION\s*=\s*(\d+)\s*$", constants, re.MULTILINE)
    if (
        not isinstance(integration_manifest, dict)
        or integration_manifest.get("domain") != DOMAIN
        or integration_manifest.get("version") != version
        or api_match is None
        or int(api_match.group(1)) != normalized["compatibility"]["card_api_version"]
        or f"v{version}" not in bundle_text
        or "@VACUUM_MAP_CARD_VERSION_PLACEHOLDER@" in bundle_text
    ):
        raise UpdaterError("El tag, manifest, API y bundle no describen la misma entrega")
    return result


def _state_dir(config_dir: Path) -> Path:
    return config_dir / STATE_DIRECTORY


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        if path.stat().st_size > 64 * 1024:
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None


def _write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _tree_size(path: Path) -> int:
    if not path.exists():
        return 0
    if path.is_symlink():
        return 4096
    if path.is_file():
        return path.stat().st_size
    return sum(_tree_size(item) for item in path.iterdir())


def _probe_directory(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    descriptor, filename = tempfile.mkstemp(prefix=".zk901-write-check-", dir=directory)
    os.close(descriptor)
    Path(filename).unlink()


def _resource_path(config_dir: Path, url: str | None) -> Path | None:
    if not isinstance(url, str):
        return None
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if parts.scheme or parts.netloc or not BUNDLE_RESOURCE_RE.fullmatch(parts.path):
        return None
    relative = parts.path.removeprefix("/local/")
    if ".." in PurePosixPath(relative).parts:
        return None
    return config_dir / "www" / Path(*PurePosixPath(relative).parts)


def _path_has_symlink(root: Path, target: Path) -> bool:
    """Check existing path components without following an in-config link."""
    try:
        relative = target.relative_to(root)
    except ValueError:
        return True
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            return True
    return False


def _versioned_resource_url(version: str) -> str:
    return f"/local/liectroux-zk901/liectroux-zk901-map-card-{version}.js?v={version}"


def _backend_target(config_dir: Path) -> Path:
    return config_dir / "custom_components" / DOMAIN


def _validate_local_backup(config_dir: Path, backup: object) -> Path:
    if not isinstance(backup, str):
        raise UpdaterError("No hay una copia de respaldo válida")
    state_path = _state_dir(config_dir)
    backups_path = state_path / "backups"
    candidate_path = config_dir / backup
    if state_path.is_symlink() or backups_path.is_symlink() or candidate_path.is_symlink():
        raise UpdaterError("La ruta del respaldo contiene un enlace simbólico")
    state = state_path.resolve()
    candidate = candidate_path.resolve()
    if not candidate.is_relative_to(state / "backups"):
        raise UpdaterError("La ruta del respaldo está fuera del directorio permitido")
    if candidate.is_symlink() or not candidate.is_dir():
        raise UpdaterError("No se encuentra la copia de respaldo")
    return candidate


def _restore_backend_tree(config_dir: Path, backend_backup: Path) -> None:
    target = _backend_target(config_dir)
    if (
        _path_has_symlink(config_dir, target.parent)
        or target.is_symlink()
        or backend_backup.is_symlink()
        or not target.parent.is_dir()
    ):
        raise UpdaterError("La carpeta de la integración no es segura para restaurar")
    staging = target.parent / f".{DOMAIN}.restore-{os.getpid()}"
    displaced = target.parent / f".{DOMAIN}.displaced-{os.getpid()}"
    if staging.exists():
        shutil.rmtree(staging)
    if displaced.exists():
        shutil.rmtree(displaced)
    shutil.copytree(backend_backup, staging, symlinks=True)
    if target.exists():
        os.replace(target, displaced)
    try:
        os.replace(staging, target)
    except Exception:
        if displaced.exists() and not target.exists():
            os.replace(displaced, target)
        raise
    if displaced.exists():
        shutil.rmtree(displaced)
    for stale in target.parent.glob(f".{DOMAIN}.displaced-*"):
        if stale.is_dir() and not stale.is_symlink():
            shutil.rmtree(stale, ignore_errors=True)


def recover_interrupted_install(config_dir: Path) -> None:
    """Restore the previous backend before importing its Python modules."""
    state = _state_dir(config_dir)
    journal_path = state / TRANSACTION_FILE
    if state.is_symlink() or (state / "backups").is_symlink():
        raise UpdaterError("El journal del actualizador está dentro de una ruta simbólica")
    journal = _read_json(journal_path)
    if journal is None or journal.get("phase") not in {"applying", "restoring"}:
        if journal is not None and journal.get("phase") == "complete":
            journal_path.unlink(missing_ok=True)
        return
    backup = _validate_local_backup(config_dir, journal.get("backup"))
    _restore_backend_tree(config_dir, backup / "backend")
    relative_asset = journal.get("new_asset")
    if (
        journal.get("new_asset_owned") is True
        and isinstance(relative_asset, str)
        and relative_asset == f"www/liectroux-zk901/liectroux-zk901-map-card-{journal.get('version')}.js"
    ):
        asset = config_dir / relative_asset
        if asset.parent.resolve().is_relative_to((config_dir / "www").resolve()) and not asset.is_symlink():
            asset.unlink(missing_ok=True)
    pending = state / PENDING_FILE
    pending_data = _read_json(pending)
    if pending_data and pending_data.get("version") == journal.get("version"):
        pending.unlink(missing_ok=True)
    journal_path.unlink(missing_ok=True)
    _LOGGER.warning("Se restauró la integración ZK901 después de una instalación interrumpida")


def _install_verified_package(
    config_dir_text: str,
    files: dict[str, bytes],
    bundle: bytes,
    version: str,
    previous_version: str,
    resource: dict[str, Any],
) -> dict[str, Any]:
    """Stage and replace only this integration and its versioned card bundle."""
    config_dir = Path(config_dir_text).resolve()
    target = _backend_target(config_dir)
    state = _state_dir(config_dir)
    static_dir = config_dir / "www" / "liectroux-zk901"
    if (
        _path_has_symlink(config_dir, target.parent)
        or target.is_symlink()
        or not target.is_dir()
        or _path_has_symlink(config_dir, static_dir)
        or _path_has_symlink(config_dir, state / "backups")
    ):
        raise UpdaterError("No se encuentra una carpeta local segura de esta integración")
    versioned_name = f"liectroux-zk901-map-card-{version}.js"
    versioned_asset = static_dir / versioned_name
    if versioned_asset.is_symlink():
        raise UpdaterError("El archivo versionado de la tarjeta es un enlace simbólico")
    if versioned_asset.exists() and versioned_asset.read_bytes() != bundle:
        raise UpdaterError("Ya existe un bundle distinto con el mismo número de versión")
    owns_versioned_asset = not versioned_asset.exists()

    _probe_directory(target.parent)
    try:
        _probe_directory(static_dir)
    except OSError as err:
        raise UpdaterError(f"No se puede escribir el bundle Lovelace: {err}") from err
    _probe_directory(state)
    old_bytes = _tree_size(target)
    existing_card = _resource_path(config_dir, resource.get("url"))
    if existing_card is not None and _path_has_symlink(config_dir, existing_card):
        raise UpdaterError("La ruta del recurso Lovelace contiene un enlace simbólico")
    current_card_bytes = 0
    if existing_card is not None and existing_card.is_file() and not existing_card.is_symlink():
        current_card_bytes = existing_card.stat().st_size
    required_space = old_bytes * 2 + sum(len(data) for data in files.values()) + len(bundle) + current_card_bytes + 1024 * 1024
    if shutil.disk_usage(target.parent).free < required_space:
        raise UpdaterError("No hay espacio suficiente para preparar y respaldar la integración")
    if shutil.disk_usage(static_dir).free < len(bundle) + 1024 * 1024:
        raise UpdaterError("No hay espacio suficiente para el nuevo bundle Lovelace")
    if shutil.disk_usage(state).free < old_bytes + current_card_bytes + 1024 * 1024:
        raise UpdaterError("No hay espacio suficiente para guardar el respaldo de recuperación")

    stamp = f"{int(time.time())}-{previous_version}-to-{version}-{os.urandom(4).hex()}"
    backup_dir = state / "backups" / stamp
    if backup_dir.exists():
        raise UpdaterError("Ya existe una copia con el identificador de esta instalación")
    backend_backup = backup_dir / "backend"
    backup_dir.mkdir(parents=True, mode=0o700)
    frontend_backup: str | None = None
    try:
        shutil.copytree(target, backend_backup, symlinks=True)
        if existing_card is not None and existing_card.is_file():
            frontend_path = backup_dir / "frontend"
            frontend_path.mkdir(mode=0o700)
            saved_card = frontend_path / existing_card.name
            shutil.copyfile(existing_card, saved_card)
            frontend_backup = saved_card.relative_to(config_dir).as_posix()
    except Exception:
        shutil.rmtree(backup_dir, ignore_errors=True)
        raise

    relative_backup = backup_dir.relative_to(config_dir).as_posix()
    pending = {
        "action": "install",
        "version": version,
        "previous_version": previous_version,
        "backup": relative_backup,
        "resource_mode": resource.get("mode"),
        "resource_id": resource.get("id"),
        "resource_before": resource.get("url"),
        "resource_after": _versioned_resource_url(version),
        "resource_path_before": (
            existing_card.relative_to(config_dir).as_posix() if existing_card is not None else None
        ),
        "frontend_backup": frontend_backup,
        "asset_created": owns_versioned_asset,
    }
    journal = {
        "phase": "applying",
        "version": version,
        "backup": relative_backup,
        "new_asset": f"www/liectroux-zk901/{versioned_name}",
        "new_asset_owned": owns_versioned_asset,
        "completed": [],
    }
    journal_path = state / TRANSACTION_FILE
    _write_json_atomic(journal_path, journal)

    try:
        if not versioned_asset.exists():
            descriptor, temporary_name = tempfile.mkstemp(prefix=f".{versioned_name}.", dir=static_dir)
            temporary = Path(temporary_name)
            try:
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(bundle)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.chmod(temporary, 0o644)
                os.replace(temporary, versioned_asset)
            finally:
                temporary.unlink(missing_ok=True)
        journal["completed"].append("frontend")
        _write_json_atomic(journal_path, journal)

        backend_files = {
            name.removeprefix(f"custom_components/{DOMAIN}/"): data
            for name, data in files.items()
            if name.startswith(f"custom_components/{DOMAIN}/")
        }
        staged_dir = Path(tempfile.mkdtemp(prefix=f".{DOMAIN}.stage-", dir=target.parent))
        try:
            for name, data in backend_files.items():
                stage_path = staged_dir / name
                stage_path.parent.mkdir(parents=True, exist_ok=True)
                stage_path.write_bytes(data)
                os.chmod(stage_path, 0o644)
            ordered_names = sorted(name for name in backend_files if name != "__init__.py")
            ordered_names.append("__init__.py")
            for relative in ordered_names:
                source = staged_dir / relative
                destination = target / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                descriptor, temporary_name = tempfile.mkstemp(
                    prefix=f".{destination.name}.", dir=destination.parent
                )
                temporary = Path(temporary_name)
                try:
                    with os.fdopen(descriptor, "wb") as stream:
                        stream.write(source.read_bytes())
                        stream.flush()
                        os.fsync(stream.fileno())
                    os.chmod(temporary, 0o644)
                    os.replace(temporary, destination)
                finally:
                    temporary.unlink(missing_ok=True)
                journal["completed"].append(f"backend/{relative}")
                _write_json_atomic(journal_path, journal)

            for cache_dir in sorted(target.rglob("__pycache__"), reverse=True):
                if cache_dir.is_dir() and not cache_dir.is_symlink():
                    shutil.rmtree(cache_dir)
                    journal["completed"].append(f"removed/{cache_dir.relative_to(target)}")
                    _write_json_atomic(journal_path, journal)

            for stale_module in target.glob("*.py"):
                if stale_module.name not in backend_files and not stale_module.is_symlink():
                    stale_module.unlink()
                    journal["completed"].append(f"removed/{stale_module.name}")
                    _write_json_atomic(journal_path, journal)
        finally:
            shutil.rmtree(staged_dir, ignore_errors=True)

        _write_json_atomic(state / LAST_INSTALL_FILE, pending)
        _write_json_atomic(state / PENDING_FILE, pending)
        journal["phase"] = "complete"
        _write_json_atomic(journal_path, journal)
        journal_path.unlink(missing_ok=True)
    except Exception as err:
        try:
            _restore_backend_tree(config_dir, backend_backup)
            if owns_versioned_asset:
                versioned_asset.unlink(missing_ok=True)
            (state / PENDING_FILE).unlink(missing_ok=True)
            (state / LAST_INSTALL_FILE).unlink(missing_ok=True)
            journal_path.unlink(missing_ok=True)
        except Exception as restore_err:
            raise UpdaterError(
                f"Falló la instalación ({err}) y la restauración quedó pendiente. "
                f"Al reiniciar, la integración intentará recuperar el respaldo {relative_backup}."
            ) from restore_err
        raise UpdaterError(f"La instalación se revirtió: {err}") from err
    return pending


def _restore_previous_package(config_dir_text: str, install_record: dict[str, Any]) -> None:
    config_dir = Path(config_dir_text).resolve()
    backup = _validate_local_backup(config_dir, install_record.get("backup"))
    backend_backup = backup / "backend"
    if not backend_backup.is_dir():
        raise UpdaterError("La carpeta del respaldo está incompleta")
    version = install_record.get("version")
    previous_version = install_record.get("previous_version")
    if _version_parts(version) is None or _version_parts(previous_version) is None:
        raise UpdaterError("El registro del respaldo tiene versiones inválidas")
    state = _state_dir(config_dir)
    journal = {
        "phase": "restoring",
        "version": version,
        "backup": install_record["backup"],
        "new_asset": f"www/liectroux-zk901/liectroux-zk901-map-card-{version}.js",
        "new_asset_owned": install_record.get("asset_created") is True,
        "completed": [],
    }
    _write_json_atomic(state / TRANSACTION_FILE, journal)
    _restore_backend_tree(config_dir, backend_backup)
    if install_record.get("resource_mode") == MODE_STORAGE:
        asset = config_dir / "www/liectroux-zk901" / f"liectroux-zk901-map-card-{version}.js"
        if install_record.get("asset_created") is True and not asset.is_symlink():
            asset.unlink(missing_ok=True)
    install_record["restored"] = True
    install_record["restored_to"] = previous_version
    _write_json_atomic(state / LAST_INSTALL_FILE, install_record)
    # Cancel the prepared release too when rolling back before its first reboot.
    pending = _read_json(state / PENDING_FILE)
    if (
        pending is not None
        and pending.get("version") == version
        and pending.get("backup") == install_record["backup"]
    ):
        (state / PENDING_FILE).unlink(missing_ok=True)
    journal["phase"] = "complete"
    _write_json_atomic(state / TRANSACTION_FILE, journal)
    (state / TRANSACTION_FILE).unlink(missing_ok=True)


class ZK901UpdateManager:
    """Shared updater state and install lock for the entire integration domain."""

    def __init__(self, hass: HomeAssistant, installed_version: str) -> None:
        self.hass = hass
        self.installed_version = installed_version
        self.release: ReleaseCandidate | None = None
        self.last_check_error: str | None = None
        self._last_checked = 0.0
        self._check_lock = asyncio.Lock()
        self.install_lock = asyncio.Lock()
        self._startup_lock = asyncio.Lock()
        self._startup_processed = False
        self._platforms: dict[str, AddEntitiesCallback] = {}
        self._owner_entry_id: str | None = None
        self.entity: Any = None

    @property
    def config_dir(self) -> Path:
        return Path(self.hass.config.config_dir)

    @property
    def state_dir(self) -> Path:
        return _state_dir(self.config_dir)

    @property
    def pending_install(self) -> dict[str, Any] | None:
        return _read_json(self.state_dir / PENDING_FILE)

    @property
    def last_install(self) -> dict[str, Any] | None:
        return _read_json(self.state_dir / LAST_INSTALL_FILE)

    @property
    def disk_version(self) -> str:
        """Version installed on disk, distinct from the running Python modules."""
        pending = self.pending_install
        if pending and isinstance(pending.get("version"), str):
            return pending["version"]
        record = self.last_install
        if record and record.get("restored") and isinstance(record.get("restored_to"), str):
            return record["restored_to"]
        return self.installed_version

    @property
    def restart_pending(self) -> bool:
        return self.disk_version != self.installed_version

    def _sync_restart_request(self) -> None:
        """Use HA's native restart prompt, with Repairs on older HA releases."""
        if not self.restart_pending:
            ir.async_delete_issue(self.hass, DOMAIN, "restart_required")
            return
        if system_state is not None:
            ir.async_delete_issue(self.hass, DOMAIN, "restart_required")
            system_state.async_set_home_assistant_restart_required(self.hass, DOMAIN)
        else:
            ir.async_create_issue(
                self.hass, DOMAIN, "restart_required",
                is_fixable=True, severity=ir.IssueSeverity.WARNING,
                translation_key="restart_required",
            )
        persistent_notification.async_dismiss(self.hass, _NOTIFICATION_ID)

    @property
    def summary(self) -> str:
        if self.restart_pending:
            return f"Versión {self.disk_version} instalada. Reinicio pendiente."
        last_install = self.last_install
        if last_install and last_install.get("resource_status") == "failed":
            detail = last_install.get("resource_error")
            return f"El backend está activo, pero falló el recurso Lovelace: {detail}"
        if last_install and last_install.get("resource_status") == "yaml_manual":
            return "El backend está activo; actualizá manualmente en YAML la URL del recurso Lovelace."
        if self.last_check_error:
            return "No se pudo consultar GitHub. El control LAN de la aspiradora sigue disponible."
        if self.release is None:
            return "No se encontró una release estable completa más reciente."
        if self.release.notes:
            return self.release.notes[:255]
        return f"Versión estable {self.release.version} disponible."

    def register_platform(
        self,
        entry: ConfigEntry,
        add_entities: AddEntitiesCallback,
        entity_factory,
    ) -> None:
        self._platforms[entry.entry_id] = add_entities
        if self._owner_entry_id is None:
            self._owner_entry_id = entry.entry_id
            self.entity = entity_factory(self)
            add_entities([self.entity])

    def unregister_platform(self, entry_id: str, entity_factory) -> None:
        self._platforms.pop(entry_id, None)
        if self._owner_entry_id != entry_id:
            return
        self._owner_entry_id = None
        self.entity = None
        if self._platforms:
            next_entry, add_entities = next(iter(self._platforms.items()))
            self._owner_entry_id = next_entry
            self.entity = entity_factory(self)
            add_entities([self.entity])

    async def async_check(self, *, force: bool = False) -> None:
        if self._check_lock.locked():
            return
        async with self._check_lock:
            if not force and time.monotonic() - self._last_checked < 15 * 60:
                return
            self._last_checked = time.monotonic()
            session = async_get_clientsession(self.hass)
            try:
                release = await async_find_latest_release(session, self.installed_version)
            except UpdaterError as err:
                self.last_check_error = str(err)
                _LOGGER.debug("No se pudo consultar la actualización ZK901: %s", err)
                self._write_entity_state()
                return
            self.release = release
            self.last_check_error = None
            self._write_entity_state()

    async def async_install(self, version: str | None = None) -> None:
        if self.install_lock.locked():
            raise UpdaterError("Ya hay una instalación o restauración en curso")
        async with self.install_lock:
            pending = self.pending_install
            if pending or self.restart_pending:
                raise UpdaterError("Hay una versión preparada. Reiniciá Home Assistant antes de instalar otra.")
            release = self.release
            if version is not None:
                if release is None or release.version != version:
                    raise UpdaterError("La versión solicitada no es la release disponible")
            if release is None:
                await self.async_check(force=True)
                release = self.release
            if release is None:
                raise UpdaterError("No hay una release estable completa para instalar")

            resource = await self._async_card_resource()
            if resource.get("mode") == MODE_STORAGE:
                if not resource.get("id") or not resource.get("url"):
                    raise UpdaterError("No se encontró un único recurso Lovelace de la tarjeta en modo storage")
                local_resource = _resource_path(self.config_dir, resource["url"])
                if local_resource is None or not local_resource.is_file():
                    raise UpdaterError("El recurso Lovelace actual no apunta a un archivo local de la tarjeta")
            session = async_get_clientsession(self.hass)
            try:
                checksums_bytes, metadata_bytes, archive_bytes, bundle_bytes = await asyncio.gather(
                    _read_bounded_response(session, release.assets[CHECKSUMS_NAME], MAX_CHECKSUMS_SIZE),
                    _read_bounded_response(session, release.assets[MANIFEST_NAME], MAX_METADATA_SIZE),
                    _read_bounded_response(session, release.assets[ARCHIVE_NAME], MAX_ARCHIVE_SIZE),
                    _read_bounded_response(session, release.assets[BUNDLE_NAME], MAX_BUNDLE_SIZE),
                )
                checksums = _parse_checksums(checksums_bytes)
                if hashlib.sha256(metadata_bytes).hexdigest() != checksums.get(MANIFEST_NAME):
                    raise UpdaterError("El hash del manifest no coincide con SHA256SUMS")
                metadata = _validate_metadata(json.loads(metadata_bytes), release.version)
                files = verify_release_archive(
                    archive_bytes,
                    bundle_bytes,
                    version=release.version,
                    metadata=metadata,
                    checksums=checksums,
                )
            except UpdaterError:
                raise
            except (aiohttp.ClientError, asyncio.TimeoutError, json.JSONDecodeError, UnicodeDecodeError) as err:
                raise UpdaterError(f"No se pudo verificar el paquete descargado: {err}") from err

            try:
                await self.hass.async_add_executor_job(
                    _install_verified_package,
                    str(self.config_dir), files, bundle_bytes, release.version,
                    self.installed_version, resource,
                )
            except UpdaterError:
                raise
            except Exception as err:
                raise UpdaterError(f"No se pudo preparar la actualización: {err}") from err
            self._sync_restart_request()
            self._write_entity_state()

    async def async_restore_previous(self) -> None:
        if self.install_lock.locked():
            raise UpdaterError("Ya hay una instalación o restauración en curso")
        async with self.install_lock:
            record = self.last_install
            if not record or record.get("restored"):
                raise UpdaterError("No hay un respaldo anterior disponible para restaurar")
            backup = _validate_local_backup(self.config_dir, record.get("backup"))
            backend_backup = backup / "backend"
            if not backend_backup.is_dir():
                raise UpdaterError("La copia de la integración está incompleta")

            resource = await self._async_card_resource()
            if resource.get("mode") == MODE_STORAGE:
                desired_url = record.get("resource_before")
                current_url = record.get("resource_after")
                if not isinstance(desired_url, str) or not isinstance(current_url, str):
                    raise UpdaterError("El respaldo no conserva la URL anterior de Lovelace")
                try:
                    await self.hass.async_add_executor_job(
                        _restore_saved_frontend, self.config_dir, backup, record
                    )
                except Exception as err:
                    raise UpdaterError(f"No se pudo preparar el frontend anterior: {err}") from err
                await self._async_change_resource_url(
                    resource,
                    expected_url=current_url,
                    new_url=desired_url,
                )
            elif resource.get("mode") != MODE_STORAGE:
                persistent_notification.async_create(
                    self.hass,
                    "Se restaurará el backend. Como los recursos Lovelace están en YAML, actualizá allí la URL de la tarjeta a la versión anterior después del reinicio.",
                    title="Restauración Liectroux ZK901",
                    notification_id=_NOTIFICATION_ID,
                )

            try:
                await self.hass.async_add_executor_job(
                    _restore_previous_package,
                    str(self.config_dir),
                    record,
                )
            except Exception as err:
                raise UpdaterError(
                    f"No se pudo completar la restauración: {err}. "
                    "Si el proceso llegó a escribir el journal, reiniciá Home Assistant para recuperar el backend."
                ) from err
            self._sync_restart_request()
            self._write_entity_state()

    async def async_process_startup_state(self) -> None:
        async with self._startup_lock:
            if self._startup_processed:
                return
            self._startup_processed = True
            self._sync_restart_request()
            pending = self.pending_install
            if pending and pending.get("version") == self.installed_version:
                if pending.get("resource_mode") == MODE_STORAGE:
                    try:
                        resource = await self._async_card_resource()
                        await self._async_change_resource_url(
                            resource,
                            expected_url=pending.get("resource_before"),
                            new_url=pending.get("resource_after"),
                            item_id=pending.get("resource_id"),
                        )
                    except (UpdaterError, TypeError) as err:
                        await self._record_resource_problem(pending, str(err))
                        return
                    pending["resource_status"] = "updated"
                    pending["resource_error"] = None
                    message = (
                        f"La versión {self.installed_version} está activa. Recargá el navegador para cargar la tarjeta nueva."
                    )
                else:
                    pending["resource_status"] = "yaml_manual"
                    pending["resource_error"] = "El recurso Lovelace se administra en YAML"
                    message = (
                        f"El backend {self.installed_version} está activo. El recurso Lovelace se administra en YAML; cambiá su URL a {_versioned_resource_url(self.installed_version)} y recargá el navegador."
                    )
                await self.hass.async_add_executor_job(
                    self._finish_pending_record, pending
                )
                persistent_notification.async_create(
                    self.hass,
                    message,
                    title="Actualización Liectroux ZK901",
                    notification_id=_NOTIFICATION_ID,
                )
                return

            if pending and pending.get("version") != self.installed_version:
                # The backend on disk is still the previous version; keep the prepared state visible.
                return

            await self._async_migrate_initial_resource()

    async def _async_migrate_initial_resource(self) -> None:
        """Version the bootstrap bundle installed manually with release 0.3.0."""
        try:
            resource = await self._async_card_resource()
        except UpdaterError as err:
            _LOGGER.debug("No se pudo inspeccionar el recurso Lovelace: %s", err)
            return
        if resource.get("mode") != MODE_STORAGE:
            return
        url = resource.get("url")
        if not isinstance(url, str):
            return
        try:
            parts = urlsplit(url)
        except ValueError:
            return
        if parts.path != "/local/liectroux-zk901/liectroux-zk901-map-card.js":
            return
        source = self.config_dir / "www/liectroux-zk901" / BUNDLE_NAME
        if _path_has_symlink(self.config_dir, source) or not source.is_file():
            return
        target = self.config_dir / "www/liectroux-zk901" / f"liectroux-zk901-map-card-{self.installed_version}.js"
        try:
            copied = await self.hass.async_add_executor_job(
                _copy_current_bundle_if_version_matches,
                source,
                target,
                self.installed_version,
            )
            if not copied:
                return
            await self._async_change_resource_url(
                resource,
                expected_url=url,
                new_url=_versioned_resource_url(self.installed_version),
            )
        except (UpdaterError, OSError) as err:
            _LOGGER.warning("No se pudo versionar el recurso inicial ZK901: %s", err)
            persistent_notification.async_create(
                self.hass,
                f"El backend {self.installed_version} está cargado, pero no se pudo actualizar el recurso Lovelace automáticamente: {err}",
                title="Recurso Liectroux ZK901",
                notification_id=_NOTIFICATION_ID,
            )

    async def _async_card_resource(self) -> dict[str, Any]:
        data = self.hass.data.get(LOVELACE_DATA)
        if data is None or not hasattr(data, "resources"):
            raise UpdaterError("La colección de recursos Lovelace no está cargada")
        collection = data.resources
        try:
            await collection.async_get_info()
            items = collection.async_items() or []
        except Exception as err:
            raise UpdaterError(f"No se pudo leer la colección de recursos Lovelace: {err}") from err
        matches = [item for item in items if _is_card_resource(item)]
        if len(matches) > 1:
            raise UpdaterError("Hay más de un recurso Lovelace para la tarjeta; no se modificó ninguno")
        item = matches[0] if matches else None
        return {
            "mode": getattr(data, "resource_mode", None),
            "id": item.get("id") if item else None,
            "url": item.get("url") if item else None,
        }

    async def _async_change_resource_url(
        self,
        resource: dict[str, Any],
        *,
        expected_url: str | None,
        new_url: str,
        item_id: str | None = None,
    ) -> None:
        data = self.hass.data.get(LOVELACE_DATA)
        if data is None or getattr(data, "resource_mode", None) != MODE_STORAGE:
            raise UpdaterError("La actualización automática requiere recursos Lovelace en modo storage")
        collection = data.resources
        items = collection.async_items() or []
        target_id = item_id or resource.get("id")
        if not isinstance(target_id, str):
            raise UpdaterError("No se encontró el ID del recurso Lovelace que se debe actualizar")
        item = next((value for value in items if isinstance(value, dict) and value.get("id") == target_id), None)
        if item is None:
            raise UpdaterError("El recurso Lovelace fue eliminado; se conserva el respaldo")
        current_url = item.get("url")
        if current_url == new_url:
            return
        if current_url != expected_url:
            raise UpdaterError("El recurso Lovelace cambió desde la instalación; se conserva el respaldo")
        if not BUNDLE_RESOURCE_RE.fullmatch(urlsplit(new_url).path):
            raise UpdaterError("La nueva URL de tarjeta no está dentro de la ruta permitida")
        try:
            await collection.async_update_item(target_id, {"url": new_url})
        except Exception as err:
            raise UpdaterError(f"Home Assistant no pudo actualizar el recurso Lovelace: {err}") from err

    async def _record_resource_problem(self, pending: dict[str, Any], detail: str) -> None:
        pending["resource_status"] = "failed"
        pending["resource_error"] = detail[:2000]
        try:
            await self.hass.async_add_executor_job(
                partial(self._finish_pending_record, pending, keep_pending=True)
            )
        except OSError:
            _LOGGER.exception("No se pudo guardar el estado del recurso de tarjeta")
        persistent_notification.async_create(
            self.hass,
            f"El backend {self.installed_version} cargó, pero Home Assistant no pudo cambiar el recurso Lovelace. El respaldo se conserva. Detalle: {detail}",
            title="Actualización ZK901 requiere atención",
            notification_id=_NOTIFICATION_ID,
        )

    def _finish_pending_record(self, pending: dict[str, Any], *, keep_pending: bool = False) -> None:
        _write_json_atomic(self.state_dir / LAST_INSTALL_FILE, pending)
        if not keep_pending:
            (self.state_dir / PENDING_FILE).unlink(missing_ok=True)

    async def _write_state(self, filename: str, value: dict[str, Any]) -> None:
        await self.hass.async_add_executor_job(_write_json_atomic, self.state_dir / filename, value)

    def _write_entity_state(self) -> None:
        entity = self.entity
        if entity is not None and getattr(entity, "hass", None) is not None:
            entity._sync_manager_state()
            entity.async_write_ha_state()


def _copy_current_bundle_if_version_matches(source: Path, target: Path, version: str) -> bool:
    if source.is_symlink() or target.is_symlink():
        raise UpdaterError("El bundle Lovelace es un enlace simbólico")
    bundle = source.read_bytes()
    if len(bundle) > MAX_BUNDLE_SIZE or f"v{version}".encode() not in bundle:
        return False
    if target.exists():
        if target.read_bytes() == bundle:
            return True
        raise UpdaterError("Ya existe un bundle distinto con la misma versión")
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(bundle)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    return True


def _is_card_resource(item: object) -> bool:
    if not isinstance(item, dict) or not isinstance(item.get("url"), str):
        return False
    try:
        parts = urlsplit(item["url"])
    except ValueError:
        return False
    return not parts.scheme and not parts.netloc and bool(BUNDLE_RESOURCE_RE.fullmatch(parts.path))


def _restore_saved_frontend(
    config_dir: Path,
    backup: Path,
    install_record: dict[str, Any],
) -> None:
    """Ensure the previous bundle still exists before switching its URL back."""
    resource_url = install_record.get("resource_before")
    saved_relative = install_record.get("frontend_backup")
    target = _resource_path(config_dir, resource_url)
    if target is None or _path_has_symlink(config_dir, target):
        raise UpdaterError("La URL anterior no apunta a un archivo local permitido")
    if not isinstance(saved_relative, str):
        raise UpdaterError("Falta el respaldo del frontend anterior")
    saved_path = config_dir / saved_relative
    if _path_has_symlink(config_dir, saved_path):
        raise UpdaterError("La ruta del frontend del respaldo contiene un enlace simbólico")
    saved = saved_path.resolve()
    if not saved.is_relative_to(backup.resolve()) or not saved.is_file():
        raise UpdaterError("El archivo frontend del respaldo no es válido")
    saved_bytes = saved.read_bytes()
    if target.is_file() and target.read_bytes() == saved_bytes:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(saved_bytes)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
