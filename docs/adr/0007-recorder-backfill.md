# ADR-0007: Backfill from recorder on first install

## Status: Accepted
## Date: 2026-08-06

## Context

On a fresh install the store is empty and the map shows nothing for days/weeks. The
HA recorder already holds recent `device_tracker` state changes (default retention
~10 days) with lat/lon + timestamps — the same data the stock map card's history
trails use. The user chose to backfill.

## Decision

On first install (when no existing store is found), the integration imports up to
`backfill_days` (default **10**) of historical `device_tracker` positions from the HA
`history`/recorder for the selected entities, converting them to visit points through
the same dedupe/refresh pipeline (ADR-0002) so the backfill reuses the identical
ingestion logic.

- Requires the built-in `history` component (standard, present in the user's setup).
- Runs once; does not re-run on restart unless the store is empty.
- Uses the same `recorder_history.get_significant_states`-style read the stock card and
  GoogleFindMy-HA already use.

## Consequences

- (＋) The map shows a real, populated history on day one — better first impression
  and instantly useful.
- (＋) No special-cased code path: backfill feeds the standard dedupe pipeline.
- (－) Adds a one-time query cost on first setup (mitigated: bounded to 10 days, async,
  chunked by entity).
- (－) Backfilled points reflect recorder's retention; older than that can't be filled.

## Rejected

- **Start fresh (no backfill)** — empty map for ~a week; user chose backfill.