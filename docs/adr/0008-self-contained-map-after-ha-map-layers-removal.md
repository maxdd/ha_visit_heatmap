# ADR-0008: Self-contained Leaflet map — HA 2026.9 removed `ha-map`'s layer API

## Status: Accepted
## Date: 2026-10-17

## Context

ADR-0004 chose a thin `hui-map-card` clone: render the stock `<ha-map>` element
and inject the fading visit layer through its public `layers` property (raw
Leaflet layers), so the card inherited entity markers, zones, clustering, trails,
and dark mode without reimplementing any of it.

By August 2026 the card had grown workarounds around `ha-map`'s loading quirks:
it loaded the element on demand through the config panel's lazy chunks, waited
for its exposed `Leaflet` instance, and reused that instance for the visit layers
(a foreign Leaflet copy crashed `map.addLayer`), verifying injection against
`ha-map.leafletMap`.

Home Assistant 2026.9 changed the map underneath all of that. The frontend moved
`ha-map` onto a runtime-selected engine (MapLibre GL native, Leaflet as fallback)
and replaced the raster Carto base map with OpenStreetMap vector tiles (frontend
PRs #53816, #54022). `ha-map` no longer has a `layers` property, no `leafletMap`,
and no exposed `Leaflet`; its remaining public inputs — `entities`, `paths`,
`editableLocations` — cannot express a visit heatmap: no per-point opacity, no
dashed journey lines, fixed-size path markers, and a layer-per-path cost that
scales badly. The frontend team's guidance is explicit: custom cards should be
independent components, because frontend component APIs can change at any
release. After the update the card still rendered the base map, but the fading
visit layer — the entire point of the card — was silently gone.

Home Assistant 2026.9 also added the **Map tiles** integration as a `frontend`
dependency: it serves OSM raster tiles through the instance
(`/api/map_tiles/raster/{z}/{x}/{y}.png`, token from the
`map_tiles/access_token` WebSocket command, also accepted as a query parameter so
a plain `<img>`/Leaflet `tileLayer` can use it). That makes a self-contained map
possible without external tile hosts or API keys.

## Decision

The card renders **its own Leaflet map**; it no longer uses `<ha-map>`.

- **Base tiles**: when the `map_tiles` component is loaded, fetch the access token
  and point a Leaflet `tileLayer` at
  `/api/map_tiles/raster/{z}/{x}/{y}.png?token={token}` (the same way core's
  non-WebGL fallback does). Refresh the token periodically and on `tileerror`.
  On older Home Assistant (no `map_tiles`), fall back to the raster tiles the
  stock map itself used before the switch (Carto). Dark mode inverts raster tiles
  in CSS, as core does for its raster fallback.
- **Card-owned map furniture**: entity markers (per-device colored, picture/icon,
  tooltips, `hass-more-info` on click), zone circles + markers for `zones`,
  clustering of entity markers via `leaflet.markercluster`, `hours_to_show` trails,
  `default_zoom` / `auto_fit` / `fit_zones` view handling, and the card's
  `max_width` / `aspect` / stock `aspect_ratio` layout knobs.
- The card's own visit machinery is unchanged: decay opacity, `max_points`
  downsampling, moving/journey styles, `max_gap` / `max_dist` journey rules,
  tooltips, `since`-scoped fetch, refresh triggers, debug overlay.

## Consequences

- (＋) The visit layer works on HA 2026.9+ and is decoupled from frontend map
  internals — the class of breakage this ADR responds to cannot recur.
- (＋) Leaflet (already bundled) plus `leaflet.markercluster` keep the full fading
  feature set: per-point opacity, dashed moving dots and journey lines, canvas
  rendering for many points. Owning the map also removes the dual-Leaflet-copy
  constraint: layers and map come from the same bundled Leaflet by construction.
- (＋) Tiles stay private: the browser talks only to the Home Assistant instance on
  2026.9+.
- (－) The card owns map furniture it used to delegate; marker styling is close to
  but not identical to the stock map (no avatar-frame parity).
- (－) On Home Assistant before 2026.9 the Carto fallback shows the provider's
  API-key notice — exactly what the stock map shows there today.
- (－) The bundle grows (Leaflet + markercluster stay bundled; ~235 KB minified).

## Rejected

- **Use the new public `paths` API** — a single-point path per visit could borrow
  the trail renderer, but opacity is per path (and ramps), markers are fixed
  3 px circles, journey lines cannot be dashed, and one path per visit is a
  MapLibre layer per visit.
- **Use `editableLocations` for dots** — arbitrary DOM per visit, an API meant for
  editing, and no lines/performance story.
- **Keep patching the stock element** (on-demand loading, private `leafletMap`
  probing) — the surviving private hooks are exactly what the engine rewrite
  removed; any future frontend release can do the same again.
- **Fork or vendor `ha-map`** — recreates the same coupling to frontend internals
  the breakage came from, with even more code to own.