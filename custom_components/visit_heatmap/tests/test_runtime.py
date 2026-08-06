"""Coverage for VisitHeatmapRuntime: event ingestion, save, flush, stop.

Runs against a fake `hass` with stubbed homeassistant modules (see conftest).
"""

import asyncio
import json
import sys
import types
from datetime import UTC, datetime, timedelta

from visit_heatmap import const

init_mod = sys.modules["visit_heatmap.__init__"]
VisitHeatmapRuntime = init_mod.VisitHeatmapRuntime
EVENT_STATE_CHANGED = init_mod.EVENT_STATE_CHANGED
STORE_FILE = const.STORE_FILE


def _event(state):
    return types.SimpleNamespace(data={"new_state": state})


def _state(entity, lat, lon, ts):
    return types.SimpleNamespace(
        entity_id=entity,
        attributes={"latitude": lat, "longitude": lon},
        last_updated=ts,
    )


class FakeHass:
    def __init__(self, config_dir):
        self.config = types.SimpleNamespace(
            config_dir=str(config_dir), components=["history"]
        )
        self.states = types.SimpleNamespace(async_all=lambda domain=None: [])
        self.bus = types.SimpleNamespace()
        self.executor_calls = 0
        self._listeners = {}
        self.bus.async_listen = self._listen

    def _listen(self, event, handler):
        self._listeners[event] = handler
        return lambda: self._listeners.pop(event, None)

    def fire(self, state):
        self._listeners[EVENT_STATE_CHANGED](_event(state))

    def async_create_background_task(self, coro, name):
        return asyncio.create_task(coro)

    async def async_add_executor_job(self, func, *args):
        return func(*args)


def make_runtime(tmp_path):
    hass = FakeHass(config_dir=str(tmp_path))
    return hass, VisitHeatmapRuntime(hass, {})


def test_start_records_and_flushes(tmp_path):
    async def run():
        hass, runtime = make_runtime(tmp_path)
        await runtime.start()
        try:
            now = datetime.now(UTC)

            hass.fire(_state("device_tracker.phone", 52.3676, 4.9041, now))
            hass.fire(
                _state(
                    "device_tracker.phone", 52.3677, 4.9042, now + timedelta(minutes=1)
                )
            )
            hass.fire(_state("sensor.x", 52.0, 4.0, now))
            hass.fire(_state("device_tracker.phone", 52.0, 4.0, now))
            hass.fire(_state("device_tracker.no_gps", None, None, now))

            await runtime._flush()
            rows = runtime.store.query()
            assert len(rows) == 2
            phone = [r for r in rows if r["device"] == "device_tracker.phone"]
            assert len(phone) == 2

            saved = json.loads((tmp_path / STORE_FILE).read_text())
            assert saved["version"] == 1
            assert len(saved["rows"]) == len(rows)
        finally:
            await runtime.stop()

    asyncio.run(run())


def test_dedupe_refreshes_same_place(tmp_path):
    async def run():
        hass, runtime = make_runtime(tmp_path)
        await runtime.start()
        try:
            now = datetime.now(UTC)
            hass.fire(_state("device_tracker.a", 52.3676, 4.9041, now))
            hass.fire(
                _state("device_tracker.a", 52.3677, 4.9042, now + timedelta(minutes=5))
            )
            rows = runtime.store.query()
            assert len(rows) == 1
            assert rows[0]["last_seen"] >= rows[0]["first_seen"]
        finally:
            await runtime.stop()

    asyncio.run(run())


def test_purge_respects_retention(tmp_path):
    async def run():
        hass, runtime = make_runtime(tmp_path)
        await runtime.start()
        try:
            now = datetime.now(UTC)
            hass.fire(_state("device_tracker.a", 52.0, 4.0, now))
            hass.fire(
                _state(
                    "device_tracker.b",
                    53.0,
                    4.1,
                    now - timedelta(days=runtime.retention_days + 1),
                )
            )
            await runtime._flush()
            rows = runtime.store.query()
            devices = {r["device"] for r in rows}
            assert "device_tracker.b" not in devices
            assert "device_tracker.a" in devices
        finally:
            await runtime.stop()

    asyncio.run(run())
