# 01 — Integration core: record GPS fixes into the store

**What to build:** Installing the companion integration (a minimal config flow: just "enable") begins silently recording every GPS-capable `device_tracker` entity. For each fix it classifies it as moving or stationary by speed between consecutive fixes (threshold `move_speed_threshold`, first fix counts as stationary), dedupes stationary fixes within `dedupe_radius` by refreshing the existing visit point's `last_seen` in place (`first_seen` is never changed), stores moving fixes as separate rows, and purges rows older than `retention_days`. All rows land in the durable store via atomic (tmp+rename) debounced writes. The classification/dedupe/purge logic is written as pure functions so it can be unit-tested without an HA runtime.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Enabling the integration creates a config entry and subscribes to `device_tracker` state-change events; only entities exposing GPS lat/lon are considered.
- [ ] A stationary fix within `dedupe_radius` of an existing row for the same device refreshes that row (`last_seen` → now, `first_seen` untouched) instead of creating a new row.
- [ ] Speed between consecutive fixes ≥ `move_speed_threshold` classifies a fix as moving; below it, stationary; the first fix for a device is stationary.
- [ ] The store survives restarts; writes are atomic and coalesced; rows older than `retention_days` are purged on startup and opportunistically.
- [ ] Unit tests cover dedupe/refresh, still-vs-moving classification, and retention pruning.
