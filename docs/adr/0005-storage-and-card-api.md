# ADR-0005: Storage and card-to-integration API

## Status: Accepted
## Date: 2026-08-06

## Context

The companion integration must durably store visit points (months/years of data,
far beyond the ~10-day recorder default) and the card must read them. The card is a
frontend component (JS) running in the browser; it needs a backend-facing way to get
the data.

Options considered for storage:
- HA `recorder` only — rejected: default retention ~10 days, too short for a
  months-long fade; and the visit model (refresh-in-place on dedupe, `moving` flag,
  decay-dropped rows) isn't naturally expressed as state history.
- Reuse GoogleFindMy-HA's pattern (its `location_recorder.py` reads recorder history)
  — but we aren't forking it (ADR-0001).

## Decision

**Storage:** a single JSON file `visit-heatmap.json` written to the HA config
directory (`config.config_dir`), with an in-memory cache in the integration. Writes
are debounced/coalesced and the file is written atomically (write-tmp-then-rename) to
avoid corruption on crash. Rows older than `retention_days` (default 90) are purged
on startup and opportunistically on write; this is the only server-side expiry — the
card owns the visual horizon (ADR-0003).

**Read path for the card:** a **WebSocket command** `visit_heatmap/points`
(similar to HA's `history/stream` pattern). The card passes the **entity list it is
configured to show**; the integration returns the non-expired visit rows for exactly
those entities. The card computes opacity and hides past-horizon rows client-side
(ADR-0003), so only raw rows and `last_seen` are transferred.

**Write path:** the integration subscribes to all `device_tracker` state-change
events (`EVENT_STATE_CHANGED` filtered to entities that expose GPS lat/lon) and
applies the speed/dedupe/refresh rule (ADR-0002). No per-entity selection UI: every
GPS tracker is recorded; cards filter at read time.

**Freshness:** the card fetches on load, refetches whenever any configured entity's
state changes (cards already receive `hass` updates on every state change), and
refetches on a slow periodic timer (~5 min) as a safety net. No backend push.

## Consequences

- (＋) Simple, human-inspectable store; no DB schema.
- (＋) Atomic write avoids corruption; debounce avoids write storms from poll-driven
  updates.
- (＋) WebSocket command is a clean, browser-accessible read API.
- (－) JSON file scales only to tens of thousands of rows; far beyond expected
  usage. If it grows, migrate to recorder or sqlite.
- (－) Two sync mechanisms (state-changed subscription vs. file) must stay in agreement;
  mitigated by the file being the single source of truth.

## Rejected

- **Recorder as primary store** — retention too short, data model mismatch.
- **Expose via REST AIP** — more moving parts than a WS command; card already speaks WS
  via `hass.connection`.