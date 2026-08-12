import { LitElement, html, css, nothing } from "lit";
import {
  haversineM,
  decayOpacity,
  withinHorizon,
  parseEntities,
  journeySegments,
} from "./logic.mjs";

const DECAY_RATE_DEFAULT = 0.1;
const HORIZON_DEFAULT = 30;
const MAX_GAP_DEFAULT = 30;
const MAX_DIST_DEFAULT = 1000;
const MAX_POINTS_DEFAULT = 5000;
const REFRESH_PERIOD_MS = 300000;
const REFETCH_DEBOUNCE_MS = 1500;

const COLOR_PALETTE = [
  "#1976d2", "#d32f2f", "#fbc02d", "#388e3c", "#8e24aa", "#00796b",
  "#5d4037", "#e64a19", "#303f9f", "#c2185b", "#0097a7", "#7b1fa2",
];

const WS_POINTS = "visit_heatmap/points";
const WS_DEBUG = "visit_heatmap/debug";
const WS_HISTORY = "history/stream";

function fireEvent(node, type, detail) {
  node.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}

function formatTs(ms) {
  const d = new Date(ms);
  return `${d.toLocaleTimeString()}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(`Timed out after ${ms}ms waiting for ${label}`)),
      ms,
    );
    Promise.resolve(promise).then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
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
    this._mapEntities = [];
    this._colors = new Map();
    this._layers = [];
    this._paths = undefined;
    this._rows = [];
    this._history = undefined;
    this._historyUnsub = undefined;
    this._timer = undefined;
    this._stateSig = "";
    this._refetchTimer = undefined;
    this._mapL = undefined;
    this._zones = undefined;
    this._buildSeq = 0;
    this._debugLines = [];
    this._debug = { mapElements: {}, leafletState: "unknown" };
    this._backendDebug = "";
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
    this._updateMapEntities();
    this._scheduleRefetch();
    this._log("setConfig", JSON.stringify({ ...config, entities: this._entities }));
  }

  _parseEntities(config) {
    return parseEntities(config, this.hass?.states || {}, this.hass?.entities || {});
  }

  _updateMapEntities() {
    const mapEntities = [];
    for (const e of this._configEntities) {
      mapEntities.push({
        entity_id: e.entity,
        color: e.color || this._color(e.entity),
        label_mode: e.label_mode,
      });
    }
    const zones = this._zoneEntities();
    this._mapEntities = [...mapEntities, ...zones];
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
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._log("disconnected");
    window.clearInterval(this._timer);
    window.clearTimeout(this._refetchTimer);
    window.clearTimeout(this._verifyTimer);
    document.removeEventListener("visibilitychange", this._onVisibility);
    this._unsubscribeHistory();
  }

  _onVisibility = () => {
    if (!document.hidden) this._scheduleRefetch();
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
      this._updateMapEntities();
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
    const parts = [this._entityName(row.device), `Last seen ${this._formatTime(row)}`];
    if (zone) parts.push(`Zone: ${zone}`);
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

  async _buildLayers() {
    const seq = ++this._buildSeq;
    const maxPoints = this._config.max_points ?? MAX_POINTS_DEFAULT;
    let rows = this._rows;
    if (rows.length > maxPoints) {
      const step = Math.ceil(rows.length / maxPoints);
      rows = rows.filter((_, i) => i % step === 0 || i === rows.length - 1);
    }
    if (!rows.length) {
      this._layers = [];
      this._verifyLayersInjected();
      return;
    }
    const L = await this._resolveMapLeaflet();
    if (!L || seq !== this._buildSeq) {
      this._log(
        "buildLayers aborted: L=",
        !!L,
        "stale=",
        seq !== this._buildSeq,
        "ha-map defined=",
        !!customElements.get("ha-map"),
      );
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

      if (seq !== this._buildSeq) return;
      this._layers = layers;
      this._log("buildLayers ->", layers.length, "layers from", rows.length, "rows");
      this._verifyLayersInjected();
    } catch (err) {
      this._layers = [];
      this._log("buildLayers ERROR", err);
      console.error("visit-heatmap: failed to build map layers", err);
    }
  }

  async _resolveMapLeaflet() {
    if (this._mapL) return this._mapL;
    const haMap = () => this.renderRoot?.querySelector("ha-map");
    const haMapDefined = () => !!customElements.get("ha-map");

    // HA only registers the ha-map element when something lazy-loads and
    // instantiates it (ha-panel-config's "general" route, or a Map card).
    if (haMap()?.Leaflet) {
      this._mapL = haMap().Leaflet;
      this._debug.leafletState = "resolved-from-ha-map";
      this._log(
        "leaflet resolved from ha-map",
        haMapDefined() ? "(defined)" : "(NOT a registered element)",
      );
      return this._mapL;
    }

    this._debug.leafletState = haMapDefined() ? "waiting-for-leaflet" : "ha-map-not-loaded";
    this._log(
      "leaflet unresolved: ha-map defined=",
      haMapDefined(),
      "element in shadow=",
      !!haMap(),
      "has Leaflet=",
      !!haMap()?.Leaflet,
    );

    if (!haMapDefined()) {
      await this._ensureHaMapLoaded();
    }

    return this._waitForLeaflet();
  }

  // Strategy ported from KipK/load-ha-components (MIT): HA lazy-imports
  // ha-map via the config panel's "general" route, not its own chunk.
  // https://github.com/KipK/load-ha-components
  async _loadHaMap() {
    const step = (p, label, ms = 15000) => withTimeout(p, ms, label);
    await step(customElements.whenDefined("partial-panel-resolver"), "partial-panel-resolver");

    const resolver = document.createElement("partial-panel-resolver");
    const panels = { tmp: { url_path: "tmp", component_name: "config" } };
    let routerOptions;
    if (typeof resolver._getRoutes === "function") {
      routerOptions = resolver._getRoutes(panels);
    } else if (typeof resolver._updateRoutes === "function") {
      resolver.hass = { panels };
      const result = resolver._updateRoutes();
      if (result && typeof result.then === "function") {
        void Promise.resolve(result).catch(() => undefined);
      }
      routerOptions = resolver.routerOptions;
    } else {
      throw new Error(
        "partial-panel-resolver exposes neither _getRoutes() nor _updateRoutes()",
      );
    }
    const route = routerOptions?.routes?.tmp;
    if (typeof route?.load !== "function") {
      throw new Error("partial-panel-resolver has no load() for the config panel");
    }
    await step(route.load.call(route), "config panel");

    await step(customElements.whenDefined("ha-panel-config"), "ha-panel-config");
    const configPanel = document.createElement("ha-panel-config");
    const general = configPanel.routerOptions?.routes?.general;
    if (typeof general?.load !== "function") {
      throw new Error("ha-panel-config has no load() for the general route");
    }
    await step(general.load.call(general), "config/general route");

    if (!customElements.get("ha-map")) {
      throw new Error("ha-map still undefined after loading config/general");
    }
    this._log("ha-map loaded on demand through config/general");
  }

  _ensureHaMapLoaded() {
    if (this._loadHaMapPromise) return this._loadHaMapPromise;
    this._loadHaMapPromise = this._loadHaMap().catch((err) => {
      this._debug.leafletState = "load-failed";
      this._log("on-demand ha-map load FAILED:", err?.message || err);
      console.error("visit-heatmap: failed to load ha-map on demand", err);
    });
    return this._loadHaMapPromise;
  }

  _waitForLeaflet() {
    if (this._mapL) return Promise.resolve(this._mapL);
    return new Promise((resolve) => {
      let tries = 0;
      const iv = window.setInterval(() => {
        if (!this.isConnected) {
          window.clearInterval(iv);
          resolve(undefined);
          return;
        }
        tries++;
        const el = this.renderRoot?.querySelector("ha-map");
        if (el?.Leaflet) {
          window.clearInterval(iv);
          this._mapL = el.Leaflet;
          this._debug.leafletState = "resolved-after-wait";
          this._log("leaflet resolved after", tries, "polls");
          resolve(this._mapL);
        } else if (tries >= 50) {
          window.clearInterval(iv);
          this._debug.leafletState = "timeout";
          this._log(
            "leaflet TIMEOUT after 10s: ha-map never exposed Leaflet, even after an on-demand load attempt.",
          );
          resolve(undefined);
        }
      }, 200);
    });
  }

  _verifyLayersInjected() {
    if (this._verifyTimer) return;
    this._verifyTimer = window.setTimeout(() => {
      this._verifyTimer = undefined;
      const map = this.renderRoot?.querySelector("ha-map")?.leafletMap;
      if (!map || !this._layers) return;
      for (const layer of this._layers) {
        if (!map.hasLayer(layer)) {
          console.warn("visit-heatmap: layer was not injected into ha-map", layer);
        }
      }
    }, 500);
  }

  render() {
    if (this._error) {
      return html`<ha-card><ha-alert alert-type="error"
          >Visit heatmap: ${this._error}</ha-alert
        >${this._config.debug ? this._renderDebug() : nothing}</ha-card>`;
    }
    const config = this._config;
    const maxWidth = config.max_width ? `${Number(config.max_width)}px` : "none";
    return html`
      <ha-card
        id="card"
        .header=${config.title}
        style=${maxWidth !== "none"
          ? `max-width:${maxWidth};margin:0 auto;`
          : nothing}
      >
        <div id="root" style=${config.aspect ? `--visit-heatmap-aspect:${config.aspect} / 1;` : nothing}>
          <ha-map
            .entities=${this._mapEntities}
            .layers=${this._layers || []}
            .paths=${this._paths || []}
            .zoom=${config.default_zoom ?? 14}
            .autoFit=${Boolean(config.auto_fit)}
            .fitZones=${Boolean(config.fit_zones)}
            .themeMode=${config.theme_mode || (config.dark_mode ? "dark" : "auto")}
            .clusterMarkers=${config.cluster !== false}
            interactive-zones
            render-passive
          ></ha-map>
          ${config.debug ? this._renderDebug() : nothing}
        </div>
      </ha-card>
    `;
  }

  _renderDebug() {
    const rows = this._rows.length;
    const layers = (this._layers || []).length;
    const paths = (this._paths || []).length;
    const haMapDefined = !!customElements.get("ha-map");
    return html`
      <ha-alert
        alert-type="info"
        style="position:absolute;top:8px;left:8px;right:8px;z-index:1000;font-size:11px;line-height:1.5"
        @click=${() => this._fetchDebug()}
      >
        <b>visit-heatmap debug</b><br />
        config entities: ${this._entities.join(", ") || "none"}<br />
        rows: ${rows} · layers: ${layers} · paths: ${paths}<br />
        ha-map element: ${haMapDefined ? "defined" : "NOT loaded yet (auto-loading on demand)"} ·
        leaflet: ${this._debug.leafletState}<br />
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
    ha-map {
      z-index: 0;
      border: none;
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      border-radius: var(--ha-card-border-radius, var(--ha-border-radius-lg));
      overflow: hidden;
    }
    #root {
      position: relative;
      height: 100%;
      aspect-ratio: var(--visit-heatmap-aspect, 1 / 1);
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
