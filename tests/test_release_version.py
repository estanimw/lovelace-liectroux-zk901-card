"""The published tag stamps both shipped components with one stable version."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "zk901_set_release_version",
    Path(__file__).resolve().parents[1] / "scripts/set-release-version.py",
)
release_version = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(release_version)


def _checkout(root: Path) -> None:
    (root / "custom_components/liectroux_zk901").mkdir(parents=True)
    (root / "package.json").write_text(json.dumps({"version": "0.2.0"}))
    (root / "package-lock.json").write_text(json.dumps({
        "version": "0.2.0",
        "packages": {"": {"version": "0.2.0"}},
    }))
    (root / "custom_components/liectroux_zk901/manifest.json").write_text(
        json.dumps({"domain": "liectroux_zk901", "version": "0.2.0"})
    )


def test_stable_tag_stamps_frontend_lock_and_backend(tmp_path):
    _checkout(tmp_path)

    assert release_version.stamp_release(tmp_path, "v0.3.1") == "0.3.1"

    assert json.loads((tmp_path / "package.json").read_text())["version"] == "0.3.1"
    lock = json.loads((tmp_path / "package-lock.json").read_text())
    assert lock["version"] == lock["packages"][""]["version"] == "0.3.1"
    assert json.loads(
        (tmp_path / "custom_components/liectroux_zk901/manifest.json").read_text()
    )["version"] == "0.3.1"


@pytest.mark.parametrize("tag", ["main", "v0.3.1-beta.1", "v01.3.1"])
def test_unstable_or_non_semver_tag_is_rejected_before_writing(tmp_path, tag):
    _checkout(tmp_path)

    with pytest.raises(ValueError, match="stable versions"):
        release_version.stamp_release(tmp_path, tag)

    assert json.loads((tmp_path / "package.json").read_text())["version"] == "0.2.0"
