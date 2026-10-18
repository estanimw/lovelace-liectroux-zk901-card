"""Build a config-relative HA archive from this checkout, without device data."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import zipfile

DOMAIN = "liectroux_zk901"
BUNDLE = "liectroux-zk901-map-card.js"
ARCHIVE = "liectroux-zk901-ha.zip"


def _integration_files(directory: Path) -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    for path in sorted(directory.rglob("*")):
        relative = path.relative_to(directory)
        allowed = (
            len(relative.parts) == 1
            and (path.suffix == ".py" or relative.name in {"manifest.json", "services.yaml"})
        ) or (
            len(relative.parts) == 2
            and relative.parts[0] == "translations"
            and path.suffix == ".json"
        )
        if not allowed:
            continue
        if path.is_symlink():
            raise ValueError(f"Symlink in integration package: {relative}")
        if path.is_file():
            files[f"custom_components/{DOMAIN}/{relative.as_posix()}"] = path.read_bytes()
    for required in ("__init__.py", "client.py", "manifest.json"):
        if f"custom_components/{DOMAIN}/{required}" not in files:
            raise ValueError(f"Missing integration file: {required}")
    return files


def _compatibility(root: Path) -> dict[str, str | int]:
    """Read the compatibility contract from the shipped sources and test pin."""
    constants = (root / "custom_components" / DOMAIN / "const.py").read_text()
    api_match = re.search(r"^CARD_API_VERSION\s*=\s*(\d+)\s*$", constants, re.MULTILINE)
    if api_match is None:
        raise ValueError("Could not determine the card API version from const.py")

    requirements = (root / "requirements-dev.txt").read_text()
    ha_match = re.search(r"^homeassistant==([^\s;]+)\s*$", requirements, re.MULTILINE)
    if ha_match is None:
        raise ValueError("Pin the tested Home Assistant version in requirements-dev.txt")
    return {
        "frontend_version": json.loads((root / "package.json").read_text())["version"],
        "backend_version": json.loads(
            (root / "custom_components" / DOMAIN / "manifest.json").read_text()
        )["version"],
        "card_api_version": int(api_match.group(1)),
        "home_assistant_tested": ha_match.group(1),
    }


def build_package(root: Path, output: Path) -> dict:
    root = root.resolve()
    package = json.loads((root / "package.json").read_text())
    bundle_path = (root / package["module"]).resolve()
    if not bundle_path.is_relative_to(root):
        raise ValueError("Bundle must be inside the checkout")
    bundle = bundle_path.read_bytes()
    if b"@VACUUM_MAP_CARD_VERSION_PLACEHOLDER@" in bundle:
        raise ValueError("Run npm run build before packaging")
    if f"v{package['version']}".encode() not in bundle:
        raise ValueError("Bundle version does not match package.json")

    files = _integration_files(root / "custom_components" / DOMAIN)
    integration = json.loads(files[f"custom_components/{DOMAIN}/manifest.json"])
    if integration.get("domain") != DOMAIN:
        raise ValueError("Unexpected integration domain")
    files[f"www/liectroux-zk901/{BUNDLE}"] = bundle
    try:
        commit = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=root, stderr=subprocess.DEVNULL, text=True
        ).strip()
        dirty = bool(subprocess.check_output(
            ["git", "status", "--porcelain"], cwd=root, text=True
        ).strip())
    except (OSError, subprocess.CalledProcessError):
        commit, dirty = None, None

    metadata = {
        "format_version": 2,
        "card_version": package["version"],
        "integration_version": integration["version"],
        "integration_domain": DOMAIN,
        "compatibility": _compatibility(root),
        "source_commit": commit,
        "source_modified": dirty,
        "archive": ARCHIVE,
        "files": {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())},
    }
    output.mkdir(parents=True, exist_ok=True)
    archive_path = output / ARCHIVE
    temporary = output / (ARCHIVE + ".tmp")
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, data in sorted(files.items()):
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, data)
        temporary.replace(archive_path)
    finally:
        temporary.unlink(missing_ok=True)
    (output / "release-manifest.json").write_text(json.dumps(metadata, indent=2) + "\n")
    if bundle_path != (output / BUNDLE).resolve():
        (output / BUNDLE).write_bytes(bundle)
    names = (BUNDLE, ARCHIVE, "release-manifest.json")
    (output / "SHA256SUMS").write_text("".join(
        f"{hashlib.sha256((output / name).read_bytes()).hexdigest()}  {name}\n"
        for name in names
    ))
    return metadata


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="Output directory (default: dist/)")
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    result = build_package(project, args.output or project / "dist")
    print(f"Built {ARCHIVE}: {len(result['files'])} files; "
          f"card {result['card_version']}, integration {result['integration_version']}")
