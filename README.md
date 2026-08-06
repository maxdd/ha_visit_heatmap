# Visit Heatmap

A fading **visit-history layer** for the Home Assistant map. Every position a
tracked device has visited is drawn on a Lovelace map card with an opacity
proportional to how recently it was there. Today's visit is solid; each day it
fades by a configurable percentage until it drops below a horizon and disappears.
Movement between places is drawn as fading dotted journey lines.

A **single HACS repo** with two parts:

- a small companion integration (`custom_components/visit_heatmap`) that durably
  records visit points from **any** GPS `device_tracker` entity (GoogleFindMy-HA
  tags, phones via the companion app, OwnTracks, GPSLogger, ...), and
- a custom Lovelace card (`visit-heatmap-card`) that reuses the stock `ha-map`
  element — so it looks like the default map card — and adds the fading visit layer.

Design rationale and decisions are recorded as ADRs in [`docs/adr/`](docs/adr/).

## Features

- **Age-based fade.** Visit points saturate at full opacity the moment you're there
  and fade continuously: `opacity = (1 − decay_rate) ^ age_days`, hidden once older
  than `horizon`. All computed client-side, so the fade is always live.
- Works with any tracker — phones, tags, OwnTracks, GPSLogger — no per-integration code.
- **Dedupe/refresh.** A device returning within `dedupe_radius` (default 100 m) of a
  past visit refreshes that visit instead of piling up duplicate dots.
- **Per-device colors**, so each tracker's history is attributable at a glance.
- **Moving vs stationary.** Fixes during travel are recorded separately, rendered
  small and faint, and joined into **dashed journey lines** that fade by recency.
- **Drop-in map replacement.** Accepts the default map card's config
  (`entities`, `zones`, `hours_to_show`, `default_zoom`, `theme_mode`, `cluster`, ...)
  and reuses the stock `ha-map` element for markers, zones, trails, clustering.
- **Backfill.** On first install it imports up to `backfill_days` of recorder
  history so the map is populated on day one.

## Installation

1. Add this repository to HACS (custom repositories, category **Integration**).
2. Install **Visit Heatmap**, then restart Home Assistant.
3. Add the **Visit Heatmap** integration (Settings → Devices & Services → Add
   integration). No configuration needed — it starts recording GPS trackers.
4. Add a **Visit Heatmap** card to a Lovelace dashboard. Select the
   `device_tracker` entities you want to map (`person` entities are not mapped —
   pick their underlying `device_tracker` instead).

The card resource is registered automatically; no manual resource step is required.

## Card configuration

```yaml
type: custom:visit-heatmap-card
title: "Where I've been"
entities:
  - device_tracker.my_phone
  - device_tracker.my_tag
decay_rate: 0.1      # 10% per day (default)
horizon: 30          # days until a visit disappears (default)
show_moving: true    # show moving points + journey lines
exclude_zones: false # hide visits inside configured HA zones
max_gap: 30          # minutes to join two moving fixes into one journey (default)
```

It also accepts the default map card's keys: `zones`, `hours_to_show`,
`default_zoom`, `auto_fit`, `fit_zones`, `theme_mode`, `dark_mode`, `cluster`,
`show_all`, `aspect_ratio`.

## Integration options

Via **Devices & Services → Visit Heatmap → Options**:

| Key | Default | Meaning |
|-----|---------|---------|
| `dedupe_radius` | 100 m | A new fix within this distance of a past visit refreshes it |
| `move_speed_threshold` | 2 m/s | Above this speed a fix is "moving" |
| `retention_days` | 90 | How long rows are kept, regardless of any card's horizon |
| `backfill_days` | 10 | Recorder history imported on first install |

## Development

An [interactive wiki](docs/interactive-wiki.html) (open in a browser) walks the
data flow, the classification/dedupe decisions, and the card's render pipeline
with clickable diagrams, the decay curve, and a logic playground.

```bash
npm install
npm run build       # builds the card bundle into custom_components/visit_heatmap/www/
python -m pytest     # unit tests for the integration's pure logic
ruff check custom_components/visit_heatmap
```

There is no test runtime for the card; verify by eye on a Home Assistant instance.

### Local dev against a docker-compose Home Assistant

Instead of HACS, bind-mount this repo's `custom_components` over the container's
(live code edits apply on HA restart or integration reload):

```yaml
services:
  homeassistant:
    image: ghcr.io/home-assistant/home-assistant:stable
    volumes:
      - /path/to/ha-visit-heatmap/custom_components:/config/custom_components
```

Then restart HA and add the **Visit Heatmap** integration. Only mount the whole
`custom_components` directory if you don't already track other custom integrations
in it; otherwise copy the `visit_heatmap` folder in instead.

## Releasing

Releases are published as GitHub releases with a `visit-heatmap.zip` asset
(`zip_release` mode in `hacs.json`). Before tagging, verify:

1. Bump `version` in `custom_components/visit_heatmap/manifest.json` (and
   optionally `package.json`).
2. `npm run build` and commit the rebuilt
   `custom_components/visit_heatmap/www/visit-heatmap-card.js`.
3. `python -m pytest` and `ruff check custom_components/visit_heatmap` both pass.
4. `node --check custom_components/visit_heatmap/www/visit-heatmap-card.js` passes.
5. Tag `vX.Y.Z` matching the manifest version.
6. Create a GitHub release for the tag and attach the built
   `visit-heatmap-card.js` renamed to `visit-heatmap.zip`.