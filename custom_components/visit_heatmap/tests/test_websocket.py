"""Coverage for the websocket commands: points query and debug diagnostics."""

import asyncio
import types
from datetime import UTC, datetime, timedelta

from visit_heatmap import const

ws = __import__("visit_heatmap.websocket", fromlist=["handle_points", "handle_debug"])


class FakeConnection:
    def __init__(self):
        self.results = []

    def send_result(self, msg_id, result):
        self.results.append((msg_id, result))


class FakeStore:
    def __init__(self, rows):
        self.rows = rows

    def query(self, entities=None, since=None):
        rows = self.rows
        if entities:
            wanted = set(entities)
            rows = [r for r in rows if r["device"] in wanted]
        if since is not None:
            rows = [r for r in rows if r["last_seen"] >= since]
        return rows


def _runtime(rows):
    fake_store = FakeStore(rows)

    class Runtime:
        store = fake_store
        dedupe_radius = 100
        speed_threshold = 2.0
        retention_days = 90
        backfill_days = 10

    return Runtime()


def _msg(msg_id, **extra):
    base = {"id": msg_id, "type": const.WS_POINTS}
    base.update(extra)
    return base


def _run(coro):
    return asyncio.run(coro)


def test_handle_points_returns_rows():
    now = datetime.now(UTC)
    runtime = _runtime(
        [
            {"device": "dt.a", "lat": 1.0, "lon": 2.0, "first_seen": now, "last_seen": now},
            {"device": "dt.b", "lat": 3.0, "lon": 4.0, "first_seen": now, "last_seen": now},
        ]
    )
    hass = types.SimpleNamespace(data={const.DOMAIN: runtime})
    conn = FakeConnection()

    _run(ws.handle_points(hass, conn, _msg(1, entities=["dt.a"])))
    assert len(conn.results) == 1
    rows = conn.results[0][1]["rows"]
    assert [r["device"] for r in rows] == ["dt.a"]


def test_handle_points_honors_since():
    now = datetime.now(UTC)
    runtime = _runtime(
        [
            {"device": "dt.a", "lat": 1.0, "lon": 2.0, "first_seen": now, "last_seen": now},
            {
                "device": "dt.a",
                "lat": 3.0,
                "lon": 4.0,
                "first_seen": now,
                "last_seen": now - timedelta(days=40),
            },
        ]
    )
    hass = types.SimpleNamespace(data={const.DOMAIN: runtime})
    conn = FakeConnection()

    since = (now - timedelta(days=30)).isoformat()
    _run(ws.handle_points(hass, conn, _msg(2, entities=["dt.a"], since=since)))
    rows = conn.results[0][1]["rows"]
    assert len(rows) == 1
    assert rows[0]["lat"] == 1.0


def test_handle_points_without_runtime_returns_empty():
    hass = types.SimpleNamespace(data={})
    conn = FakeConnection()
    _run(ws.handle_points(hass, conn, _msg(3)))
    assert conn.results[0][1] == {"rows": []}


def test_handle_debug_reports_unregistered():
    hass = types.SimpleNamespace(data={})
    conn = FakeConnection()
    _run(ws.handle_debug(hass, conn, {"id": 4, "type": const.WS_DEBUG, "entities": []}))
    payload = conn.results[0][1]
    assert payload["registered"] is False


def test_handle_debug_reports_store_and_frontend():
    now = datetime.now(UTC)
    runtime = _runtime(
        [
            {"device": "dt.a", "lat": 1.0, "lon": 2.0, "first_seen": now, "last_seen": now},
            {"device": "dt.a", "lat": 3.0, "lon": 4.0, "first_seen": now, "last_seen": now},
            {"device": "dt.b", "lat": 5.0, "lon": 6.0, "first_seen": now, "last_seen": now},
        ]
    )
    hass = types.SimpleNamespace(
        data={const.DOMAIN: runtime, "lovelace": types.SimpleNamespace(resources=None)}
    )
    conn = FakeConnection()
    _run(ws.handle_debug(hass, conn, {"id": 5, "type": const.WS_DEBUG, "entities": ["dt.a"]}))
    payload = conn.results[0][1]
    assert payload["registered"] is True
    assert payload["row_count"] == 3
    assert payload["per_entity"] == {"dt.a": 2}
    assert payload["options"]["retention_days"] == 90
    assert payload["frontend"]["card_url"] == const.CARD_URL
