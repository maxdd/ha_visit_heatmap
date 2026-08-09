# ADR-0004: Rendering and card scope — full map-clone, per-device colors, moving vs still

## Status: Accepted
## Date: 2026-08-06

## Context

The user wants the heatmap "in the default map" and "as a level on the map lovealce."
The official map card cannot render it, so it must be a custom card. The user chose:

- A **full map-card clone + heat layer** (the card visually replaces the default map
  card, so the dashboard keeps its current appearance and behaviour, plus the visit
  layer).
- **Per-device colors** so each tracker's history is attributable.
- **Move fixes recorded** with a distinct, **toggleable** style vs stationary visits.

## Decision (revised 2026-08-06: reuse stock `ha-map` + injected layers)

`visit-heatmap-card` is a **thin clone of `hui-map-card`** that renders the stock
`<ha-map>` element and passes the same inputs it already supports — `entities`,
`paths` (recent trails), `zones`, clustering, dark mode, fit — plus visit points
injected as raw Leaflet layers via `ha-map`'s `layers` property. This avoids
reimplementing Leaflet rendering entirely; the card only owns config parsing, the
history subscription, and building the visit layer.

- Each visit point renders as a Leaflet circle/divIcon marker with:
  - **stroke/shape color = device color** (same palette scheme as the stock map card),
  - **opacity from ADR-0003** (client-side recency fade),
  - tooltip: device name, "last seen" time, and the name of any HA zone it falls in.
- **Moving rows** render with a smaller, fainter, dashed style so routes read
  separately from destinations; a card config toggle (`show_moving`, default on)
  lets the user show only stationary places.
- **Journey lines**: within each journey, consecutive moving fixes are joined by a
  dashed polyline (device color), so a continuous travel episode reads as a route.
  Segmentation is computed at render time: consecutive moving rows belong to the
  same journey unless a stationary visit point that lasted at least `max_gap` falls
  chronologically between them, or both the time gap (`max_gap`, default ~30 min) and
  the distance (`max_dist`, default ~1000 m) are exceeded. Each
  segment's opacity equals the decay opacity of its more-recent endpoint, so an old
  journey fades like its points. Journey lines are governed by the same
  `show_moving` toggle.
- `exclude_zones` (default off) hides any visit point that falls inside a configured
  HA zone (e.g. home/work, which stay solid forever via dedupe-refresh).
- The card is config-compatible with the default map card (accepts `entities`,
  `zones`, `hours_to_show`, etc.) so users can drop it in with minimal YAML changes.
- No reverse geocoding in v1 (no external place-name API).

## Consequences

- (＋) Dashboard continuity: same look, extra layer.
- (＋) Attributeable: which device visited where - per-colour.
- (＋) Routes vs places visually distinct and toggleable.
- (＋) Far less code to own than a Leaflet reimplementation; inherits stock marker,
  zone, trail, clustering, dark-mode, and fit behavior.
- (－) Couples the card to `ha-map`'s public properties (e.g. `layers`), which are
  part of HA's published component API; drift is possible if those change, but the
  card is small enough to adapt.

## Rejected

- **Heat layer as a separate standalone card** (two cards side-by-side) — loses the
  "in the default map" feel, adds a second dashboard card.
- **Single combined layer** — can't distinguish devices at a glance.