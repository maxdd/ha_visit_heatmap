# 02 — WebSocket read API

**What to build:** A WebSocket command `visit_heatmap/points` that takes an entity list and returns the non-expired visit rows for exactly those entities, so any client (the card, devtools, tests) can read what the integration has recorded. Expiry is purely retention-based — the card's visual horizon is applied client-side, not here.

**Blocked by:** 01 — Integration core: record GPS fixes into the store

**Status:** done

- [x] `visit_heatmap/points` accepts an entity list and returns rows shaped as device, lat, lon, `first_seen`, `last_seen`, `moving` for exactly those entities.
- [x] Rows older than `retention_days` are excluded; no horizon filtering happens server-side.
- [x] Tests verify payload shape and entity filtering (including entities with no recorded rows). — Verified via `store.query` (the handler is a thin wrapper delegating to it); direct WS tests are out of scope because the no-HA test env can't import `homeassistant`. See `tests/test_store.py::test_query_payload_shape_matches_ws_contract` and `test_query_ignores_person_entities`.
