# Glossary — Visit Heatmap

Terms used consistently across the ADRs, code, and card config.

| Term | Definition |
|------|------------|
| **Visit point** | A recorded geographic position (lat/lon) of a tracked device, with a `first_seen` and `last_seen` timestamp. One row in the store. |
| **Dedupe radius** | Configurable distance (default ~100 m). A new fix within this radius of an existing visit point for the same device *refreshes* that point instead of creating a new one. |
| **Refresh** | Updating an existing visit point's `last_seen` to "now" when the device returns within the dedupe radius. `first_seen` is never changed. Keeps the point solid again without data growth. |
| **Stationary fix** | A position recorded while the device is not meaningfully moving. These become visit points. |
| **Moving fix** | A position recorded while the device is travelling between places. Kept as its own row so routes are visible; rendered distinctly (smaller/fainter) and toggleable. |
| **Journey** | A continuous travel episode: the consecutive moving fixes of a device that are not interrupted by a stationary visit point and not separated by more than `max_gap`. Rendered as a dashed polyline (a "journey line") between its moving fixes, fading with the recency of each segment's more-recent endpoint. |
| **Max gap** | Card config (default **30 min**): the maximum time between consecutive moving fixes for them to stay part of the same journey. |
| **Move speed threshold** | Speed (default **2 m/s ≈ 7 km/h**) between consecutive fixes of a device; a fix with speed ≥ the threshold is classified **moving**, below it **stationary**. The first fix for a device is treated as stationary. |
| **Recency** | `now − last_seen` for a visit point. The input to the decay model. |
| **Decay rate** | Card config percentage per day (default 10%). Each day, a visit point's opacity is multiplied by `(1 − decay_rate)` to the power of its fractional age in days. |
| **Horizon** | Card config age (default 30 days). Visit points older than the horizon are not rendered (hides client-side). It is a *visual* knob only. |
| **Opacity** | Rendering alpha of a visit marker, `0…1`. Computed client-side from recency, so the fade animates without refetching. |
| **Retention** | Integration storage bound: how long rows are kept (default **90 days**). Older rows are purged from the store regardless of any card's horizon. Always ≥ a likely card horizon. |
| **Companion integration** | The `custom_components/visit_heatmap`. Listens to every GPS `device_tracker` state change, maintains the store, serves data to the card over a WebSocket command. |
| **Visit-heatmap card** | The custom Lovelace card `visit-heatmap-card`. A drop-in visual replacement for the default map card (a thin clone reusing the stock `ha-map` element) with an added visit layer. |
| **Store** | The integration's durable data file: `visit-heatmap.json` in the HA config dir (see ADR-0005). |
| **Backfill** | On first install, importing up to historical GPS `device_tracker` positions for the last `backfill_days` (default 10) from the HA `history`/recorder, fed through the normal dedupe pipeline (see ADR-0007). |
| **Tracker / device** | Any HA `device_tracker` entity that exposes GPS lat/lon, e.g. a GoogleFindMy-HA tag, a phone via the companion app, OwnTracks, GPSLogger. |

## Units & defaults (single source of truth)

Defaults that live in the **integration** (set through its options flow):

| Config key | Default | Unit |
|------------|---------|------|
| `dedupe_radius` | 100 | meters |
| `move_speed_threshold` | 2 | m/s (≈ 7 km/h) |
| `retention_days` | 90 | days |
| `backfill_days` | 10 | days |

Defaults that live in the **card** config (visual, computed client-side):

| Config key | Default | Unit |
|------------|---------|------|
| `decay_rate` | 10 | %/day |
| `horizon` | 30 | days |
| `max_gap` | 30 | minutes |
| `show_moving` | true | on/off |
| `exclude_zones` | false | on/off |