"""Tests for the JSON store durability and query."""

import json
from datetime import UTC, datetime, timedelta


def test_save_load_roundtrip(tmp_path, store):
    path = tmp_path / "visit-heatmap.json"
    st = store.VisitStore(path)
    t = datetime(2026, 8, 6, 12, 0, 0, tzinfo=UTC)
    st.add_fix("dt.a", 1.0, 2.0, t, 100.0, 2.0)
    st.save()

    st2 = store.VisitStore(path)
    assert len(st2.rows) == 1
    assert st2.rows[0]["device"] == "dt.a"
    assert st2.rows[0]["lat"] == 1.0
    assert st2.rows[0]["last_seen"] == t


def test_query_filters_by_device(store, tmp_path):
    st = store.VisitStore(tmp_path / "v.json")
    t = datetime(2026, 8, 6, 12, 0, 0, tzinfo=UTC)
    st.add_fix("dt.a", 1.0, 1.0, t, 100.0, 2.0)
    st.add_fix("dt.b", 2.0, 2.0, t, 100.0, 2.0)

    only_a = st.query(["dt.a"])
    assert [r["device"] for r in only_a] == ["dt.a"]
    assert st.query()  # no filter returns all


def test_query_filters_by_since(store, tmp_path):
    st = store.VisitStore(tmp_path / "v.json")
    now = datetime(2026, 8, 6, 12, 0, 0, tzinfo=UTC)
    st.add_fix("dt.a", 1.0, 1.0, now, 100.0, 2.0)
    st.add_fix("dt.a", 2.0, 2.0, now - timedelta(days=40), 100.0, 2.0)
    st.add_fix("dt.a", 3.0, 3.0, now - timedelta(days=90), 100.0, 2.0)

    recent = st.query(["dt.a"], since=now - timedelta(days=30))
    assert len(recent) == 1
    assert recent[0]["lat"] == 1.0

    # without since, everything within retention comes back
    assert len(st.query(["dt.a"])) == 3


def test_query_payload_shape_matches_ws_contract(store, tmp_path):
    st = store.VisitStore(tmp_path / "v.json")
    t = datetime(2026, 8, 6, 12, 0, 0, tzinfo=UTC)
    st.add_fix("dt.a", 1.5, 2.5, t, 100.0, 2.0)

    rows = st.query()
    assert len(rows) == 1
    row = rows[0]
    assert set(row) == {"device", "lat", "lon", "first_seen", "last_seen", "moving"}
    assert row["device"] == "dt.a"
    assert row["lat"] == 1.5 and row["lon"] == 2.5
    assert row["moving"] is False
    assert row["last_seen"].endswith("Z")
    assert datetime.fromisoformat(row["last_seen"].rstrip("Z") + "+00:00") == t


def test_payload_is_json_safe(store, tmp_path):
    st = store.VisitStore(tmp_path / "v.json")
    st.add_fix("dt.a", 1.0, 1.0, datetime(2026, 8, 6, 12, 0, 0, tzinfo=UTC), 100.0, 2.0)
    payload = st.payload()
    assert payload["version"] == 1
    assert json.dumps(payload)  # no datetime objects → serializable
    assert isinstance(payload["rows"][0]["last_seen"], str)
    assert payload["rows"][0]["last_seen"].endswith("Z")


def test_save_payload_writes_loadable_file(store, tmp_path):
    st = store.VisitStore(tmp_path / "v.json")
    st.add_fix("dt.a", 1.0, 1.0, datetime(2026, 8, 6, 12, 0, 0, tzinfo=UTC), 100.0, 2.0)
    st.save_payload(st.payload())
    assert st._path.exists()
    reloaded = store.VisitStore(st._path)
    assert len(reloaded.rows) == 1


def test_query_ignores_person_entities(store, tmp_path):
    st = store.VisitStore(tmp_path / "v.json")
    t = datetime(2026, 8, 6, 12, 0, 0, tzinfo=UTC)
    st.add_fix("device_tracker.a", 1.0, 1.0, t, 100.0, 2.0)
    assert st.query(["person.a"]) == []


def test_purge_removes_rows(store, tmp_path):
    st = store.VisitStore(tmp_path / "v.json")
    now = datetime(2026, 8, 6, 12, 0, 0, tzinfo=UTC)
    st.add_fix("dt.a", 1.0, 1.0, now, 100.0, 2.0)
    st.add_fix("dt.b", 2.0, 2.0, now - timedelta(days=200), 100.0, 2.0)
    assert st.purge(90, now) is True
    assert [r["device"] for r in st.rows] == ["dt.a"]
