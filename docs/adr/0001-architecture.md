# ADR-0001: Architecture — new card + companion integration

- Status: Accepted
- Date: 2026-08-06

## Context

The user wants a "location visit heatmap" on the HA map: positions a device has
visited, with opacity proportional to how recently it was there. Two candidate
delivery paths were considered:

- **Extend GoogleFindMy-HA** (the integration currently tracking the user's Find My
  Hub devices) and merge a PR upstream.
- **A completely separate integration** that collects positions from any tracker.

Research showed the official map card (`hui-map-card.ts` / `ha-map.ts`, Leaflet-based)
has **no heatmap support**, so the visualization must be a custom Lovelace card either
way. GoogleFindMy-HA stores **no history of its own** — it depends on HA's `recorder`
and already exposes standard `device_tracker` entities, so its data is reachable
through the same generic `device_tracker` interface as any phone/OwnTracks/GPSLogger.

The user owns several device types (Google Find My tags, phones) and wants the heatmap
to apply to all of them, not just the Find My Hub integration.

## Decision

Build a **standalone Lovelace custom card** (`visit-heatmap-card`) that renders the
heatmap, backed by a **small companion integration** (`custom_components/visit_heatmap`)
that records visits from **any** `device_tracker` entity. Do **not** fork or extend
GoogleFindMy-HA.

## Consequences

- (＋) Device-agnostic: tags, phones, OwnTracks, GPSLogger all work with zero
  per-integration work.
- (＋) Loose coupling: GoogleFindMy-HA can change its internals without breaking the
  heatmap, provided it still exposes `device_tracker` GPS entities.
- (＋) Decoupling lets each piece evolve (recorder vs card) independently.
- (－) Two components to build and maintain (though in one repo, see ADR-0006).
- (－) No upstream credit/community surface from the GoogleFindMy-HA maintainers; the
  heatmap is a separate brand.

## Decision driver

The user explicitly preferred "a completely different integration … that collects any
position … I could also track other devices like my phones."