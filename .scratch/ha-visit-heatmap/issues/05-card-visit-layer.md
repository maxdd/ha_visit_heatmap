# 05 — Card renders the fading visit layer

**What to build:** The tracer bullet that makes the whole thing visible. Installing the repo as a HACS integration registers the visit-heatmap-card as a frontend resource automatically. The card is a drop-in replacement for the default map card — a thin clone that reuses the stock `ha-map` element (so it inherits entity markers, zones, marker clustering, recent trails, dark mode, and fit) — and adds the visit layer: one circle per visit point, in the device's color, with opacity computed client-side as `(1 − decay_rate)^age_days` and rows past `horizon` hidden client-side. Tooltips show device name, last-seen time, and the zone name when a point falls inside one. It fetches rows over the WS command on load, on any configured-entity state change, and on a ~5-minute periodic timer.

**Blocked by:** 01 — Integration core; 02 — WebSocket read API

**Status:** done

- [x] Single HACS repo installs the integration and registers the card JS as a frontend resource with no manual resource step.
- [x] The card renders stock map behavior (entities, zones, recent trails, clustering) by reusing the stock `ha-map` element and accepts the default card's config keys.
- [x] Visit points render as circles in per-device colors with client-side decay opacity; rows older than `horizon` are not shown.
- [x] Rows are fetched on load, on configured-entity state change, and on the periodic timer.
- [x] Tooltips show device name, last-seen time, and the enclosing zone name.