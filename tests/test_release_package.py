"""The release contains production files only and pairs the built card/backend."""

import importlib.util
import json
from pathlib import Path
import zipfile

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "zk901_release_package", Path(__file__).resolve().parents[1] / "scripts/package-release.py"
)
packager = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(packager)


def test_package_excludes_local_data_and_contains_both_components(tmp_path):
    root = tmp_path / "source"
    integration = root / "custom_components/liectroux_zk901"
    integration.mkdir(parents=True)
    (root / "package.json").write_text(json.dumps({"version": "0.2.0", "module": "dist/card.js"}))
    (root / "dist").mkdir()
    (root / "dist/card.js").write_text('console.info("v0.2.0");')
    (integration / "manifest.json").write_text(json.dumps({"domain": "liectroux_zk901", "version": "0.2.1"}))
    (integration / "const.py").write_text("CARD_API_VERSION = 3\n")
    (root / "requirements-dev.txt").write_text("homeassistant==2026.9.2\n")
    for name in ("__init__.py", "client.py"):
        (integration / name).write_text("# production source\n")
    for directory, name in (("", ".env"), ("__pycache__", "client.pyc"), ("www", "legacy.js")):
        path = integration / directory / name
        path.parent.mkdir(exist_ok=True)
        path.write_text("local-only-data")
    output = tmp_path / "release"
    metadata = packager.build_package(root, output)
    with zipfile.ZipFile(output / packager.ARCHIVE) as archive:
        assert len(archive.namelist()) == 5
        assert "www/liectroux-zk901/liectroux-zk901-map-card.js" in archive.namelist()
        assert all(b"local-only-data" not in archive.read(name) for name in archive.namelist())
        assert all(not name.startswith("/") and ".." not in Path(name).parts for name in archive.namelist())
    assert metadata["card_version"] == "0.2.0"
    assert metadata["integration_version"] == "0.2.1"
    assert metadata["compatibility"] == {
        "frontend_version": "0.2.0",
        "backend_version": "0.2.1",
        "card_api_version": 3,
        "home_assistant_tested": "2026.9.2",
    }
    assert len((output / "SHA256SUMS").read_text().splitlines()) == 3


def test_package_rejects_unbuilt_card(tmp_path):
    (tmp_path / "package.json").write_text(json.dumps({"version": "0.2.0", "module": "card.js"}))
    (tmp_path / "card.js").write_text('console.info("@VACUUM_MAP_CARD_VERSION_PLACEHOLDER@");')
    with pytest.raises(ValueError, match="npm run build"):
        packager.build_package(tmp_path, tmp_path / "release")
    assert not (tmp_path / "release").exists()
