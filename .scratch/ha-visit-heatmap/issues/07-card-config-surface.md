# 07 — Card config surface and visual editor

**What to build:** The card's own configuration knobs, plus a visual editor element so users can configure without YAML. Knobs: `decay_rate` (10 %/day), `horizon` (30 days), `max_gap` (30 min), `show_moving` (on), `exclude_zones` (off — hides visit points inside any configured HA zone, e.g. home/work which stay solid forever via refresh). The card remains config-compatible with the default map card's keys.

**Blocked by:** 05 — Card renders the fading visit layer

**Status:** ready-for-agent

- [ ] `decay_rate`, `horizon`, `max_gap`, `show_moving`, and `exclude_zones` are honored with the glossary defaults.
- [ ] `exclude_zones` hides visit points falling inside any configured HA zone.
- [ ] A visual editor config element exposes these options and validates them.
