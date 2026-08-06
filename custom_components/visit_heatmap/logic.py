"""Pure, testable domain logic for the visit store.

No Home Assistant imports here on purpose so this module can be unit-tested
without an HA runtime.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

_EARTH_RADIUS_M = 6371000.0


def utc_now() -> datetime:
    return datetime.now(UTC)


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two coordinates in meters."""
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)

    a = (
        math.sin(d_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return _EARTH_RADIUS_M * c


@dataclass(frozen=True)
class Fix:
    device: str
    lat: float
    lon: float
    timestamp: datetime


def speed_between(prev: Fix, current: Fix) -> float | None:
    """Speed in m/s between two fixes, or None when there is no time delta."""
    delta_s = (current.timestamp - prev.timestamp).total_seconds()
    if delta_s <= 0:
        return None
    distance = haversine_m(prev.lat, prev.lon, current.lat, current.lon)
    return distance / delta_s


def classify_moving(speed: float | None, threshold: float) -> bool:
    """True when a fix is part of travel; first fixes (no speed) are stationary."""
    if speed is None:
        return False
    return speed >= threshold


def add_fix(
    rows: list[dict],
    fix: Fix,
    dedupe_radius: float,
    moving: bool,
) -> tuple[list[dict], str]:
    """Append or refresh a visit row for a fix.

    A fix within `dedupe_radius` of any existing row for the same device
    refreshes that row's `last_seen` (and its `moving` flag) in place;
    `first_seen` is never changed. Otherwise a new row is appended.

    Returns the (possibly new) row list and the action taken: "refreshed",
    "added", or "duplicate" (identical timestamps do not mutate anything).
    """
    for row in rows:
        if row["device"] != fix.device:
            continue
        if haversine_m(row["lat"], row["lon"], fix.lat, fix.lon) > dedupe_radius:
            continue
        if row["last_seen"] == fix.timestamp:
            return rows, "duplicate"
        row["last_seen"] = fix.timestamp
        row["moving"] = moving
        return rows, "refreshed"

    rows.append(
        {
            "device": fix.device,
            "lat": fix.lat,
            "lon": fix.lon,
            "first_seen": fix.timestamp,
            "last_seen": fix.timestamp,
            "moving": moving,
        }
    )
    return rows, "added"


def decay_opacity(last_seen: datetime, now: datetime, decay_rate: float) -> float:
    """Client-side fade, mirrored server-side for tests.

    opacity = (1 - decay_rate) ** age_days, floored at 0.
    """
    age_days = max(0.0, (now - last_seen).total_seconds() / 86400.0)
    return max(0.0, (1.0 - decay_rate) ** age_days)


def prune(rows: list[dict], retention_days: int, now: datetime) -> list[dict]:
    """Drop rows whose `last_seen` is older than `retention_days`."""
    cutoff = now - timedelta(days=retention_days)
    return [row for row in rows if row["last_seen"] >= cutoff]
