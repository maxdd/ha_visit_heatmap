# ADR-0003: Decay model — multiplicative daily fade to zero, configurable horizon

## Status: Accepted
## Date: 2026-08-06

## Context

The core requirement: a visit drawn today is solid; each day it fades "by a certain
percentage." Candidates were:

1. **Multiplicative, fade to zero** — `opacity = (1 − rate)^days`, floored at 0, with a
   configurable horizon that drops markers below threshold.
2. **Asymptotic** — `opacity = exp(−days/τ)`, never reaching 0.
3. **Floor, no auto-removal** — markers sit at fixed low opacity until manually cleared.

The user chose option 1.

## Decision

**Both `decay_rate` and `horizon` are card-config knobs.** Per-visit opacity is
computed **client-side** from recency:

```
age_days = (now − last_seen) / 86400   // fractional days (continuous fade)
opacity   = max(0.0, (1 − decay_rate)^age_days)
```

- `decay_rate` default **10%/day**, `horizon` default **30 days**.
- The card renders nothing for rows with `age_days > horizon` (hid client-side).
- Because the integration owns storage, not the visual life of a point, it keeps
  rows up to `retention_days` (default 90) and **does not prune by the card's
  horizon** — so multiple cards with different horizons all work, and the fade rule
  stays in one place (the renderer). See ADR-0005.

Computation lives client-side so the fade is always correct on load and animates
smoothly without a backend fetch.

## Consequences

- (＋) Faithful to the user's "fade by a percentage each day" (compound decay).
- (＋) Old haunts disappear entirely after the horizon — no permanent faint artifacts.
- (＋) Client-side computation means zero backend work on a timer — recency is derived
  from `last_seen` already stored.
- (－) Two knobs (`decay_rate`, `horizon`) to explain; defaults make the behavior easy
  to predict.

## Rejected

- **Asymptotic** — markers accumulate forever faintly, cluttering the map; also
  conflicts with a clean "places I've been recently" reading.
- **Floor / manual clear** — not a real fade, and needs user upkeep.