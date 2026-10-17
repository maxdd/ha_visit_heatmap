import { LitElement, html, css, nothing, unsafeCSS } from "lit";
// Default import: markercluster is a CommonJS plugin that augments this very
// module object, which a namespace copy of the import would not see.
import L from "leaflet";
import "leaflet.markercluster";
import leafletCss from "leaflet/dist/leaflet.css";
import markerClusterCss from "leaflet.markercluster/dist/MarkerCluster.css";
import {
  haversineM,
  decayOpacity,
  withinHorizon,
  parseEntities,
  journeySegments,
  parseAspectRatio,
  gradientOpacity,
} from "./logic.mjs";

const DECAY_RATE_DEFAULT = 0.1;
const HORIZON_DEFAULT = 30;
const MAX_GAP_DEFAULT = 30;
const MAX_DIST_DEFAULT = 1000;
const MAX_POINTS_DEFAULT = 5000;
const REFRESH_PERIOD_MS = 300000;
const REFETCH_DEBOUNCE_MS = 1500;
const PROGRAMMATIC_FIT_DELAY = 250;

// The card owns its map. HA 2026.9 replaced `ha-map`'s Leaflet internals with
// a runtime-selected MapLibre/Leaflet engine and dropped the `layers` property
// earlier versions of this card injected through, so the visit layer can no
// longer ride on the stock element (see ADR-0008).
const MAP_MIN_ZOOM = 1;
const MAP_MAX_ZOOM = 20;
const RASTER_MAX_NATIVE_ZOOM = 19;
const HOME_LOCATION_FALLBACK = [52.3731339, 4.8903147];

// Core's Map tiles proxy (HA >= 2026.9): no external tile requests, no API
// keys. The token comes from the `map_tiles/access_token` WS command and also
// rides in the query string, which is what an <img> tile request can carry.
const MAP_TILES_PATH = "/api/map_tiles";
const MAP_TILES_RASTER_URL = `${MAP_TILES_PATH}/raster/{z}/{x}/{y}.png?token={token}`;
const TOKEN_REFRESH_MS = 20 * 60 * 1000;
const TILE_RECOVERY_THROTTLE_MS = 30000;
const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// Fallback for Home Assistant versions before the Map tiles integration. This
// is the same raster source the stock map itself fell back to, including the
// same caveat: the provider now paints an API-key notice over its tiles.
const CARTO_TILE_URL =
  "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";
const CARTO_ATTRIBUTION = `${OSM_ATTRIBUTION} &copy; <a href="https://carto.com/attributions">CARTO</a>`;
const CARTO_SUBDOMAINS = "abcd";

const COLOR_PALETTE = [
  "#1976d2", "#d32f2f", "#fbc02d", "#388e3c", "#8e24aa", "#00796b",
  "#5d4037", "#e64a19", "#303f9f", "#c2185b", "#0097a7", "#7b1fa2",
];

const WS_POINTS = "visit_heatmap/points";
const WS_DEBUG = "visit_heatmap/debug";
const WS_HISTORY = "history/stream";
const WS_MAP_TILES_TOKEN = "map_tiles/access_token";

const DEFAULT_ENTITY_ICON = "mdi:crosshairs-gps";
const DEFAULT_ZONE_ICON = "mdi:map-marker";

function fireEvent(node, type, detail) {
  node.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}

function formatTs(ms) {
  const d = new Date(ms);
  return `${d.toLocaleTimeString()}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Canvas is much faster for the many small visit circles; without a 2d context
// (e.g. jsdom tests) Leaflet's SVG renderer still draws them.
function prefersCanvas() {
  try {
    return Boolean(document.createElement("canvas").getContext("2d"));
  } catch {
    return false;
  }
}

class VisitHeatmapCard extends LitElement {
  static properties = {
    hass: { attribute: false },
    _config: { state: true },
    _layers: { state: true },
    _paths: { state: true },
    _error: { state: true },
  };

  constructor() {
    super();
    this._config = {};
    this._configEntities = [];
    this._colors = new Map();
    this._layers = [];
    this._paths = undefined;
    this._rows = [];
    this._history = undefined;
    this._historyUnsub = undefined;
    this._timer = undefined;
    this._stateSig = "";
    this._refetchTimer = undefined;
    this._zones = undefined;
    this._debugLines = [];
    this._debug = {};
    this._backendDebug = "";

    this._configDirty = false;
    this._map = undefined;
    this._tileLayer = undefined;
    this._tileSource = undefined;
    this._tileTokenTimer = undefined;
    this._lastTileRecovery = 0;
    this._entitiesGroup = undefined;
    this._entitiesSig = undefined;
    this._zonesGroup = undefined;
    this._zonesSig = undefined;
    this._trailsGroup = undefined;
    this._visitsGroup = undefined;
    this._resizeObserver = undefined;
    this._autoFitPaused = false;
    this._programmaticFit = false;
    this._pendingFit = undefined;
  }

  _log(...args) {
    if (!this._config?.debug) return;
    const line = `[${formatTs(Date.now())}] ${args.join(" ")}`;
    this._debugLines = [...this._debugLines.slice(-49), line];
    console.debug("[visit-heatmap]", ...args);
  }

  setConfig(config) {
    if (!config) throw new Error("Error in card configuration.");
    if (!config.show_all && !config.entities?.length) {
      throw new Error("Either show_all or entities must be specified");
    }
    if (config.entities && !Array.isArray(config.entities)) {
      throw new Error("Entities need to be an array");
    }
    this._config = { ...config };
    this._configEntities = this._parseEntities(config);
    this._configDirty = true;
    this._autoFitPaused = false;
    this._scheduleRefetch();
    this._log("setConfig", JSON.stringify({ ...config, entities: this._entities }));
  }

  _parseEntities(config) {
    return parseEntities(config, this.hass?.states || {}, this.hass?.entities || {});
  }

  _zoneEntities() {
    if (!this._config.zones) return [];
    const config = this._config;
    const list = Array.isArray(config.zones) ? config.zones : [config.zones];
    return list.map((z) =>
      typeof z === "string"
        ? { entity_id: z, color: this._color(z) }
        : { entity_id: z.entity, color: z.color || this._color(z.entity) }
    );
  }

  _color(entityId) {
    if (this._colors.has(entityId)) return this._colors.get(entityId);
    const color = COLOR_PALETTE[this._colors.size % COLOR_PALETTE.length];
    this._colors.set(entityId, color);
    return color;
  }

  get _entities() {
    return this._configEntities.map((e) => e.entity);
  }

  connectedCallback() {
    super.connectedCallback();
    this._log("connected, hass=", !!this.hass, "connection=", !!this.hass?.connection);
    this._fetchAll();
    this._timer = window.setInterval(() => this._fetchAll(), REFRESH_PERIOD_MS);
    document.addEventListener("visibilitychange", this._onVisibility);
    // Re-inserting an already rendered element does not schedule an update,
    // but its map was torn down on disconnect and has to be rebuilt.
    if (this.hasUpdated && !this._map) {
      this._remountMap();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._log("disconnected");
    window.clearInterval(this._timer);
    window.clearTimeout(this._refetchTimer);
    document.removeEventListener("visibilitychange", this._onVisibility);
    this._unsubscribeHistory();
    this._teardownMap();
  }

  _teardownMap() {
    window.clearInterval(this._tileTokenTimer);
    this._tileTokenTimer = undefined;
    this._resizeObserver?.disconnect();
    this._resizeObserver = undefined;
    this._map?.remove();
    this._map = undefined;
    this._tileLayer = undefined;
    this._tileSource = undefined;
    this._entitiesGroup = undefined;
    this._zonesGroup = undefined;
    this._trailsGroup = undefined;
    this._visitsGroup = undefined;
    this._entitiesSig = undefined;
    this._zonesSig = undefined;
    this._pendingFit = undefined;
  }

  _onVisibility = () => {
    if (!document.hidden) {
      this._autoFitPaused = false;
      this._map?.invalidateSize();
      this._scheduleRefetch();
    }
  };

  willUpdate(changedProps) {
    if (changedProps.has("hass") && this.hass) {
      this._zones = undefined;
      const oldHass = changedProps.get("hass");
      if (!oldHass || oldHass.connection !== this.hass.connection) {
        this._log("hass connection changed, refetching");
        this._fetchAll();
      }
      if (this._config.show_all) {
        this._configEntities = this._parseEntities(this._config);
      }
      const sig = this._entities
        .map((e) => `${e}:${this.hass.states?.[e]?.last_updated || ""}`)
        .join("|");
      if (sig !== this._stateSig) {
        this._stateSig = sig;
        this._scheduleRefetch();
      }
      if (changedProps.get("hass")?.config?.components !== this.hass.config.components) {
        this._subscribeHistory();
      }
    }
  }

  updated(changedProps) {
    const container = this.renderRoot?.querySelector("#map");
    if (!this._map) {
      this._remountMap();
    } else if (this._map.getContainer() !== container) {
      // The error card replaced the map DOM; drop the stale map and rebuild.
      this._teardownMap();
      this._remountMap();
    }
    if (!this._map) return;

    if (this._configDirty) {
      this._configDirty = false;
      this._applyTheme();
      this._renderEntitiesIfChanged(true);
      this._renderZonesIfChanged(true);
      this._renderTrails();
      if (this._config.auto_fit) {
        this._autoFitPaused = false;
        this._fitToData();
      } else {
        this._map.setZoom(this._config.default_zoom ?? 14);
      }
    }

    if (changedProps.has("hass")) {
      this._applyTheme();
      this._renderEntitiesIfChanged();
      this._renderZonesIfChanged();
    }

    if (changedProps.has("_layers") || changedProps.has("_paths")) {
      this._renderVisits();
      this._renderTrails();
    }
  }

  _remountMap() {
    if (!this.isConnected) return;
    this._createMap();
    if (!this._map) return;
    this._configDirty = false;
    this._applyTheme();
    this._renderEntitiesIfChanged(true);
    this._renderZonesIfChanged(true);
    this._renderTrails();
    this._renderVisits();
    if (this._config.debug) this.requestUpdate();
  }

  _scheduleRefetch() {
    window.clearTimeout(this._refetchTimer);
    this._refetchTimer = window.setTimeout(
      () => this._fetchAll(),
      REFETCH_DEBOUNCE_MS
    );
  }

  async _fetchAll() {
    if (!this.hass?.connection) return;
    await Promise.all([this._fetchVisits(), this._fetchTrails()]);
  }

  async _fetchVisits() {
    if (!this._entities.length) {
      this._log("fetchVisits skipped, no entities");
      return;
    }
    try {
      const horizon = this._config.horizon ?? HORIZON_DEFAULT;
      const since = new Date(Date.now() - horizon * 86400e3).toISOString();
      this._log("fetchVisits entities=", this._entities.join(","), "since=", since);
      const res = await this.hass.connection.sendMessagePromise({
        type: WS_POINTS,
        entities: this._entities,
        since,
      });
      this._rows = res.rows || [];
      this._error = undefined;
      this._log("fetchVisits ->", this._rows.length, "rows");
    } catch (err) {
      this._error = err.message || String(err);
      this._rows = [];
      this._log("fetchVisits ERROR", this._error);
    }
    this._buildLayers();
  }

  _unsubscribeHistory() {
    if (this._historyUnsub) {
      this._historyUnsub();
      this._historyUnsub = undefined;
    }
  }

  _subscribeHistory() {
    this._unsubscribeHistory();
    const hours = this._config.hours_to_show || 0;
    if (
      !hours ||
      !this._entities.length ||
      !this.hass?.config?.components?.includes("history")
    ) {
      return;
    }
    const end = new Date();
    const start = new Date(end.getTime() - hours * 3600e3);
    try {
      this._historyUnsub = this.hass.connection.subscribeMessage(
        (msg) => {
          if (msg.result) {
            this._history = msg.result;
          }
          this._buildPaths();
        },
        {
          type: WS_HISTORY,
          schemaVersion: 1,
          entity_ids: this._entities,
          start_time: start.toISOString(),
          end_time: end.toISOString(),
          include_start_time_state: true,
          significant_changes_only: false,
          minimal_response: false,
        }
      );
    } catch {
      this._historyUnsub = undefined;
    }
  }

  async _fetchTrails() {
    this._subscribeHistory();
  }

  _buildPaths() {
    if (!this._history) {
      this._paths = undefined;
      return;
    }
    const paths = [];
    for (const entityId of Object.keys(this._history)) {
      const states = this._history[entityId];
      if (!states?.length) continue;
      const points = states
        .filter((s) => s.a?.latitude && s.a?.longitude)
        .map((s) => ({
          point: [s.a.latitude, s.a.longitude],
          timestamp: new Date((s.lu || s.lc) * 1000),
        }));
      if (!points.length) continue;
      paths.push({
        points,
        color: this._color(entityId),
        name: this._entityName(entityId),
        gradualOpacity: 0.8,
      });
    }
    this._paths = paths;
  }

  _entityName(entityId) {
    return (
      this.hass?.states?.[entityId]?.attributes?.friendly_name || entityId
    );
  }

  _zoneGeometry() {
    if (this._zones) return this._zones;
    const zones = [];
    for (const entity of Object.values(this.hass?.states || {})) {
      if (!entity.entity_id.startsWith("zone.")) continue;
      const { latitude, longitude, radius } = entity.attributes;
      if (latitude == null || longitude == null) continue;
      zones.push({
        name: this._entityName(entity.entity_id),
        lat: latitude,
        lon: longitude,
        radius: radius || 100,
      });
    }
    this._zones = zones;
    return zones;
  }

  _zoneNameFor(lat, lon) {
    for (const z of this._zoneGeometry()) {
      if (haversineM(lat, lon, z.lat, z.lon) <= z.radius) return z.name;
    }
    return undefined;
  }

  _opacity(row) {
    return decayOpacity(Date.now(), row.last_seen, this._config.decay_rate ?? DECAY_RATE_DEFAULT);
  }

  _withinHorizon(row) {
    return withinHorizon(Date.now(), row.last_seen, this._config.horizon ?? HORIZON_DEFAULT);
  }

  _formatTime(row) {
    const locale = this.hass?.locale?.language || undefined;
    try {
      return new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(row.last_seen));
    } catch {
      return row.last_seen;
    }
  }

  _tooltip(row) {
    const zone = this._zoneNameFor(row.lat, row.lon);
    const parts = [
      escapeHtml(this._entityName(row.device)),
      escapeHtml(`Last seen ${this._formatTime(row)}`),
    ];
    if (zone) parts.push(escapeHtml(`Zone: ${zone}`));
    return parts.join("<br>");
  }

  _hasStationaryBetween(device, a, b) {
    const aTime = Date.parse(a.last_seen);
    const bTime = Date.parse(b.last_seen);
    const minDwellMs = (this._config.max_gap ?? MAX_GAP_DEFAULT) * 60e3;
    return this._rows.some(
      (r) =>
        r.device === device &&
        !r.moving &&
        Date.parse(r.last_seen) > aTime &&
        Date.parse(r.last_seen) < bTime &&
        Date.parse(r.last_seen) - Date.parse(r.first_seen) >= minDwellMs
    );
  }

  _buildLayers() {
    const maxPoints = this._config.max_points ?? MAX_POINTS_DEFAULT;
    let rows = this._rows;
    if (rows.length > maxPoints) {
      const step = Math.ceil(rows.length / maxPoints);
      rows = rows.filter((_, i) => i % step === 0 || i === rows.length - 1);
    }
    if (!rows.length) {
      this._layers = [];
      return;
    }
    try {
      const layers = [];
      const showMoving = this._config.show_moving !== false;
      const excludeZones = Boolean(this._config.exclude_zones);
      const maxGapMs = (this._config.max_gap ?? MAX_GAP_DEFAULT) * 60e3;
      const maxDistM = this._config.max_dist ?? MAX_DIST_DEFAULT;
      const byDevice = {};

      for (const row of rows) {
        if (!this._withinHorizon(row)) continue;
        if (excludeZones && this._zoneNameFor(row.lat, row.lon)) continue;
        (byDevice[row.device] ||= []).push(row);
      }

      for (const device of Object.keys(byDevice)) {
        const pts = byDevice[device].sort(
          (a, b) => Date.parse(a.last_seen) - Date.parse(b.last_seen)
        );
        const color = this._color(device);

        for (const p of pts) {
          if (p.moving) continue;
          const opacity = this._opacity(p);
          const marker = L.circleMarker([p.lat, p.lon], {
            radius: 6,
            color,
            weight: 2,
            fillColor: color,
            fillOpacity: opacity,
            opacity,
          });
          marker.bindTooltip(this._tooltip(p), { direction: "top" });
          layers.push(marker);
        }

        if (!showMoving) continue;

        for (const p of pts) {
          if (!p.moving) continue;
          const opacity = this._opacity(p);
          if (opacity <= 0) continue;
          const marker = L.circleMarker([p.lat, p.lon], {
            radius: 3,
            color,
            weight: 1,
            fillColor: color,
            fillOpacity: opacity * 0.6,
            opacity,
            dashArray: "2 2",
          });
          marker.bindTooltip(this._tooltip(p), { direction: "top" });
          layers.push(marker);
        }

        for (const { a, b } of journeySegments(pts, {
          maxGapMs,
          maxDistM,
          hasStationaryBetween: (x, y) => this._hasStationaryBetween(device, x, y),
          atLeastOneMoving: true,
        })) {
          const segOpacity = Math.max(this._opacity(a), this._opacity(b));
          if (segOpacity <= 0) continue;
          layers.push(
            L.polyline(
              [
                [a.lat, a.lon],
                [b.lat, b.lon],
              ],
              {
                color,
                weight: 2,
                opacity: segOpacity,
                dashArray: "4 6",
                interactive: false,
              }
            )
          );
        }
      }

      this._layers = layers;
      this._log("buildLayers ->", layers.length, "layers from", rows.length, "rows");
    } catch (err) {
      this._layers = [];
      this._log("buildLayers ERROR", err);
      console.error("visit-heatmap: failed to build map layers", err);
    }
  }

  // --- the map itself -------------------------------------------------------

  _createMap() {
    const container = this.renderRoot?.querySelector("#map");
    if (!container) return;

    const map = L.map(container, {
      minZoom: MAP_MIN_ZOOM,
      maxZoom: MAP_MAX_ZOOM,
      preferCanvas: prefersCanvas(),
    });
    map.attributionControl.setPrefix("");
    map.on("zoomstart", () => {
      if (!this._programmaticFit) this._autoFitPaused = true;
    });
    map.on("movestart", () => {
      if (!this._programmaticFit) this._autoFitPaused = true;
    });
    this._map = map;

    const home = [
      this.hass?.config?.latitude ?? HOME_LOCATION_FALLBACK[0],
      this.hass?.config?.longitude ?? HOME_LOCATION_FALLBACK[1],
    ];
    map.setView(home, this._config.default_zoom ?? 14);

    this._setupTiles();

    const root = this.renderRoot?.querySelector("#root");
    if (typeof ResizeObserver !== "undefined") {
      this._resizeObserver = new ResizeObserver(() => {
        this._map?.invalidateSize();
        this._runPendingFit();
      });
      if (root) this._resizeObserver.observe(root);
    }
  }

  async _setupTiles() {
    const token = await this._fetchMapTilesToken();
    if (!this._map || this._tileLayer) return;
    if (token) {
      this._tileLayer = this._createMapTilesLayer(token);
      this._tileSource = "map_tiles";
    } else {
      this._tileLayer = this._createCartoLayer();
      this._tileSource = "carto";
    }
    this._tileLayer.addTo(this._map);
    this._log("base layer:", this._tileSource);
    if (this._config.debug) this.requestUpdate();
  }

  async _fetchMapTilesToken() {
    if (!this.hass?.config?.components?.includes("map_tiles")) return undefined;
    try {
      const res = await this.hass.connection.sendMessagePromise({
        type: WS_MAP_TILES_TOKEN,
      });
      return res?.token || undefined;
    } catch {
      return undefined;
    }
  }

  _createMapTilesLayer(token) {
    const layer = L.tileLayer(MAP_TILES_RASTER_URL, {
      token,
      attribution: OSM_ATTRIBUTION,
      minZoom: MAP_MIN_ZOOM,
      maxZoom: MAP_MAX_ZOOM,
      maxNativeZoom: RASTER_MAX_NATIVE_ZOOM,
    });
    this._tileTokenTimer = window.setInterval(
      () => this._refreshTileToken(layer),
      TOKEN_REFRESH_MS
    );
    layer.on("tileerror", () => {
      const now = Date.now();
      if (now - this._lastTileRecovery < TILE_RECOVERY_THROTTLE_MS) return;
      this._lastTileRecovery = now;
      this._refreshTileToken(layer);
    });
    return layer;
  }

  async _refreshTileToken(layer) {
    const token = await this._fetchMapTilesToken();
    if (!token || !this._map || layer !== this._tileLayer) return;
    if (layer.options.token !== token) {
      layer.options.token = token;
      layer.redraw();
      this._log("map tiles token refreshed");
    }
  }

  _createCartoLayer() {
    return L.tileLayer(CARTO_TILE_URL, {
      attribution: CARTO_ATTRIBUTION,
      subdomains: CARTO_SUBDOMAINS,
      minZoom: MAP_MIN_ZOOM,
      maxZoom: MAP_MAX_ZOOM,
    });
  }

  _applyTheme() {
    const mode =
      this._config.theme_mode || (this._config.dark_mode ? "dark" : "auto");
    const dark =
      mode === "dark" || (mode === "auto" && Boolean(this.hass?.themes?.darkMode));
    this.renderRoot?.querySelector("#map")?.classList.toggle("dark", dark);
  }

  // --- entity markers, zones, trails, visits --------------------------------

  _entityIcon(entity, state, color) {
    const attributes = state.attributes || {};
    const picture = attributes.entity_picture;
    const icon = attributes.icon || DEFAULT_ENTITY_ICON;
    const inner = picture
      ? `<img src="${escapeHtml(picture)}" alt="">`
      : `<ha-icon icon="${escapeHtml(icon)}"></ha-icon>`;
    let label = "";
    if (entity.label_mode === "name") {
      label = `<div class="vh-marker-label">${escapeHtml(this._entityName(entity.entity))}</div>`;
    } else if (entity.label_mode === "state") {
      label = `<div class="vh-marker-label">${escapeHtml(state.state)}</div>`;
    }
    return L.divIcon({
      className: "vh-div-icon",
      html: `<div class="vh-entity-marker" style="--vh-entity-color:${color}">${inner}</div>${label}`,
      iconSize: [40, 40],
      iconAnchor: [20, 20],
    });
  }

  _zoneIcon(state, color) {
    const icon = state.attributes?.icon || DEFAULT_ZONE_ICON;
    return L.divIcon({
      className: "vh-div-icon",
      html: `<div class="vh-zone-marker" style="--vh-entity-color:${color}"><ha-icon icon="${escapeHtml(icon)}"></ha-icon></div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
  }

  _entityTooltip(entityId) {
    const state = this.hass?.states?.[entityId];
    const name = escapeHtml(this._entityName(entityId));
    const stateText = state?.state ? escapeHtml(state.state) : "";
    return stateText ? `${name}<br>${stateText}` : name;
  }

  _entitiesSignature() {
    const parts = [];
    for (const entity of this._configEntities) {
      const state = this.hass?.states?.[entity.entity];
      if (!state) {
        parts.push(`${entity.entity}:missing`);
        continue;
      }
      const attributes = state.attributes || {};
      parts.push(
        [
          entity.entity,
          attributes.latitude ?? "",
          attributes.longitude ?? "",
          state.state,
          attributes.entity_picture || attributes.icon || "",
          entity.color || entity.label_mode || "",
        ].join(",")
      );
    }
    return parts.join("|");
  }

  _renderEntitiesIfChanged(force = false) {
    const sig = this._entitiesSignature();
    if (!force && sig === this._entitiesSig) return;
    this._entitiesSig = sig;
    this._renderEntities();
  }

  _renderEntities() {
    if (!this._map) return;
    if (this._entitiesGroup) {
      this._map.removeLayer(this._entitiesGroup);
      this._entitiesGroup = undefined;
    }

    const cluster = this._config.cluster !== false;
    const group = cluster
      ? L.markerClusterGroup({
          showCoverageOnHover: false,
          maxClusterRadius: 40,
          iconCreateFunction: (c) => this._clusterIcon(c),
        })
      : L.layerGroup();

    for (const entity of this._configEntities) {
      const state = this.hass?.states?.[entity.entity];
      const attributes = state?.attributes || {};
      if (
        !state ||
        attributes.latitude == null ||
        attributes.longitude == null
      ) {
        continue;
      }
      const color = entity.color || this._color(entity.entity);
      const marker = L.marker([attributes.latitude, attributes.longitude], {
        icon: this._entityIcon(entity, state, color),
        title: this._entityName(entity.entity),
      });
      marker.bindTooltip(this._entityTooltip(entity.entity), {
        direction: "top",
      });
      marker.on("click", () =>
        fireEvent(this, "hass-more-info", { entityId: entity.entity })
      );
      group.addLayer(marker);
    }

    group.addTo(this._map);
    this._entitiesGroup = group;
    this._maybeAutoFit();
  }

  _clusterIcon(cluster) {
    const count = cluster.getChildCount();
    const size = count < 10 ? 36 : count < 100 ? 42 : 48;
    return L.divIcon({
      className: "vh-div-icon",
      html: `<div class="vh-cluster">${count}</div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
  }

  _zonesSignature() {
    return this._zoneEntities()
      .map((zone) => {
        const state = this.hass?.states?.[zone.entity_id];
        const attributes = state?.attributes || {};
        return `${zone.entity_id},${attributes.latitude ?? ""},${attributes.longitude ?? ""},${attributes.radius ?? ""},${attributes.icon || ""}`;
      })
      .join("|");
  }

  _renderZonesIfChanged(force = false) {
    const sig = this._zonesSignature();
    if (!force && sig === this._zonesSig) return;
    this._zonesSig = sig;
    this._renderZones();
  }

  _renderZones() {
    if (!this._map) return;
    if (this._zonesGroup) {
      this._map.removeLayer(this._zonesGroup);
      this._zonesGroup = undefined;
    }

    const group = L.layerGroup();
    for (const zone of this._zoneEntities()) {
      const state = this.hass?.states?.[zone.entity_id];
      const attributes = state?.attributes || {};
      if (
        !state ||
        attributes.latitude == null ||
        attributes.longitude == null
      ) {
        continue;
      }
      const color = zone.color;
      if (attributes.radius) {
        group.addLayer(
          L.circle([attributes.latitude, attributes.longitude], {
            radius: attributes.radius,
            color,
            weight: 1.5,
            fillColor: color,
            fillOpacity: 0.1,
            interactive: false,
          })
        );
      }
      const marker = L.marker([attributes.latitude, attributes.longitude], {
        icon: this._zoneIcon(state, color),
        title: this._entityName(zone.entity_id),
      });
      marker.bindTooltip(this._entityName(zone.entity_id), {
        direction: "top",
      });
      marker.on("click", () =>
        fireEvent(this, "hass-more-info", { entityId: zone.entity_id })
      );
      group.addLayer(marker);
    }

    group.addTo(this._map);
    this._zonesGroup = group;
  }

  _renderTrails() {
    if (!this._map) return;
    if (this._trailsGroup) {
      this._map.removeLayer(this._trailsGroup);
      this._trailsGroup = undefined;
    }

    const group = L.layerGroup();
    for (const path of this._paths || []) {
      const count = path.points.length;
      for (let index = 0; index < count; index++) {
        const point = path.points[index];
        const opacity = gradientOpacity(index, count, path.gradualOpacity);
        const marker = L.circleMarker(point.point, {
          radius: 3,
          color: path.color,
          opacity,
          fillColor: path.color,
          fillOpacity: opacity,
        });
        marker.bindTooltip(this._trailTooltip(path, point), {
          direction: "top",
        });
        group.addLayer(marker);
        if (index < count - 1) {
          group.addLayer(
            L.polyline([point.point, path.points[index + 1].point], {
              color: path.color,
              opacity,
              interactive: false,
            })
          );
        }
      }
    }

    group.addTo(this._map);
    this._trailsGroup = group;
  }

  _trailTooltip(path, point) {
    const time = this._formatTime({
      last_seen: new Date(point.timestamp).toISOString(),
    });
    return `${escapeHtml(path.name ?? "")}<br>${escapeHtml(time)}`;
  }

  _renderVisits() {
    if (!this._map) return;
    if (this._visitsGroup) {
      this._map.removeLayer(this._visitsGroup);
    }
    this._visitsGroup = L.layerGroup(this._layers || []).addTo(this._map);
    this._maybeAutoFit();
  }

  // --- view: zoom, center, auto-fit ----------------------------------------

  _maybeAutoFit(force = false) {
    if (!this._map || !this._config.auto_fit) return;
    if (this._autoFitPaused && !force) return;
    this._fitToData();
  }

  _fitToData() {
    if (!this._map) return;
    if (this._deferIfUnsized(() => this._fitToData())) return;

    const bounds = L.latLngBounds([]);

    for (const entity of this._configEntities) {
      const attributes = this.hass?.states?.[entity.entity]?.attributes || {};
      if (attributes.latitude != null && attributes.longitude != null) {
        bounds.extend([attributes.latitude, attributes.longitude]);
      }
    }

    for (const layer of this._layers || []) {
      if (typeof layer.getLatLng === "function") {
        bounds.extend(layer.getLatLng());
      } else if (typeof layer.getBounds === "function") {
        bounds.extend(layer.getBounds());
      }
    }

    if (this._config.fit_zones) {
      for (const zone of this._zoneGeometry()) {
        bounds.extend(L.latLng(zone.lat, zone.lon).toBounds(zone.radius));
      }
    }

    const zoom = this._config.default_zoom ?? 14;
    if (!bounds.isValid()) {
      this._setHomeView(zoom);
      return;
    }

    this._programmaticFit = true;
    this._map.fitBounds(bounds.pad(0.5), { maxZoom: zoom });
    window.setTimeout(() => {
      this._programmaticFit = false;
    }, PROGRAMMATIC_FIT_DELAY);
  }

  _setHomeView(zoom) {
    const home = [
      this.hass?.config?.latitude ?? HOME_LOCATION_FALLBACK[0],
      this.hass?.config?.longitude ?? HOME_LOCATION_FALLBACK[1],
    ];
    this._programmaticFit = true;
    this._map.setView(home, zoom);
    window.setTimeout(() => {
      this._programmaticFit = false;
    }, PROGRAMMATIC_FIT_DELAY);
  }

  // Leaflet derives the zoom that fits bounds from the container's size; a
  // container that is still 0x0 (e.g. a hidden dashboard tab) collapses the
  // fit to the world zoom, so defer until the resize observer reports a size.
  _deferIfUnsized(fit) {
    const size = this._map.getSize();
    if (size.x > 0 && size.y > 0) {
      this._pendingFit = undefined;
      return false;
    }
    const container = this._map.getContainer();
    if (container.clientWidth > 0 && container.clientHeight > 0) {
      this._map.invalidateSize();
      this._pendingFit = undefined;
      return false;
    }
    this._pendingFit = fit;
    return true;
  }

  _runPendingFit() {
    if (!this._pendingFit || !this._map) return;
    const size = this._map.getSize();
    if (size.x > 0 && size.y > 0) {
      const pending = this._pendingFit;
      this._pendingFit = undefined;
      pending();
    }
  }

  // --- rendering ------------------------------------------------------------

  render() {
    if (this._error) {
      return html`<ha-card><ha-alert alert-type="error"
          >Visit heatmap: ${this._error}</ha-alert
        >${this._config.debug ? this._renderDebug() : nothing}</ha-card>`;
    }
    const config = this._config;
    const maxWidth = config.max_width ? `${Number(config.max_width)}px` : "none";
    const aspect = config.aspect ?? parseAspectRatio(config.aspect_ratio);
    return html`
      <ha-card
        id="card"
        .header=${config.title}
        style=${maxWidth !== "none"
          ? `max-width:${maxWidth};margin:0 auto;`
          : nothing}
      >
        <div
          id="root"
          style=${aspect ? `--visit-heatmap-aspect:${aspect} / 1;` : nothing}
        >
          <div id="map"></div>
          ${config.debug ? this._renderDebug() : nothing}
        </div>
      </ha-card>
    `;
  }

  _renderDebug() {
    const rows = this._rows.length;
    const layers = (this._layers || []).length;
    const paths = (this._paths || []).length;
    return html`
      <ha-alert
        alert-type="info"
        style="position:absolute;top:8px;left:8px;right:8px;z-index:1000;font-size:11px;line-height:1.5"
        @click=${() => this._fetchDebug()}
      >
        <b>visit-heatmap debug</b><br />
        config entities: ${this._entities.join(", ") || "none"}<br />
        rows: ${rows} · layers: ${layers} · paths: ${paths}<br />
        map: ${this._map ? "mounted" : "not mounted"} ·
        tiles: ${this._tileSource || "pending"}<br />
        hass: ${this.hass ? "yes" : "no"} · connection: ${this.hass?.connection ? "yes" : "no"}<br />
        ${this._backendDebug ? `backend: ${this._backendDebug}` : ""}
        <details>
          <summary>console log (click to fetch backend)</summary>
          <pre style="max-height:200px;overflow:auto">${this._debugLines.join("\n") || "empty"}</pre>
        </details>
      </ha-alert>
    `;
  }

  async _fetchDebug() {
    if (!this.hass?.connection) return;
    try {
      const res = await this.hass.connection.sendMessagePromise({
        type: WS_DEBUG,
        entities: this._entities,
      });
      this._backendDebug = JSON.stringify(res.result || res);
      this._log("debug backend:", this._backendDebug);
    } catch (err) {
      this._backendDebug = `ERROR: ${err.message || err}`;
      this._log("debug fetch ERROR", err);
    }
  }

  getCardSize() {
    return 7;
  }

  getGridOptions() {
    return {
      columns: "full",
      rows: 8,
      min_columns: 6,
      min_rows: 2,
    };
  }

  static async getConfigElement() {
    return document.createElement("visit-heatmap-card-editor");
  }

  static getStubConfig() {
    return { show_all: true };
  }

  static styles = css`
    ${unsafeCSS(leafletCss)}
    ${unsafeCSS(markerClusterCss)}
    :host {
      display: block;
      width: 100%;
      height: 100%;
    }
    ha-card {
      overflow: hidden;
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
    }
    #root {
      position: relative;
      height: 100%;
      aspect-ratio: var(--visit-heatmap-aspect, 1 / 1);
    }
    #map {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      z-index: 0;
      border: none;
      border-radius: var(--ha-card-border-radius, var(--ha-border-radius-lg));
      overflow: hidden;
      background: var(--card-background-color, #fff);
    }
    /* Raster tiles have no dark cartography; the stock map inverts them in CSS. */
    #map.dark .leaflet-tile-pane .leaflet-tile {
      filter: invert(0.9) hue-rotate(170deg) brightness(1.5) contrast(1.2)
        saturate(0.3);
    }
    .leaflet-container {
      font-family: inherit;
      background: var(--card-background-color, #fff);
    }
    .vh-div-icon {
      background: none;
      border: none;
    }
    .vh-entity-marker,
    .vh-zone-marker {
      display: flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      border-radius: 50%;
      overflow: hidden;
      background: var(--card-background-color, #fff);
      border: 2px solid var(--vh-entity-color, var(--primary-color));
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
    }
    .vh-entity-marker img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .vh-entity-marker ha-icon,
    .vh-zone-marker ha-icon {
      --mdc-icon-size: 22px;
      color: var(--vh-entity-color, var(--primary-color));
    }
    .vh-zone-marker {
      border-width: 1.5px;
      border-style: dashed;
    }
    .vh-marker-label {
      margin-top: 2px;
      padding: 1px 6px;
      border-radius: 10px;
      font-size: var(--ha-font-size-xs, 11px);
      text-align: center;
      white-space: nowrap;
      color: var(--primary-text-color);
      background: var(--card-background-color, #fff);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
    }
    .vh-cluster {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
      border-radius: 50%;
      border: 3px solid rgba(255, 255, 255, 0.7);
      box-sizing: border-box;
      color: #fff;
      font-weight: 500;
      background: var(--primary-color, #03a9f4);
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
    }
  `;
}

if (!customElements.get("visit-heatmap-card")) {
  customElements.define("visit-heatmap-card", VisitHeatmapCard);
}

class VisitHeatmapCardEditor extends LitElement {
  static properties = {
    hass: { attribute: false },
    _config: {},
    _entities: { state: true },
  };

  constructor() {
    super();
    this._config = {};
  }

  setConfig(config) {
    this._config = config || {};
    this._entities = (this._config.entities || [])
      .map((e) => (typeof e === "string" ? e : e.entity))
      .join(", ");
  }

  _set(field, value) {
    fireEvent(this, "config-changed", {
      config: { ...this._config, [field]: value },
    });
  }

  _onEntities(ev) {
    const raw = ev.target.value;
    const entities = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((entity) => ({ entity }));
    this._set("entities", entities);
  }

  _onNumber(field) {
    return (ev) => {
      const value = parseFloat(ev.target.value);
      if (Number.isFinite(value)) this._set(field, value);
    };
  }

  _onOptionalNumber(field) {
    return (ev) => {
      const value = parseFloat(ev.target.value);
      if (ev.target.value.trim() === "") {
        this._set(field, undefined);
      } else if (Number.isFinite(value)) {
        this._set(field, value);
      }
    };
  }

  _onToggle(field) {
    return (ev) => this._set(field, ev.target.checked);
  }

  render() {
    const c = this._config;
    const text = (label, value, onChange) =>
      html`<ha-textfield
        label=${label}
        .value=${String(value ?? "")}
        @change=${onChange}
        type="number"
      ></ha-textfield>`;
    return html`
      <div class="editor" style="display:grid;gap:12px;padding:12px">
        <ha-textfield
          label="Entities (comma separated)"
          .value=${this._entities || ""}
          helper="device_tracker entities to show"
          @change=${this._onEntities}
          style="width:100%"
        ></ha-textfield>
        ${text("Decay rate (%/day)", (c.decay_rate ?? 0.1) * 100, (ev) => {
          const v = parseFloat(ev.target.value);
          if (Number.isFinite(v)) this._set("decay_rate", v / 100);
        })}
        ${text("Horizon (days)", c.horizon ?? 30, this._onNumber("horizon"))}
        ${text("Max gap (min)", c.max_gap ?? 30, this._onNumber("max_gap"))}
        ${text("Max dist (m)", c.max_dist ?? 1000, this._onNumber("max_dist"))}
        ${text("Max points (cap)", c.max_points ?? MAX_POINTS_DEFAULT, this._onNumber("max_points"))}
        ${text("Max width (px)", c.max_width ?? "", this._onOptionalNumber("max_width"))}
        ${text("Aspect (width/height)", c.aspect ?? 1, this._onOptionalNumber("aspect"))}
        <div>
          <ha-switch ?checked=${c.show_moving !== false} @change=${this._onToggle("show_moving")}></ha-switch>
          <span>Show moving points and journey lines</span>
        </div>
        <div>
          <ha-switch ?checked=${Boolean(c.show_all)} @change=${this._onToggle("show_all")}></ha-switch>
          <span>Show all GPS device_tracker entities</span>
        </div>
        <div>
          <ha-switch ?checked=${Boolean(c.exclude_zones)} @change=${this._onToggle("exclude_zones")}></ha-switch>
          <span>Exclude points inside zones</span>
        </div>
        <div>
          <ha-switch ?checked=${Boolean(c.debug)} @change=${this._onToggle("debug")}></ha-switch>
          <span>Debug overlay (console + diagnostics)</span>
        </div>
      </div>
    `;
  }
}

if (!customElements.get("visit-heatmap-card-editor")) {
  customElements.define("visit-heatmap-card-editor", VisitHeatmapCardEditor);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "visit-heatmap-card")) {
  window.customCards.push({
    type: "visit-heatmap-card",
    name: "Visit Heatmap",
    description:
      "Map card with a fading layer of every place a device has visited.",
  });
}