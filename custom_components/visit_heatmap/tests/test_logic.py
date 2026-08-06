"""Unit tests for the visit heatmap pure domain logic."""

from datetime import UTC, datetime, timedelta

import pytest


def _ts(days_ago: float = 0.0) -> datetime:
    return datetime.now(UTC) - timedelta(days=days_ago)


def _fix(device, lat, lon, timestamp, moving=False):
    return {
        "device": device,
        "lat": lat,
        "lon": lon,
        "first_seen": timestamp,
        "last_seen": timestamp,
        "moving": moving,
    }


def test_classify_first_fix_is_stationary(logic):
    assert logic.classify_moving(None, 2.0) is False


def test_classify_moving_by_threshold(logic):
    assert logic.classify_moving(3.0, 2.0) is True
    assert logic.classify_moving(1.0, 2.0) is False
    assert logic.classify_moving(2.0, 2.0) is True


def test_speed_units_are_meters_per_second(logic):
    # 1 degree of latitude ≈ 111 km; travelled over 1 hour → ~30.8 m/s.
    prev = logic.Fix("dt.x", 52.0, 4.0, _ts(0))
    cur = logic.Fix("dt.x", 53.0, 4.0, _ts(-1 / 24))
    speed = logic.speed_between(prev, cur)
    assert speed is not None
    assert 29.0 < speed < 32.0


def test_new_fix_adds_row(logic):
    rows = []
    rows, action = logic.add_fix(
        rows, logic.Fix("dt.a", 1.0, 1.0, _ts(0)), 100.0, False
    )
    assert action == "added"
    assert len(rows) == 1
    assert rows[0]["device"] == "dt.a"


def test_nearby_fix_refreshes_last_seen_only(logic):
    t1, t2 = _ts(2), _ts(1)
    rows, _ = logic.add_fix(rows := [], logic.Fix("dt.a", 1.0, 1.0, t1), 100.0, False)
    rows, action = logic.add_fix(
        rows, logic.Fix("dt.a", 1.0002, 1.0002, t2), 100.0, False
    )
    assert action == "refreshed"
    assert len(rows) == 1
    assert rows[0]["last_seen"] == t2
    assert rows[0]["first_seen"] == t1


def test_distant_fix_adds_new_row(logic):
    rows, _ = logic.add_fix(
        rows := [], logic.Fix("dt.a", 1.0, 1.0, _ts(2)), 100.0, False
    )
    rows, action = logic.add_fix(
        rows, logic.Fix("dt.a", 2.0, 2.0, _ts(1)), 100.0, False
    )
    assert action == "added"
    assert len(rows) == 2


def test_dedupe_is_per_device(logic):
    t = _ts(1)
    rows, _ = logic.add_fix(rows := [], logic.Fix("dt.a", 1.0, 1.0, t), 100.0, False)
    rows, action = logic.add_fix(rows, logic.Fix("dt.b", 1.0, 1.0, t), 100.0, False)
    assert action == "added"
    assert len(rows) == 2


def test_refresh_updates_moving_flag(logic):
    t1, t2 = _ts(2), _ts(1)
    rows, _ = logic.add_fix(rows := [], logic.Fix("dt.a", 1.0, 1.0, t1), 100.0, False)
    rows, _ = logic.add_fix(rows, logic.Fix("dt.a", 1.0002, 1.0002, t2), 100.0, True)
    assert rows[0]["moving"] is True


def test_decay_opacity_continuous(logic):
    now = _ts(0)
    assert logic.decay_opacity(now, now, 0.1) == pytest.approx(1.0)
    assert logic.decay_opacity(now - timedelta(days=1), now, 0.1) == pytest.approx(0.9)
    assert logic.decay_opacity(now - timedelta(days=30), now, 0.1) == pytest.approx(
        0.9**30
    )


def test_decay_never_below_zero(logic):
    now = _ts(0)
    assert logic.decay_opacity(now - timedelta(days=1), now, 1.0) == 0.0


def test_prune_drops_old_rows(logic):
    now = _ts(0)
    rows = [
        _fix("dt.a", 1.0, 1.0, now),
        _fix("dt.b", 2.0, 2.0, now - timedelta(days=200)),
    ]
    pruned = logic.prune(rows, 90, now)
    assert len(pruned) == 1
    assert pruned[0]["device"] == "dt.a"


def test_retention_boundary_kept(logic):
    now = _ts(0)
    rows = [_fix("dt.a", 1.0, 1.0, now - timedelta(days=90))]
    assert len(logic.prune(rows, 90, now)) == 1


def test_haversine_zero_identity(logic):
    assert logic.haversine_m(52.0, 4.0, 52.0, 4.0) == 0.0


def test_haversine_known_distance(logic):
    # One degree of latitude is ~111 km.
    d = logic.haversine_m(52.0, 4.0, 53.0, 4.0)
    assert 110_000 < d < 112_000
