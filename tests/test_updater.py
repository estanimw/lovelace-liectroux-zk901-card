"""Release selection, package verification and recoverable install tests."""

from __future__ import annotations

import asyncio
from io import BytesIO
import json
import hashlib
from pathlib import Path
from types import SimpleNamespace
import threading
import zipfile

import pytest

from homeassistant.components.lovelace.const import LOVELACE_DATA
from homeassistant.components.update import UpdateEntityFeature
from homeassistant.core import HomeAssistant

from custom_components.liectroux_zk901 import updater
from custom_components.liectroux_zk901 import update as update_platform
from custom_components.liectroux_zk901.update import ZK901SoftwareUpdate


VERSION = "0.3.0"
BUNDLE = b"console.info('Liectroux ZK901 Map Card v0.3.0');"


def _package(version: str = VERSION) -> tuple[dict[str, bytes], dict, bytes, dict[str, str]]:
    integration_prefix = f"custom_components/{updater.DOMAIN}/"
    files = {
        f"{integration_prefix}{name}": b"# integration module\n"
        for name in (
            "button.py",
            "client.py",
            "config_flow.py",
            "coordinator.py",
            "entity.py",
            "select.py",
            "sensor.py",
            "update.py",
            "updater.py",
            "vacuum.py",
            "zone_editor.py",
        )
    }
    files.update({
        f"{integration_prefix}__init__.py": b'"""Integration."""\n',
        f"{integration_prefix}const.py": b"CARD_API_VERSION = 1\n",
        f"{integration_prefix}manifest.json": json.dumps(
            {"domain": updater.DOMAIN, "version": version}
        ).encode(),
        f"{integration_prefix}services.yaml": b"# integration services\n",
        f"{integration_prefix}translations/en.json": b"{}\n",
        f"{integration_prefix}translations/es.json": b"{}\n",
        updater.BUNDLE_PATH: f"console.info('Liectroux ZK901 Map Card v{version}');".encode(),
    })
    file_hashes = {name: hashlib.sha256(content).hexdigest() for name, content in files.items()}
    metadata = {
        "format_version": 2,
        "card_version": version,
        "integration_version": version,
        "integration_domain": updater.DOMAIN,
        "archive": updater.ARCHIVE_NAME,
        "compatibility": {
            "frontend_version": version,
            "backend_version": version,
            "card_api_version": 1,
            "home_assistant_tested": "2026.9.2",
        },
        "files": file_hashes,
    }
    archive_bytes = _zip(files)
    checksums = {
        updater.BUNDLE_NAME: hashlib.sha256(files[updater.BUNDLE_PATH]).hexdigest(),
        updater.ARCHIVE_NAME: hashlib.sha256(archive_bytes).hexdigest(),
        updater.MANIFEST_NAME: hashlib.sha256(json.dumps(metadata).encode()).hexdigest(),
    }
    return files, metadata, archive_bytes, checksums


def _zip(files: dict[str, bytes], *, symlink: str | None = None) -> bytes:
    output = BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
        if symlink is not None:
            info = zipfile.ZipInfo(symlink)
            info.create_system = 3
            info.external_attr = (0o120777 << 16)
            archive.writestr(info, b"../../outside.py")
    return output.getvalue()


def _release(version: str, metadata: dict, checksums: dict[str, str], archive: bytes, bundle: bytes) -> dict:
    tag = f"v{version}"
    contents = {
        updater.CHECKSUMS_NAME: "".join(f"{digest}  {name}\n" for name, digest in checksums.items()).encode(),
        updater.MANIFEST_NAME: json.dumps(metadata).encode(),
        updater.ARCHIVE_NAME: archive,
        updater.BUNDLE_NAME: bundle,
    }
    assets = [
        {
            "name": name,
            "size": len(content),
            "browser_download_url": updater._expected_asset_url(tag, name),
        }
        for name, content in contents.items()
    ]
    raw = {
        "draft": False,
        "prerelease": False,
        "tag_name": tag,
        "published_at": "2026-10-18T12:00:00Z",
        "html_url": f"https://github.com/{updater.OWNER}/{updater.REPOSITORY}/releases/tag/{tag}",
        "body": f"Release {version} notes",
        "assets": assets,
    }
    return raw, contents


class _FakeResponse:
    def __init__(self, url: str, content: bytes) -> None:
        self.status = 200
        self.content_length = len(content)
        self.url = SimpleNamespace(host=updater.urlsplit(url).hostname)
        self.history = []
        self.content = self
        self._content = content

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def iter_chunked(self, size: int):
        for start in range(0, len(self._content), size):
            yield self._content[start : start + size]


class _FakeSession:
    def __init__(self, api: list[dict], assets: dict[str, bytes]) -> None:
        self.api = api
        self.assets = assets

    def get(self, url: str, **_kwargs):
        if url == updater.RELEASES_API:
            content = json.dumps(self.api).encode()
        else:
            content = self.assets[url]
        return _FakeResponse(url, content)


@pytest.mark.parametrize("failure", ["declared_size", "streamed_size", "redirect_host"])
def test_bounded_download_rejects_oversize_and_untrusted_hosts(failure):
    response = _FakeResponse("https://github.com/file", b"12345")
    if failure == "streamed_size":
        response.content_length = None
    elif failure == "redirect_host":
        response.url = SimpleNamespace(host="attacker.example")

    class Session:
        def get(self, _url, **_kwargs):
            return response

    with pytest.raises(updater.UpdaterError):
        asyncio.run(updater._read_bounded_response(Session(), "https://github.com/file", 4))


def test_release_discovery_skips_incomplete_and_prerelease_releases():
    files, metadata, archive, checksums = _package()
    complete, contents = _release(VERSION, metadata, checksums, archive, files[updater.BUNDLE_PATH])
    incomplete = json.loads(json.dumps(complete))
    incomplete["tag_name"] = "v0.4.0"
    incomplete["html_url"] = f"https://github.com/{updater.OWNER}/{updater.REPOSITORY}/releases/tag/v0.4.0"
    incomplete["assets"] = incomplete["assets"][:-1]
    prerelease = json.loads(json.dumps(complete))
    prerelease["tag_name"] = "v0.9.0"
    prerelease["prerelease"] = True
    assets = {
        updater._expected_asset_url("v0.3.0", name): value
        for name, value in contents.items()
    }

    result = asyncio.run(
        updater.async_find_latest_release(
            _FakeSession([incomplete, prerelease, complete], assets), "0.2.0"
        )
    )

    assert result is not None
    assert result.version == "0.3.0"
    assert result.notes == "Release 0.3.0 notes"


def test_release_discovery_rejects_mismatched_release_metadata():
    files, metadata, archive, checksums = _package()
    metadata["integration_version"] = "0.2.9"
    raw, contents = _release(VERSION, metadata, checksums, archive, files[updater.BUNDLE_PATH])
    assets = {
        updater._expected_asset_url("v0.3.0", name): value
        for name, value in contents.items()
    }

    result = asyncio.run(
        updater.async_find_latest_release(_FakeSession([raw], assets), "0.2.0")
    )

    assert result is None


def test_archive_verification_accepts_only_version_matched_allowlisted_files():
    files, metadata, archive, checksums = _package()

    verified = updater.verify_release_archive(
        archive,
        files[updater.BUNDLE_PATH],
        version=VERSION,
        metadata=metadata,
        checksums=checksums,
    )

    assert set(verified) == set(files)
    assert verified[updater.BUNDLE_PATH] == files[updater.BUNDLE_PATH]


@pytest.mark.parametrize("problem", ["bad_hash", "path_traversal", "symlink", "duplicate", "version_mismatch"])
def test_archive_verification_rejects_malformed_packages(problem):
    files, metadata, archive, checksums = _package()
    if problem == "bad_hash":
        checksums[updater.ARCHIVE_NAME] = "0" * 64
    elif problem == "path_traversal":
        output = BytesIO()
        with zipfile.ZipFile(output, "w") as package:
            for name, content in files.items():
                package.writestr(name, content)
            package.writestr("../../outside.py", b"bad")
        archive = output.getvalue()
        checksums[updater.ARCHIVE_NAME] = hashlib.sha256(archive).hexdigest()
    elif problem == "symlink":
        archive = _zip(files, symlink=f"custom_components/{updater.DOMAIN}/unsafe.py")
        metadata["files"][f"custom_components/{updater.DOMAIN}/unsafe.py"] = hashlib.sha256(b"../../outside.py").hexdigest()
        checksums[updater.ARCHIVE_NAME] = hashlib.sha256(archive).hexdigest()
    elif problem == "duplicate":
        output = BytesIO()
        with zipfile.ZipFile(output, "w") as package:
            for name, content in files.items():
                package.writestr(name, content)
            package.writestr(next(iter(files)), b"duplicate")
        archive = output.getvalue()
        checksums[updater.ARCHIVE_NAME] = hashlib.sha256(archive).hexdigest()
    elif problem == "version_mismatch":
        metadata["compatibility"]["frontend_version"] = "0.2.0"

    with pytest.raises(updater.UpdaterError):
        updater.verify_release_archive(
            archive,
            files[updater.BUNDLE_PATH],
            version=VERSION,
            metadata=metadata,
            checksums=checksums,
        )


def test_install_keeps_backup_and_existing_resource_until_restart(tmp_path):
    files, _metadata, _archive, _checksums = _package()
    target = tmp_path / "custom_components" / updater.DOMAIN
    target.mkdir(parents=True)
    (target / "__init__.py").write_text("old init\n")
    (target / "obsolete.py").write_text("old module\n")
    (target / "manifest.json").write_text('{"version":"0.2.0"}\n')
    legacy_editor = target / "www/liectroux-zk901-zone-editor.js"
    legacy_editor.parent.mkdir()
    legacy_editor.write_bytes(b"legacy editor")
    unrelated = tmp_path / "custom_components/other_component/__init__.py"
    unrelated.parent.mkdir(parents=True)
    unrelated.write_text("leave me alone\n")
    old_card = tmp_path / "www/liectroux-zk901" / updater.BUNDLE_NAME
    old_card.parent.mkdir(parents=True)
    old_card.write_bytes(b"old card v0.2.0")

    pending = updater._install_verified_package(
        str(tmp_path),
        files,
        files[updater.BUNDLE_PATH],
        VERSION,
        "0.2.0",
        {"mode": "storage", "id": "resource-id", "url": "/local/liectroux-zk901/liectroux-zk901-map-card.js?v=0.2.0"},
    )

    assert (target / "manifest.json").read_bytes() == files[f"custom_components/{updater.DOMAIN}/manifest.json"]
    assert not (target / "obsolete.py").exists()
    assert legacy_editor.read_bytes() == b"legacy editor"
    assert unrelated.read_text() == "leave me alone\n"
    assert old_card.read_bytes() == b"old card v0.2.0"
    assert (tmp_path / "www/liectroux-zk901/liectroux-zk901-map-card-0.3.0.js").read_bytes() == files[updater.BUNDLE_PATH]
    assert (tmp_path / updater.STATE_DIRECTORY / updater.PENDING_FILE).is_file()
    assert (tmp_path / pending["backup"] / "backend/obsolete.py").is_file()
    assert pending["resource_before"].endswith("v=0.2.0")
    manager = updater.ZK901UpdateManager(
        SimpleNamespace(config=SimpleNamespace(config_dir=str(tmp_path)), data={}),
        "0.2.0",
    )
    assert manager.restart_pending is True
    assert "reiniciá Home Assistant" in manager.summary


@pytest.mark.parametrize("phase", ["frontend", "backend", "commit"])
def test_install_failure_restores_backend_and_frontend(monkeypatch, tmp_path, phase):
    files, _metadata, _archive, _checksums = _package()
    target = tmp_path / "custom_components" / updater.DOMAIN
    target.mkdir(parents=True)
    (target / "__init__.py").write_text("old init\n")
    (target / "update.py").write_text("old update\n")
    static = tmp_path / "www/liectroux-zk901"
    static.mkdir(parents=True)
    old_card = static / updater.BUNDLE_NAME
    old_card.write_bytes(b"old card")
    original_write_json = updater._write_json_atomic
    failed_once = False

    def fail_during_install(path: Path, value: dict):
        nonlocal failed_once
        should_fail = (
            phase == "backend" and "backend/update.py" in value.get("completed", [])
        ) or (phase == "commit" and path.name == updater.PENDING_FILE)
        if not failed_once and should_fail:
            failed_once = True
            raise OSError(f"simulated {phase} failure")
        return original_write_json(path, value)

    if phase == "frontend":
        original_replace = updater.os.replace

        def fail_frontend_replace(source, destination):
            nonlocal failed_once
            if not failed_once and Path(destination) == static / "liectroux-zk901-map-card-0.3.0.js":
                failed_once = True
                raise OSError("simulated frontend failure")
            return original_replace(source, destination)

        monkeypatch.setattr(updater.os, "replace", fail_frontend_replace)
    else:
        monkeypatch.setattr(updater, "_write_json_atomic", fail_during_install)

    with pytest.raises(updater.UpdaterError, match="se revirtió"):
        updater._install_verified_package(
            str(tmp_path), files, files[updater.BUNDLE_PATH], VERSION, "0.2.0",
            {"mode": "storage", "id": "resource-id", "url": "/local/liectroux-zk901/liectroux-zk901-map-card.js?v=0.2.0"},
        )

    assert (target / "__init__.py").read_text() == "old init\n"
    assert (target / "update.py").read_text() == "old update\n"
    assert old_card.read_bytes() == b"old card"
    assert not (static / "liectroux-zk901-map-card-0.3.0.js").exists()
    assert not (tmp_path / updater.STATE_DIRECTORY / updater.PENDING_FILE).exists()


def test_explicit_restore_reverts_backend_and_resource_url(monkeypatch, tmp_path):
    class ResourceCollection:
        def __init__(self):
            self.items = [{
                "id": "resource-id",
                "url": updater._versioned_resource_url(VERSION),
            }]

        async def async_get_info(self):
            return {"resources": len(self.items)}

        def async_items(self):
            return self.items

        async def async_update_item(self, item_id: str, changes: dict):
            item = next(item for item in self.items if item["id"] == item_id)
            item.update(changes)
            return item

    target = tmp_path / "custom_components" / updater.DOMAIN
    target.mkdir(parents=True)
    (target / "update.py").write_text("new update\n")
    old_backup = tmp_path / updater.STATE_DIRECTORY / "backups" / "previous" / "backend"
    old_backup.mkdir(parents=True)
    (old_backup / "update.py").write_text("old update\n")
    old_card = tmp_path / "www/liectroux-zk901/liectroux-zk901-map-card.js"
    old_card.parent.mkdir(parents=True)
    old_card.write_bytes(b"old card")
    (old_backup.parent / "frontend").mkdir()
    (old_backup.parent / "frontend/liectroux-zk901-map-card.js").write_bytes(b"old card")
    resources = ResourceCollection()

    async def async_add_executor_job(func, *args, **kwargs):
        return func(*args, **kwargs)

    hass = SimpleNamespace(
        config=SimpleNamespace(config_dir=str(tmp_path)),
        data={LOVELACE_DATA: SimpleNamespace(resource_mode="storage", resources=resources)},
        async_add_executor_job=async_add_executor_job,
    )
    manager = updater.ZK901UpdateManager(hass, VERSION)
    record = {
        "action": "install",
        "version": VERSION,
        "previous_version": "0.2.0",
        "backup": f"{updater.STATE_DIRECTORY}/backups/previous",
        "resource_mode": "storage",
        "resource_id": "resource-id",
        "resource_before": "/local/liectroux-zk901/liectroux-zk901-map-card.js?v=0.2.0",
        "resource_after": updater._versioned_resource_url(VERSION),
        "frontend_backup": f"{updater.STATE_DIRECTORY}/backups/previous/frontend/liectroux-zk901-map-card.js",
    }
    updater._write_json_atomic(tmp_path / updater.STATE_DIRECTORY / updater.LAST_INSTALL_FILE, record)

    def async_create(*_args, **_kwargs):
        return None

    monkeypatch.setattr(updater.persistent_notification, "async_create", async_create)

    asyncio.run(manager.async_restore_previous())

    assert (target / "update.py").read_text() == "old update\n"
    assert resources.items[0]["url"] == record["resource_before"]
    assert not (tmp_path / "www/liectroux-zk901/liectroux-zk901-map-card-0.3.0.js").exists()
    restored = json.loads((tmp_path / updater.STATE_DIRECTORY / updater.LAST_INSTALL_FILE).read_text())
    assert restored["restored"] is True


def test_startup_recovery_restores_backup_before_import(tmp_path):
    target = tmp_path / "custom_components" / updater.DOMAIN
    target.mkdir(parents=True)
    (target / "update.py").write_text("partially written\n")
    state = tmp_path / updater.STATE_DIRECTORY
    backup = state / "backups" / "test-backup"
    (backup / "backend").mkdir(parents=True)
    (backup / "backend/update.py").write_text("old update\n")
    updater._write_json_atomic(
        state / updater.TRANSACTION_FILE,
        {
            "phase": "applying",
            "version": VERSION,
            "backup": f"{updater.STATE_DIRECTORY}/backups/test-backup",
            "new_asset": f"www/liectroux-zk901/liectroux-zk901-map-card-{VERSION}.js",
            "new_asset_owned": True,
        },
    )
    new_asset = tmp_path / "www/liectroux-zk901" / f"liectroux-zk901-map-card-{VERSION}.js"
    new_asset.parent.mkdir(parents=True)
    new_asset.write_bytes(BUNDLE)

    updater.recover_interrupted_install(tmp_path)

    assert (target / "update.py").read_text() == "old update\n"
    assert not new_asset.exists()
    assert not (state / updater.TRANSACTION_FILE).exists()


def test_shared_manager_rejects_parallel_installs(tmp_path):
    hass = SimpleNamespace(config=SimpleNamespace(config_dir=str(tmp_path)), data={})
    manager = updater.ZK901UpdateManager(hass, "0.2.0")

    async def run():
        await manager.install_lock.acquire()
        try:
            with pytest.raises(updater.UpdaterError, match="en curso"):
                await manager.async_install()
        finally:
            manager.install_lock.release()

    asyncio.run(run())


def test_update_entity_is_singleton_and_available_without_vacuum(tmp_path):
    hass = SimpleNamespace(config=SimpleNamespace(config_dir=str(tmp_path)), data={})
    manager = updater.ZK901UpdateManager(hass, "0.2.0")

    class Entry:
        def __init__(self, entry_id: str):
            self.entry_id = entry_id

    first_entities = []
    second_entities = []
    manager.register_platform(Entry("first"), first_entities.extend, ZK901SoftwareUpdate)
    manager.register_platform(Entry("second"), second_entities.extend, ZK901SoftwareUpdate)

    assert len(first_entities) == 1
    assert second_entities == []
    assert first_entities[0].installed_version == "0.2.0"
    assert first_entities[0].available is True

    manager.unregister_platform("first", ZK901SoftwareUpdate)

    assert len(second_entities) == 1
    assert second_entities[0].available is True


def test_update_platform_registers_entity_on_home_assistant_2026_9_2(monkeypatch, tmp_path):
    async def run():
        hass = HomeAssistant(str(tmp_path))

        class Entry:
            entry_id = "updater-entry"

        async def no_check(_self, *, force=False):
            del force

        monkeypatch.setattr(updater.ZK901UpdateManager, "async_check", no_check)
        entities = []
        try:
            await update_platform.async_setup_entry(hass, Entry(), entities.extend)
            await hass.async_block_till_done()

            assert len(entities) == 1
            entity = entities[0]
            assert entity.installed_version == json.loads(
                Path(update_platform.__file__).with_name("manifest.json").read_text()
            )["version"]
            assert entity.available is True
            assert entity.supported_features & UpdateEntityFeature.INSTALL
            assert entity.supported_features & UpdateEntityFeature.RELEASE_NOTES
        finally:
            await hass.async_stop(force=True)

    asyncio.run(run())


def test_storage_resource_update_modifies_one_existing_item_only(tmp_path):
    class ResourceCollection:
        def __init__(self):
            self.items = [{"id": "resource-id", "url": "/local/liectroux-zk901/liectroux-zk901-map-card.js?v=0.2.0"}]

        async def async_get_info(self):
            return {"resources": len(self.items)}

        def async_items(self):
            return self.items

        async def async_update_item(self, item_id: str, changes: dict):
            item = next(item for item in self.items if item["id"] == item_id)
            item.update(changes)
            return item

    resources = ResourceCollection()
    hass = SimpleNamespace(
        config=SimpleNamespace(config_dir=str(tmp_path)),
        data={LOVELACE_DATA: SimpleNamespace(resource_mode="storage", resources=resources)},
    )
    manager = updater.ZK901UpdateManager(hass, VERSION)

    async def run():
        current = await manager._async_card_resource()
        await manager._async_change_resource_url(
            current,
            expected_url=current["url"],
            new_url=updater._versioned_resource_url(VERSION),
        )

    asyncio.run(run())

    assert len(resources.items) == 1
    assert resources.items[0]["url"] == updater._versioned_resource_url(VERSION)


def test_pending_update_switches_resource_only_after_new_version_loads(monkeypatch, tmp_path):
    class ResourceCollection:
        def __init__(self):
            self.items = [{
                "id": "resource-id",
                "url": "/local/liectroux-zk901/liectroux-zk901-map-card.js?v=0.2.0",
            }]

        async def async_get_info(self):
            return {"resources": len(self.items)}

        def async_items(self):
            return self.items

        async def async_update_item(self, item_id: str, changes: dict):
            item = next(item for item in self.items if item["id"] == item_id)
            item.update(changes)
            return item

    async def async_add_executor_job(func, *args, **kwargs):
        return func(*args, **kwargs)

    def async_create(*_args, **_kwargs):
        return None

    monkeypatch.setattr(updater.persistent_notification, "async_create", async_create)
    resources = ResourceCollection()
    hass = SimpleNamespace(
        config=SimpleNamespace(config_dir=str(tmp_path)),
        data={LOVELACE_DATA: SimpleNamespace(resource_mode="storage", resources=resources)},
        async_add_executor_job=async_add_executor_job,
    )
    pending = {
        "action": "install",
        "version": VERSION,
        "previous_version": "0.2.0",
        "backup": f"{updater.STATE_DIRECTORY}/backups/previous",
        "resource_mode": "storage",
        "resource_id": "resource-id",
        "resource_before": resources.items[0]["url"],
        "resource_after": updater._versioned_resource_url(VERSION),
    }
    updater._write_json_atomic(tmp_path / updater.STATE_DIRECTORY / updater.PENDING_FILE, pending)

    async def run():
        old_backend = updater.ZK901UpdateManager(hass, "0.2.0")
        await old_backend.async_process_startup_state()
        assert resources.items[0]["url"] == pending["resource_before"]

        loaded_backend = updater.ZK901UpdateManager(hass, VERSION)
        await loaded_backend.async_process_startup_state()

    asyncio.run(run())

    assert resources.items[0]["url"] == updater._versioned_resource_url(VERSION)
    assert not (tmp_path / updater.STATE_DIRECTORY / updater.PENDING_FILE).exists()


class _StorageResources:
    """Replace only the resource collection; keep the HA runtime APIs real."""

    def __init__(self, url):
        self.items = [{"id": "resource-id", "url": url}]

    async def async_get_info(self):
        return {"resources": len(self.items)}

    def async_items(self):
        return self.items

    async def async_update_item(self, item_id, changes):
        item = next(item for item in self.items if item["id"] == item_id)
        item.update(changes)
        return item


def _local_previous_package(root):
    backend = root / "custom_components" / updater.DOMAIN
    backend.mkdir(parents=True)
    (backend / "__init__.py").write_text("# Previous backend\n")
    (backend / "manifest.json").write_text(json.dumps({"version": "0.2.0"}))
    card = root / "www/liectroux-zk901/liectroux-zk901-map-card-0.2.0.js"
    card.parent.mkdir(parents=True)
    card.write_bytes(b"console.info('v0.2.0');")
    return backend, _StorageResources(updater._versioned_resource_url("0.2.0"))


@pytest.mark.parametrize("before_restart", [True, False])
def test_real_ha_notifications_during_install_startup_and_restore(monkeypatch, tmp_path, before_restart):
    async def run():
        hass = HomeAssistant(str(tmp_path))
        messages = []
        unsubscribe = updater.persistent_notification.async_register_callback(
            hass, lambda _kind, notifications: messages.extend(
                notification["message"] for notification in notifications.values()
            ),
        )
        try:
            backend, resources = _local_previous_package(tmp_path)
            hass.data[LOVELACE_DATA] = SimpleNamespace(resource_mode="storage", resources=resources)
            files, metadata, archive, checksums = _package()
            release, assets = _release(VERSION, metadata, checksums, archive, files[updater.BUNDLE_PATH])
            session = _FakeSession([release], {
                updater._expected_asset_url(release["tag_name"], name): content
                for name, content in assets.items()
            })
            monkeypatch.setattr(updater, "async_get_clientsession", lambda _hass: session)
            manager = updater.ZK901UpdateManager(hass, "0.2.0")
            await manager.async_install()
            await hass.async_block_till_done()
            assert manager.restart_pending
            assert any("quedó preparada" in message for message in messages)
            assert resources.items[0]["url"] == updater._versioned_resource_url("0.2.0")

            if not before_restart:
                manager = updater.ZK901UpdateManager(hass, VERSION)
                await manager.async_process_startup_state()
                await hass.async_block_till_done()
                assert resources.items[0]["url"] == updater._versioned_resource_url(VERSION)
                assert manager.pending_install is None
                assert any("está activa" in message for message in messages)

            await manager.async_restore_previous()
            await hass.async_block_till_done()
            assert json.loads((backend / "manifest.json").read_text())["version"] == "0.2.0"
            assert resources.items[0]["url"] == updater._versioned_resource_url("0.2.0")
            assert manager.pending_install is None
            assert any("quedó restaurado" in message for message in messages)

            # A cancelled update must not block a later installation after reboot.
            restored_manager = updater.ZK901UpdateManager(hass, "0.2.0")
            await restored_manager.async_process_startup_state()
            assert not restored_manager.restart_pending
            await restored_manager.async_install()
            assert restored_manager.pending_install["version"] == VERSION
        finally:
            unsubscribe()
            await hass.async_stop(force=True)

    asyncio.run(run())


def test_restore_cancels_pending_install_before_restart(tmp_path):
    backend, resources = _local_previous_package(tmp_path)
    files, *_ = _package()
    record = updater._install_verified_package(
        str(tmp_path), files, files[updater.BUNDLE_PATH], VERSION, "0.2.0",
        {"mode": "storage", **resources.items[0]},
    )
    updater._restore_previous_package(str(tmp_path), record)
    assert json.loads((backend / "manifest.json").read_text())["version"] == "0.2.0"
    assert not (tmp_path / updater.STATE_DIRECTORY / updater.PENDING_FILE).exists()


def test_real_ha_retains_pending_update_when_lovelace_resource_fails(tmp_path):
    async def run():
        hass = HomeAssistant(str(tmp_path))
        messages = []
        unsubscribe = updater.persistent_notification.async_register_callback(
            hass, lambda _kind, notifications: messages.extend(
                notification["message"] for notification in notifications.values()
            ),
        )
        try:
            # The resource disappeared between preparing the update and rebooting.
            resources = _StorageResources(updater._versioned_resource_url("0.2.0"))
            resources.items.clear()
            hass.data[LOVELACE_DATA] = SimpleNamespace(resource_mode="storage", resources=resources)
            manager = updater.ZK901UpdateManager(hass, VERSION)
            pending = {
                "version": VERSION, "resource_mode": "storage", "resource_id": "resource-id",
                "resource_before": updater._versioned_resource_url("0.2.0"),
                "resource_after": updater._versioned_resource_url(VERSION),
            }
            updater._write_json_atomic(manager.state_dir / updater.PENDING_FILE, pending)
            await manager.async_process_startup_state()
            await hass.async_block_till_done()
            assert manager.pending_install is not None
            assert manager.last_install["resource_status"] == "failed"
            assert "eliminado" in manager.last_install["resource_error"]
            assert any("no pudo cambiar el recurso" in message for message in messages)
        finally:
            unsubscribe()
            await hass.async_stop(force=True)

    asyncio.run(run())


def test_manager_reads_installed_version_outside_event_loop(monkeypatch, tmp_path):
    async def run():
        hass = HomeAssistant(str(tmp_path))
        event_loop_thread = threading.get_ident()
        reads = []
        original = update_platform._installed_version

        def read_version(_hass):
            assert threading.get_ident() != event_loop_thread
            reads.append(True)
            return original(_hass)

        monkeypatch.setattr(update_platform, "_installed_version", read_version)
        try:
            first, second = await asyncio.gather(
                update_platform.async_get_update_manager(hass),
                update_platform.async_get_update_manager(hass),
            )
            assert first is second
            assert reads
            expected = json.loads(Path(update_platform.__file__).with_name("manifest.json").read_text())["version"]
            assert first.installed_version == expected
            reads.clear()
            assert await update_platform.async_get_update_manager(hass) is first
            assert not reads
        finally:
            await hass.async_stop(force=True)

    asyncio.run(run())


def test_route_releases_require_capture_module_but_older_releases_remain_valid():
    _, old_metadata, _, _ = _package("0.3.2")
    updater._validate_metadata(old_metadata, "0.3.2")
    _, metadata, _, _ = _package("0.4.0")
    with pytest.raises(updater.UpdaterError, match="trayectoria"):
        updater._validate_metadata(metadata, "0.4.0")
