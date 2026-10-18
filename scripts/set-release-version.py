"""Stamp the frontend and integration with the stable version from a release tag."""

from __future__ import annotations

import json
from pathlib import Path
import re
import sys


VERSION_RE = re.compile(r"^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")


def stamp_release(root: Path, tag: str) -> str:
    match = VERSION_RE.fullmatch(tag)
    if match is None:
        raise ValueError("Release tags must be stable versions such as v0.3.0")
    version = ".".join(match.groups())

    package_path = root / "package.json"
    package = json.loads(package_path.read_text(encoding="utf-8"))
    package["version"] = version
    package_path.write_text(json.dumps(package, ensure_ascii=False, indent=4) + "\n", encoding="utf-8")

    lock_path = root / "package-lock.json"
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    lock["version"] = version
    if "" in lock.get("packages", {}):
        lock["packages"][""]["version"] = version
    lock_path.write_text(json.dumps(lock, ensure_ascii=False, indent=4) + "\n", encoding="utf-8")

    manifest_path = root / "custom_components" / "liectroux_zk901" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["version"] = version
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return version


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python3 scripts/set-release-version.py <release-tag>")
    try:
        print(f"Stamped release {stamp_release(Path(__file__).resolve().parents[1], sys.argv[1])}")
    except (OSError, json.JSONDecodeError, ValueError) as err:
        raise SystemExit(str(err)) from err
