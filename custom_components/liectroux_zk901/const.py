"""Constantes compartidas por la integración Liectroux ZK901."""

from __future__ import annotations

from datetime import timedelta

from .client import FAN_SPEEDS

DOMAIN = "liectroux_zk901"
MANUFACTURER = "Liectroux"
MODEL = "ZK901"

CONF_HOST = "host"
CONF_DEVICE_ID = "device_id"
CONF_LOCAL_KEY = "local_key"
CONF_UID = "uid"
CONF_SN = "sn"

STATUS_INTERVAL = timedelta(seconds=30)
AREA_INTERVAL_SECONDS = 300

SERVICE_CLEAN_AREA = "clean_area"
SERVICE_CLEAN_AREAS = "clean_areas"
ATTR_AREA_ID = "area_id"
ATTR_AREA_IDS = "area_ids"
ATTR_TAG = "tag"
CARD_API_VERSION = 1

__all__ = [
    "AREA_INTERVAL_SECONDS",
    "ATTR_AREA_ID",
    "ATTR_AREA_IDS",
    "ATTR_TAG",
    "CARD_API_VERSION",
    "CONF_DEVICE_ID",
    "CONF_HOST",
    "CONF_LOCAL_KEY",
    "CONF_SN",
    "CONF_UID",
    "DOMAIN",
    "FAN_SPEEDS",
    "MANUFACTURER",
    "MODEL",
    "SERVICE_CLEAN_AREA",
    "SERVICE_CLEAN_AREAS",
    "STATUS_INTERVAL",
]
