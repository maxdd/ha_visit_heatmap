# 06 — Moving fixes and journey dotted lines

**What to build:** Extend the card so travel is visible too. Moving rows render as small, faint markers distinct from stationary visit points, toggleable via `show_moving`. Consecutive moving fixes are joined into journeys at render time — a dotted device-colored polyline whose segmentation breaks whenever a stationary visit point falls chronologically between fixes or the gap between them exceeds `max_gap` (default 30 min). Each journey segment's opacity is the decay opacity of its more-recent endpoint, so old journeys fade like their points. Journey lines obey the same `show_moving` toggle.

**Blocked by:** 05 — Card renders the fading visit layer

**Status:** done

- [x] Moving rows render distinctly from stationary visit points and are hidden when `show_moving` is off.
- [x] Consecutive moving fixes form journeys segmented by chronologically interleaved stationary visits and by `max_gap` gaps.
- [x] Journeys render as dashed polylines in the device color, each segment fading with its more-recent endpoint's opacity.
