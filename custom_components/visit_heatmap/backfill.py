"""Backfill visit rows from the Home Assistant recorder on first install."""

from __future__ import annotations

from datetime import timedelta

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .store import VisitStore


async def async_backfill(
    hass: HomeAssistant,
    store: VisitStore,
    backfill_days: int,
    dedupe_radius: float,
    speed_threshold: float,
) -> int:
    """Import up to `backfill_days` of GPS device_tracker history.

    Returns the number of new/refreshed rows written (duplicates not counted).
    Feeds through the exact same dedupe/refresh pipeline as live fixes so
    backfilled rows are indistinguishable from live-recorded ones.
    """
    if not backfill_days or "history" not in (hass.config.components or []):
        return 0

    from homeassistant.components import history

    now = dt_util.utcnow()
    start = now - timedelta(days=backfill_days)
    states_map = await history.state_changes_during_period(
        hass, start, now, include_start_time_state=True
    )

    count = 0
    for entity_id, state_list in states_map.items():
        if not entity_id.startswith("device_tracker."):
            continue
        for state in state_list:
            lat = state.attributes.get("latitude")
            lon = state.attributes.get("longitude")
            if lat is None or lon is None:
                continue
            action = store.add_fix(
                entity_id, lat, lon, state.last_updated, dedupe_radius, speed_threshold
            )
            if action in ("added", "refreshed"):
                count += 1
    return count
