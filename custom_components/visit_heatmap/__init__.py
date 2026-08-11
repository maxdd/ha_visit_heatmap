"""Visit Heatmap — companion integration that records GPS device_tracker visits."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from homeassistant.components import frontend
from homeassistant.components.http import StaticPathConfig
from homeassistant.const import EVENT_STATE_CHANGED
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.typing import ConfigType
from homeassistant.loader import async_get_integration

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

_LOGGER = logging.getLogger(__name__)

_STATIC_REGISTERED: set[str] = set()


class VisitHeatmapRuntime:
    """Owns the store, the event listener, and the save debounce."""

    def __init__(self, hass: HomeAssistant, options: ConfigType) -> None:
        self.hass = hass
        self.options = options
        self.store = VisitStore(Path(hass.config.config_dir) / STORE_FILE, load=False)
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
        await self.hass.async_add_executor_job(self.store.load)
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
        tasks = [
            task
            for task in (self._save_task, self._backfill_task)
            if task and not task.done()
        ]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await self._flush()

    async def _flush(self) -> None:
        async with self._flush_lock:
            self.store.purge(self.retention_days, utc_now())
            payload = self.store.payload()
            await self.hass.async_add_executor_job(self.store.save_payload, payload)

    @callback
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
    """Serve the card bundle and get it loaded by the dashboards.

    The card is registered as a Lovelace *resource* (the mechanism HACS
    uses), which is fetched over the websocket on every dashboard load —
    cache or no cache. The frontend's extra-js list lives in the app HTML,
    which the service worker caches, so after an HA restart a page can keep
    serving a stale snapshot that never loads the card ("Custom element
    doesn't exist"). The resource path is therefore preferred; extra-js
    remains only as the fallback for YAML-managed resources.
    """
    if CARD_URL in _STATIC_REGISTERED:
        return
    _STATIC_REGISTERED.add(CARD_URL)
    try:
        await hass.http.async_register_static_paths(
            [StaticPathConfig("/visit_heatmap", str(Path(__file__).parent / "www"))]
        )
    except RuntimeError:
        _LOGGER.debug("visit_heatmap static path already served")

    integration = await async_get_integration(hass, DOMAIN)
    versioned_url = f"{CARD_URL}?v={integration.version}"

    if await _async_register_lovelace_resource(hass, versioned_url):
        _LOGGER.debug("Visit Heatmap card registered as a Lovelace resource")
        return

    try:
        if hasattr(frontend, "async_add_extra_js_url"):
            await frontend.async_add_extra_js_url(hass, versioned_url)
        elif hasattr(frontend, "add_extra_js_url"):
            frontend.add_extra_js_url(hass, versioned_url)
        else:
            raise RuntimeError("no frontend extra-js API available")
    except Exception:
        _LOGGER.warning(
            "Could not register the Visit Heatmap card with the dashboards — "
            "Lovelace will report 'Custom element doesn't exist' until it is",
            exc_info=True,
        )


async def _async_register_lovelace_resource(hass: HomeAssistant, url: str) -> bool:
    """Point a Lovelace resource entry at the current card URL.

    One entry, created if missing and updated in place on version changes —
    including an entry the user once added by hand for the same path.
    Returns False when Lovelace storage is unavailable, so the caller can
    fall back to the frontend's extra-js list.
    """
    lovelace = hass.data.get("lovelace")
    resources = getattr(lovelace, "resources", None)
    if resources is None or not hasattr(resources, "async_create_item"):
        return False
    try:
        if not getattr(resources, "loaded", False):
            await resources.async_load()
            resources.loaded = True
        path = CARD_URL.split("?")[0]
        for item in resources.async_items():
            if str(item.get("url", "")).split("?")[0] == path:
                if item.get("url") != url:
                    await resources.async_update_item(item["id"], {"url": url})
                return True
        await resources.async_create_item({"res_type": "module", "url": url})
    except Exception:
        _LOGGER.warning(
            "Could not manage the Lovelace resource for %s", CARD_URL, exc_info=True
        )
        return False
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigType) -> bool:
    runtime = VisitHeatmapRuntime(hass, entry.options)
    hass.data[DOMAIN] = runtime
    try:
        await runtime.start()
        await _register_frontend(hass)
    except Exception:
        await runtime.stop()
        hass.data.pop(DOMAIN, None)
        raise
    entry.add_update_listener(async_reload_entry)
    return True


async def async_reload_entry(hass: HomeAssistant, entry: ConfigType) -> None:
    await async_unload_entry(hass, entry)
    await async_setup_entry(hass, entry)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigType) -> bool:
    runtime: VisitHeatmapRuntime = hass.data.pop(DOMAIN)
    await runtime.stop()
    return True
