"""Packaging integrity: manifests, translations, and option-key coverage."""

import json
from pathlib import Path

import visit_heatmap.const as const

_PACKAGE = Path(__file__).resolve().parents[1]


def _load(name: str) -> dict:
    with open(_PACKAGE / name) as handle:
        return json.load(handle)


def test_strings_and_translations_match():
    assert _load("strings.json") == _load("translations/en.json")


def test_strings_cover_every_option_key():
    data = _load("strings.json")["options"]["step"]["init"]["data"]
    for key in (
        const.CONF_DEDUPE_RADIUS,
        const.CONF_MOVE_SPEED_THRESHOLD,
        const.CONF_RETENTION_DAYS,
        const.CONF_BACKFILL_DAYS,
    ):
        assert key in data


def test_manifest_required_fields():
    manifest = _load("manifest.json")
    assert "requirements" in manifest
    for field in (
        "domain",
        "name",
        "version",
        "config_flow",
        "dependencies",
        "iot_class",
        "integration_type",
        "codeowners",
        "documentation",
        "issue_tracker",
    ):
        assert manifest.get(field), f"missing manifest field: {field}"
    assert manifest["domain"] == const.DOMAIN
    assert manifest["version"].count(".") == 2
