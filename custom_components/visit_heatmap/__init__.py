"""Visit Heatmap — companion integration that records GPS device_tracker visits."""

from __future__ import annotations

import asyncio
from pathlib import Path

from homeassistant.components import frontend
from homeassistant.const import EVENT_STATE_CHANGED
from homeassistant.core import HomeAssistant
from homeassistant.helpers.typing import ConfigType

from .backfill import async_backfill
from .const import (
    CARD_URL,
    CONF_BACKFILL_DAYS,
    CONF_DEDUPE_RADIUS,
    CONF_MOVE_SPEED_THRESHOLD,
    CONF_RETENTION_DAYS,
    DEFAULT_BACKFILL_DAYS,
    DEFAULT_DEDUPE_RADIUS,
    DEFAULT_MOVE_SPEED_THRESHOLD,
    DEFAULT_RETENTION_DAYS,
    DOMAIN,
    STORE_FILE,
)
from .logic import utc_now
from .store import VisitStore
from .websocket import async_register_websocket

_STATIC_REGISTERED: set[str] = set()


class VisitHeatmapRuntime:
    """Owns the store, the event listener, and the save debounce."""

    def __init__(self, hass: HomeAssistant, options: ConfigType) -> None:
        self.hass = hass
        self.options = options
        self.store = VisitStore(Path(hass.config.config_dir) / STORE_FILE)
        self._unsub_listener = None
        self._save_task: asyncio.Task | None = None
        self._backfill_task: asyncio.Task | None = None
        self._flush_lock = asyncio.Lock()

    @property
    def dedupe_radius(self) -> float:
        return float(self.options.get(CONF_DEDUPE_RADIUS, DEFAULT_DEDUPE_RADIUS))

    @property
    def speed_threshold(self) -> float:
        return float(
            self.options.get(CONF_MOVE_SPEED_THRESHOLD, DEFAULT_MOVE_SPEED_THRESHOLD)
        )

    @property
    def retention_days(self) -> int:
        return int(self.options.get(CONF_RETENTION_DAYS, DEFAULT_RETENTION_DAYS))

    @property
    def backfill_days(self) -> int:
        return int(self.options.get(CONF_BACKFILL_DAYS, DEFAULT_BACKFILL_DAYS))

    async def start(self) -> None:
        self.store.rebuild_last_fixes()
        if not self.store.rows:
            self._backfill_task = self.hass.async_create_background_task(
                self._backfill(), "visit_heatmap backfill"
            )
        self._unsub_listener = self.hass.bus.async_listen(
            EVENT_STATE_CHANGED, self._on_state_changed
        )
        await self._flush()

    async def stop(self) -> None:
        if self._unsub_listener:
            self._unsub_listener()
        for task in (self._save_task, self._backfill_task):
            if task and not task.done():
                task.cancel()
        await self._flush()

    async def _flush(self) -> None:
        async with self._flush_lock:
            self.store.purge(self.retention_days, utc_now())
            payload = self.store.payload()
            await self.hass.async_add_executor_job(self.store.save_payload, payload)

    def _on_state_changed(self, event) -> None:
        state = event.data.get("new_state")
        if state is None or not state.entity_id.startswith("device_tracker."):
            return
        lat = state.attributes.get("latitude")
        lon = state.attributes.get("longitude")
        if lat is None or lon is None:
            return
        action = self.store.add_fix(
            state.entity_id,
            lat,
            lon,
            state.last_updated,
            self.dedupe_radius,
            self.speed_threshold,
        )
        if action in ("added", "refreshed"):
            self._schedule_save()

    def _schedule_save(self) -> None:
        if self._save_task and not self._save_task.done():
            self._save_task.cancel()
        self._save_task = self.hass.async_create_background_task(
            self._debounced_save(), "visit_heatmap save"
        )

    async def _debounced_save(self) -> None:
        await asyncio.sleep(2)
        await self._flush()

    async def _backfill(self) -> None:
        count = await async_backfill(
            self.hass,
            self.store,
            self.backfill_days,
            self.dedupe_radius,
            self.speed_threshold,
        )
        if count:
            await self._flush()


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register the domain once; runs regardless of config entries."""
    await async_register_websocket(hass)
    return True


async def _register_frontend(hass: HomeAssistant) -> None:
    if CARD_URL in _STATIC_REGISTERED:
        return
    _STATIC_REGISTERED.add(CARD_URL)
    await hass.async_add_executor_job(
        hass.http.register_static_path,
        "/visit_heatmap",
        str(Path(__file__).parent / "www"),
    )
    if hasattr(frontend, "async_add_extra_js_url"):
        await frontend.async_add_extra_js_url(hass, CARD_URL)
    else:
        frontend.add_extra_js_url(hass, CARD_URL)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigType) -> bool:
    runtime = VisitHeatmapRuntime(hass, entry.options)
    hass.data[DOMAIN] = runtime
    await runtime.start()
    await _register_frontend(hass)
    entry.add_update_listener(async_reload_entry)
    return True


async def async_reload_entry(hass: HomeAssistant, entry: ConfigType) -> None:
    await async_unload_entry(hass, entry)
    await async_setup_entry(hass, entry)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigType) -> bool:
    runtime: VisitHeatmapRuntime = hass.data.pop(DOMAIN)
    await runtime.stop()
    return True
