# Visit Heatmap — design docs

A fading **visit-history layer** for the Home Assistant map: every position a tracked
device has visited is drawn on a Lovelace map card with an opacity proportional to
how recently it was visited. Today's visit is solid; each day it fades by a
configurable percentage until it drops below a horizon and disappears.

Delivered as a **single HACS repo** `ha-visit-heatmap` containing:

- a small companion integration (`custom_components/visit_heatmap`) that durably
  records visit points from **any** `device_tracker` entity (GoogleFindMy-HA tags,
  phones, OwnTracks, GPSLogger, …), and
- a custom Lovelace card (`visit-heatmap-card`) that renders a full map (entities,
  zones, recent trails — a visual clone of the default map card) plus the fading
  visit layer.

## Status

Design session complete. Decisions recorded as ADRs in [`adr/`](adr/).
ADRs 0002–0005 were refined on 2026-08-06 (speed-based still/moving, card-owned
fade+horizon with server `retention_days`, reuse stock `ha-map` + injected layers,
card refresh triggers).

| # | Decision | ADR |
|---|----------|-----|
| 1 | Architecture: new card + companion integration, not a GoogleFindMy-HA fork | [0001](adr/0001-architecture.md) |
| 2 | Data model: deduped raw fixes; moving fixes recorded, speed-classified | [0002](adr/0002-visit-data-model.md) |
| 3 | Decay: continuous client-side fade; card owns decay_rate + horizon | [0003](adr/0003-decay-model.md) |
| 4 | Rendering: thin hui-map-card clone reusing stock `ha-map` + injected layers | [0004](adr/0004-rendering-and-card-scope.md) |
| 5 | Storage & API: JSON store + WebSocket command; card fetches on load/state-change/periodic | [0005](adr/0005-storage-and-card-api.md) |
| 6 | Packaging: single HACS repo `ha-visit-heatmap` | [0006](adr/0006-packaging-and-naming.md) |
| 7 | Backfill: import recorder history on first install | [0007](adr/0007-recorder-backfill.md) |

## Terms

Domain vocabulary is defined in the [glossary](GLOSSARY.md).
