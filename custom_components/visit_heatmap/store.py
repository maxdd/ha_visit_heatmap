"""Durable JSON-backed store for visit rows."""

from __future__ import annotations

import json
import os
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from .const import STORE_VERSION
from .logic import Fix, add_fix, classify_moving, prune, speed_between

_TS_FMT = "%Y-%m-%dT%H:%M:%S.%fZ"


def _to_iso(value: datetime) -> str:
    return value.astimezone(UTC).strftime(_TS_FMT)


def _from_iso(value: str) -> datetime:
    return datetime.strptime(value, _TS_FMT).replace(tzinfo=UTC)


class VisitStore:
    """In-memory visit rows with an atomic JSON persistence."""

    def __init__(self, path: str | Path, *, load: bool = True) -> None:
        self._path = Path(path)
        self.rows: list[dict] = []
        self._last_fix: dict[str, Fix] = {}
        if load:
            self._load()

    def load(self) -> None:
        """Load rows from disk. Run via the executor, never on the loop."""
        self._load()

    def _load(self) -> None:
        if not self._path.exists():
            return
        try:
            data = json.loads(self._path.read_text())
        except (OSError, json.JSONDecodeError):
            return
        for row in data.get("rows", []):
            self.rows.append(
                {
                    "device": row["device"],
                    "lat": row["lat"],
                    "lon": row["lon"],
                    "first_seen": _from_iso(row["first_seen"]),
                    "last_seen": _from_iso(row["last_seen"]),
                    "moving": row.get("moving", False),
                }
            )

    def payload(self) -> dict:
        """JSON-safe payload, built on the event loop (never cross-thread)."""
        return {
            "version": STORE_VERSION,
            "rows": [
                {
                    "device": row["device"],
                    "lat": row["lat"],
                    "lon": row["lon"],
                    "first_seen": _to_iso(row["first_seen"]),
                    "last_seen": _to_iso(row["last_seen"]),
                    "moving": row["moving"],
                }
                for row in self.rows
            ],
        }

    def save_payload(self, payload: dict) -> None:
        """Atomically persist a payload captured on the event loop."""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(
            dir=str(self._path.parent), prefix=f".{self._path.name}."
        )
        try:
            with os.fdopen(fd, "w") as handle:
                json.dump(payload, handle, indent=2)
            os.replace(tmp_path, self._path)
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)

    def save(self) -> None:
        """Snapshot current rows and persist (for tests / convenience)."""
        self.save_payload(self.payload())

    def add_fix(
        self,
        device: str,
        lat: float,
        lon: float,
        timestamp: datetime,
        dedupe_radius: float,
        speed_threshold: float,
    ) -> str:
        """Ingest one GPS fix through classification + dedupe/refresh."""
        current = Fix(device, lat, lon, timestamp)
        prev = self._last_fix.get(device)
        speed = speed_between(prev, current) if prev else None
        moving = classify_moving(speed, speed_threshold)
        self.rows, action = add_fix(self.rows, current, dedupe_radius, moving)
        self._last_fix[device] = current
        return action

    def rebuild_last_fixes(self) -> None:
        """Re-seed per-device previous fixes from the most recent stored row."""
        for device in {row["device"] for row in self.rows}:
            latest = max(
                (row for row in self.rows if row["device"] == device),
                key=lambda row: row["last_seen"],
            )
            self._last_fix[device] = Fix(
                device, latest["lat"], latest["lon"], latest["last_seen"]
            )

    def purge(self, retention_days: int, now: datetime) -> bool:
        before = len(self.rows)
        self.rows = prune(self.rows, retention_days, now)
        return len(self.rows) != before

    def query(
        self,
        entity_ids: list[str] | None = None,
        since: datetime | None = None,
    ) -> list[dict]:
        """Return rows as JSON-safe dicts, optionally filtered by device and age."""
        rows = self.rows
        if entity_ids:
            wanted = set(entity_ids)
            rows = [row for row in rows if row["device"] in wanted]
        if since is not None:
            rows = [row for row in rows if row["last_seen"] >= since]
        return [
            {
                "device": row["device"],
                "lat": row["lat"],
                "lon": row["lon"],
                "first_seen": _to_iso(row["first_seen"]),
                "last_seen": _to_iso(row["last_seen"]),
                "moving": row["moving"],
            }
            for row in rows
        ]
