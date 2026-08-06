# 04 — Integration options flow

**What to build:** An options flow on the integration so the storage/ingestion defaults are tunable: `dedupe_radius`, `move_speed_threshold`, `retention_days`, `backfill_days`, with the glossary defaults pre-filled. Changing them takes effect on already-stored data where applicable (purge respects a lowered `retention_days`) without requiring the store to be wiped.

**Blocked by:** 01 — Integration core: record GPS fixes into the store

**Status:** done

- [x] Options UI exposes `dedupe_radius`, `move_speed_threshold`, `retention_days`, `backfill_days` with defaults from the glossary.
- [x] Saved options persist across restarts and immediately affect new ingest/purge behavior.
- [x] Lowering `retention_days` purges eligible rows without user intervention.
