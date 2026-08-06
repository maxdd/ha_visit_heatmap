#!/usr/bin/env python3
"""Headless demo of the visit-heatmap pipeline — no Home Assistant required.

Feeds a synthetic two-week GPS history through the exact same `logic.py` /
`store.py` code the integration runs, then prints the resulting store rows and
the decay opacity the card would paint for each one.

Run:  python3 scripts/demo.py
"""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import types
from datetime import UTC, datetime, timedelta
from pathlib import Path

_BASE = Path(__file__).resolve().parents[1] / "custom_components" / "visit_heatmap"

_pkg = types.ModuleType("visit_heatmap")
_pkg.__path__ = [str(_BASE)]
sys.modules["visit_heatmap"] = _pkg


def _load(name: str):
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(
        name, _BASE / f"{name.rsplit('.', 1)[-1]}.py"
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


logic = _load("visit_heatmap.logic")
store_mod = _load("visit_heatmap.store")
const = _load("visit_heatmap.const")

# Synthetic geography (Amsterdam-ish): home, work, and a park.
HOME = (52.3676, 4.9041)
WORK = (52.3077, 4.8392)
PARK = (52.3566, 4.9004)
DRIVE_SPEED_MPS = 30.0  # ~108 km/h


def _drive(start, end, t0, spacing_s=60):
    """Yield moving fixes along a straight line at a constant speed."""
    d = logic.haversine_m(start[0], start[1], end[0], end[1])
    n = max(1, int(d / (DRIVE_SPEED_MPS * spacing_s)))
    fixes = []
    for i in range(n + 1):
        frac = i / n
        lat = start[0] + (end[0] - start[0]) * frac
        lon = start[1] + (end[1] - start[1]) * frac
        fixes.append(
            logic.Fix(
                "device_tracker.phone", lat, lon, t0 + timedelta(seconds=i * spacing_s)
            )
        )
    return fixes


def _build_history(now: datetime) -> list:
    """A realistic two weeks: daily commute, weekend park trips."""
    fixes = []
    for day in range(13, -1, -1):
        day_start = now - timedelta(days=day)
        weekday = day_start.weekday() < 5
        if weekday:
            # morning at home, commute to work, day at work, commute back.
            fixes.append(
                logic.Fix(
                    "device_tracker.phone", *HOME, day_start.replace(hour=7, minute=30)
                )
            )
            fixes += _drive(HOME, WORK, day_start.replace(hour=8, minute=0))
            fixes.append(
                logic.Fix(
                    "device_tracker.phone", *WORK, day_start.replace(hour=8, minute=30)
                )
            )
            fixes += [
                logic.Fix(
                    "device_tracker.phone",
                    *WORK,
                    day_start.replace(hour=9) + timedelta(minutes=t),
                )
                for t in (0, 240, 480)
            ]
            fixes += _drive(WORK, HOME, day_start.replace(hour=17, minute=0))
            fixes.append(
                logic.Fix(
                    "device_tracker.phone", *HOME, day_start.replace(hour=17, minute=45)
                )
            )
        else:
            # weekend: park outing
            fixes.append(
                logic.Fix(
                    "device_tracker.phone", *HOME, day_start.replace(hour=10, minute=0)
                )
            )
            fixes += _drive(HOME, PARK, day_start.replace(hour=10, minute=30))
            fixes.append(
                logic.Fix(
                    "device_tracker.phone", *PARK, day_start.replace(hour=11, minute=0)
                )
            )
            fixes += [
                logic.Fix(
                    "device_tracker.phone", *PARK, day_start.replace(hour=11, minute=30)
                )
            ]
            fixes += _drive(PARK, HOME, day_start.replace(hour=12, minute=0))
    return fixes


def main() -> None:
    now = datetime.now(UTC)
    st = store_mod.VisitStore(Path(tempfile.mkdtemp()) / "visit-heatmap.json")

    print(f"Replaying {now:%Y-%m-%d} minus 14 days through add_fix()\n")
    counts: dict[str, int] = {}
    for fix in _build_history(now):
        action = st.add_fix(fix.device, fix.lat, fix.lon, fix.timestamp, 100.0, 2.0)
        counts[action] = counts.get(action, 0) + 1
    print("action tally: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))

    st.save()
    print(f"\nstore wrote {len(st.rows)} rows to {st._path.name}\n")

    rows = sorted(st.rows, key=lambda r: (r["device"], r["last_seen"]), reverse=True)
    print(
        f"{'lat':>9} {'lon':>9}  {'first_seen':<21} {'last_seen':<21}  m  opacity@now"
    )
    for r in rows:
        op = logic.decay_opacity(r["last_seen"], now, 0.1)
        print(
            f"{r['lat']:9.4f} {r['lon']:9.4f}  "
            f"{r['first_seen'].strftime('%Y-%m-%d %H:%M:%S'):<21} "
            f"{r['last_seen'].strftime('%Y-%m-%d %H:%M:%S'):<21}  "
            f"{'x' if r['moving'] else '.':1}  {op:5.3f}"
        )

    print("\nopacity the card would paint (decay_rate=0.1, horizon=30):")
    for d in (0, 1, 7, 30):
        print(f"  age {d:>3} days -> {(1 - 0.1) ** d:.3f}")


if __name__ == "__main__":
    main()
