# 03 — Backfill from recorder on first install

**What to build:** On a fresh install the store is empty, so the map would show nothing for days. On first setup (when no existing store is found), the integration imports up to `backfill_days` (default 10) of historical GPS `device_tracker` positions from the HA `history`/recorder, feeding them through the exact same speed/dedupe pipeline used for live fixes so backfilled and live rows are indistinguishable.

**Blocked by:** 01 — Integration core: record GPS fixes into the store

**Status:** done

- [x] A fresh install imports up to `backfill_days` of recorder history for GPS trackers through the shared dedupe pipeline.
- [x] The backfill runs once; a restart with data still present does not re-run it, but an empty store does.
- [x] Backfilled rows are indistinguishable from live-recorded rows in the store and via the WS API.
