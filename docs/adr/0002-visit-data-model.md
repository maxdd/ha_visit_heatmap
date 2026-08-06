# ADR-0002: Visit data model — deduped raw fixes, moving fixes recorded

## Status: Accepted
## Date: 2026-08-06

## Context

The user chose **"Raw fixes"** as the visit model and **"Yes, record all fixes"** for
movement. Taken literally, raw fixes with no collapsing produce a monster:

- A device sitting at home is polled every ~5 min → thousands of identical rows,
  ~300/day/device.
- "Today = solid" weight would be meaningless with hundreds of overlapping identical
  points.
- The store grows unbounded.

The user also chose **"Dedupe by distance, refresh weight,"** which resolves this.

## Decision

Maintain a store of deduped visit records. Each record:

```
{
  device:       <device_tracker entity id>,
  lat, lon,     // position, rounded to GPS precision
  first_seen, last_seen:   // timestamps
  moving: bool   // true if recorded during travel, false if stationary
}
```

**Dedupe rule:** a newly recorded fix for a device collides with an existing row
(any) for that device whose position lies within `dedupe_radius` (default 100 m). On
collision, **refresh** the row's `last_seen` to now (its `first_seen` is **never**
changed), update its `moving` flag, and do **not** add a new row.

**Still vs moving** (the `moving` flag) is decided by **speed between consecutive
fixes** of the device: `distance(prev, new) / Δt`. Above `move_speed_threshold`
(default 2 m/s) the fix is *moving*; otherwise *stationary*. The first fix for a
device is treated as stationary. This handles both data sources: a phone driving
yields high-speed moving rows, while a GoogleFindMy tag that only reports at its
destination yields a large distance but a huge Δt → low speed → correctly a
stationary visit (see ADR-0003 ownership split in ADR-0003).

**Moving fixes are their own rows**, deduped by the same radius so travelled routes
remain visible as chains of points (during travel, consecutive fixes are far apart
and rarely collide).

## Consequences

- (＋) Data stays small: worst case tens of rows/day/device; "home" is one row that
  stays solid while you are there.
- (＋) `moving` separation feeds the card's still/moving distinction (ADR-0004).
- (－) A very large dedupe radius can collapse nearby genuine distinct places; the
  default 100 m balances GPS jitter vs. locality and is configurable.
- (－) A drive-by within the radius of a stationary place will refresh that place's
  weight — an acceptable edge case, mitigated by the moving flag rendering separately.

## Rejected alternatives

- **Record every fix** — rejected: store bloat, home becomes a solid blob, no meaningful per-place recency.
- **One per place per day** — rejected: a morning and an evening visit to the same place that day would collide.