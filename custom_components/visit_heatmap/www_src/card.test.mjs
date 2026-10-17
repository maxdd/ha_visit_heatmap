import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const BUNDLE = readFileSync(
  fileURLToPath(new URL("../www/visit-heatmap-card.js", import.meta.url)),
  "utf8"
);

// jsdom ships no 2d context; Leaflet's canvas renderer only needs a no-op one.
function stubCanvas(dom) {
  const noopContext = new Proxy(
    { canvas: {} },
    {
      get: (target, prop) => (prop in target ? target[prop] : () => undefined),
      set: () => true,
    }
  );
  dom.window.HTMLCanvasElement.prototype.getContext = function () {
    return noopContext;
  };
}

function makeDom() {
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  stubCanvas(dom);
  // MapLibre's module scope touches these; jsdom does not provide them.
  dom.window.TextDecoder ??= TextDecoder;
  dom.window.TextEncoder ??= TextEncoder;
  dom.window.eval(BUNDLE);
  return dom;
}

function makeCard(hassOverrides = {}) {
  const dom = makeDom();
  const el = dom.window.document.createElement("visit-heatmap-card");
  el.hass = {
    states: {
      "device_tracker.phone": {
        entity_id: "device_tracker.phone",
        state: "home",
        attributes: { latitude: 52.36, longitude: 4.9, friendly_name: "Phone" },
      },
      "device_tracker.hidden": {
        entity_id: "device_tracker.hidden",
        state: "not_home",
        attributes: { latitude: 52.1, longitude: 4.1 },
      },
      "device_tracker.no_gps": {
        entity_id: "device_tracker.no_gps",
        state: "unknown",
        attributes: {},
      },
      "person.alice": {
        entity_id: "person.alice",
        state: "home",
        attributes: { latitude: 1, longitude: 1 },
      },
      "zone.home": {
        entity_id: "zone.home",
        state: "zoning",
        attributes: { latitude: 52.3676, longitude: 4.9041, radius: 100 },
      },
    },
    entities: { "device_tracker.hidden": { hidden: true } },
    connection: null,
    locale: { language: "en" },
    config: { latitude: 52.37, longitude: 4.89, components: [] },
    themes: { darkMode: false },
    ...hassOverrides,
  };
  return { dom, el };
}

async function mount(dom, el, config) {
  el.setConfig(config);
  dom.window.document.body.appendChild(el);
  await el.updateComplete;
  // Let the async tile-layer setup settle.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

const DAY = 86400e3;
const iso = (ms) => new Date(ms).toISOString();

test("card registers in the custom card picker", () => {
  const { dom } = makeCard();
  assert.equal(dom.window.customCards.length, 1);
  assert.equal(dom.window.customCards[0].type, "visit-heatmap-card");
});

test("show_all resolves GPS device_trackers only", () => {
  const { el } = makeCard();
  el.setConfig({ show_all: true });
  assert.equal(el._configEntities.map((e) => e.entity).join(","), "device_tracker.phone");
});

test("_buildLayers paints stationary, moving dots, and a journey line", async () => {
  const { el } = makeCard();
  const now = Date.now();
  el._rows = [
    { device: "device_tracker.phone", lat: 52.3676, lon: 4.9041, last_seen: iso(now), moving: false },
    { device: "device_tracker.phone", lat: 52.3526, lon: 4.8879, last_seen: iso(now - 7 * DAY + 5 * 60e3), moving: true },
    { device: "device_tracker.phone", lat: 52.3376, lon: 4.8716, last_seen: iso(now - 7 * DAY), moving: true },
    { device: "device_tracker.phone", lat: 52.36, lon: 4.9, last_seen: iso(now - 40 * DAY), moving: false },
  ];
  await el._buildLayers();
  const dash = (l) => (l.options.dashArray || "").split(" ")[0];
  const stationary = el._layers.filter((l) => !l.options.dashArray);
  const moving = el._layers.filter((l) => dash(l) === "2");
  const journeys = el._layers.filter((l) => dash(l) === "4");
  assert.equal(el._layers.length, 4);
  assert.equal(stationary.length, 1);
  assert.ok(Math.abs(stationary[0].options.opacity - 1) < 1e-6);
  assert.equal(moving.length, 2);
  assert.equal(journeys.length, 1);
  assert.ok(Math.abs(journeys[0].options.opacity - 0.9 ** 7) < 1e-3);
});

test("opacity and horizon follow the decay model", () => {
  const { el } = makeCard();
  const now = Date.now();
  const rows = {
    today: { last_seen: iso(now) },
    d7: { last_seen: iso(now - 7 * DAY) },
    d40: { last_seen: iso(now - 40 * DAY) },
  };
  assert.ok(Math.abs(el._opacity(rows.today) - 1) < 1e-6);
  assert.ok(Math.abs(el._opacity(rows.d7) - 0.4782969) < 1e-6);
  assert.equal(el._withinHorizon(rows.today), true);
  assert.equal(el._withinHorizon(rows.d40), false);
});

test("debug config renders an overlay and logs to console", async (t) => {
  const { dom, el } = makeCard();
  t.after(() => {
    el.remove();
    dom.window.close();
  });
  dom.window.document.body.appendChild(el);
  el.setConfig({ show_all: true, debug: true });
  const now = Date.now();
  el._rows = [
    { device: "device_tracker.phone", lat: 52.3676, lon: 4.9041, last_seen: iso(now), moving: false },
  ];
  await el._buildLayers();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(el._debugLines.length > 0, "debug lines captured");
  const overlay = el.shadowRoot.querySelector("ha-alert");
  assert.ok(overlay, "debug overlay rendered");
  assert.match(el.shadowRoot.textContent, /map: mounted/);
});

test("_buildLayers downsamples rows beyond max_points", async () => {
  const { el } = makeCard();
  const now = Date.now();
  el._config.max_points = 100;
  el._rows = Array.from({ length: 1000 }, (_, i) => ({
    device: "device_tracker.phone",
    lat: 52.35 + i / 100000,
    lon: 4.9,
    last_seen: iso(now - i * 60e3),
    moving: false,
  }));
  await el._buildLayers();
  // step = ceil(1000/100) = 10 -> 100 rows + the always-kept latest row.
  assert.equal(el._layers.length, 101);
  const seen = new Set(el._rows.map((r) => r.last_seen));
  assert.ok(seen.has(iso(now)));
});

test("_hasStationaryBetween only splits journeys on stops that outlast max_gap", () => {
  const { el } = makeCard();
  const now = Date.now();
  const a = { device: "device_tracker.phone", lat: 52.35, lon: 4.88, last_seen: iso(now - 30 * 60e3) };
  const b = { device: "device_tracker.phone", lat: 52.36, lon: 4.9, last_seen: iso(now) };
  el._rows = [
    a,
    { device: "device_tracker.phone", lat: 52.35, lon: 4.89, first_seen: iso(now - 25 * 60e3), last_seen: iso(now - 10 * 60e3), moving: false },
    b,
  ];
  // 15-minute coffee stop: shorter than max_gap (30 min) -> journey stays connected.
  assert.equal(el._hasStationaryBetween("device_tracker.phone", a, b), false);
  // Same stop stretched past max_gap -> a real break.
  el._rows[1].last_seen = iso(now - 60e3);
  el._rows[1].first_seen = iso(now - 40 * 60e3);
  assert.equal(el._hasStationaryBetween("device_tracker.phone", a, b), true);
});

test("_buildPaths derives trail paths from history states", () => {
  const { el } = makeCard();
  const now = Date.now();
  el._history = {
    "device_tracker.phone": [{ a: { latitude: 52.36, longitude: 4.9 }, lu: now / 1000 }],
  };
  el._buildPaths();
  assert.equal(el._paths.length, 1);
  assert.equal(el._paths[0].points.length, 1);
});

test("_zoneNameFor matches zone geometry", () => {
  const { el } = makeCard();
  assert.equal(el._zoneNameFor(52.3676, 4.9041), "zone.home");
  assert.equal(el._zoneNameFor(52.3526, 4.8879), undefined);
});

// --- the self-contained map (HA 2026.9 removed ha-map's layers API) ---------

test("card mounts its own Leaflet map with entity and zone layers", async (t) => {
  const { dom, el } = makeCard();
  t.after(() => dom.window.close());
  await mount(dom, el, {
    entities: ["device_tracker.phone"],
    zones: ["zone.home"],
    auto_fit: true,
  });
  assert.ok(el._map, "Leaflet map created");
  assert.ok(el.renderRoot.querySelector("#map"), "map container rendered");
  assert.equal(el._entitiesGroup.getLayers().length, 1, "entity marker");
  assert.equal(el._zonesGroup.getLayers().length, 2, "zone circle + marker");
  assert.equal(el._visitsGroup.getLayers().length, 0, "no visits yet");
  el.remove();
  assert.equal(el._map, undefined, "map destroyed on disconnect");
});

test("visit layers land on the card's own map and survive map moves", async (t) => {
  const { dom, el } = makeCard();
  t.after(() => {
    el.remove();
    dom.window.close();
  });
  await mount(dom, el, { entities: ["device_tracker.phone"] });
  const now = Date.now();
  el._rows = [
    { device: "device_tracker.phone", lat: 52.3676, lon: 4.9041, last_seen: iso(now), moving: false },
    { device: "device_tracker.phone", lat: 52.3526, lon: 4.8879, last_seen: iso(now - 7 * DAY + 5 * 60e3), moving: true },
    { device: "device_tracker.phone", lat: 52.3376, lon: 4.8716, last_seen: iso(now - 7 * DAY), moving: true },
  ];
  el._buildLayers();
  await el.updateComplete;
  assert.equal(el._visitsGroup.getLayers().length, el._layers.length);
  assert.ok(el._visitsGroup.getLayers().length >= 2);
  el._map.setView([52.36, 4.9], 13);
  assert.ok(true, "map move did not throw");
});

test("card renders the fading visit layer with decay opacity", async (t) => {
  const { dom, el } = makeCard();
  t.after(() => {
    el.remove();
    dom.window.close();
  });
  await mount(dom, el, { entities: ["device_tracker.phone"] });
  const now = Date.now();
  el._rows = [
    {
      device: "device_tracker.phone",
      lat: 52.36,
      lon: 4.9,
      last_seen: iso(now),
      moving: false,
    },
  ];
  el._buildLayers();
  await el.updateComplete;
  assert.equal(el._visitsGroup.getLayers().length, 1);
  assert.ok(
    Math.abs(el._visitsGroup.getLayers()[0].options.opacity - 1) < 1e-6
  );
});

test("card uses the core map tiles proxy when available", async (t) => {
  const calls = [];
  const { dom, el } = makeCard({
    config: { latitude: 52.37, longitude: 4.89, components: ["map_tiles"] },
    connection: {
      sendMessagePromise: async (msg) => {
        calls.push(msg.type);
        return { token: "tok123" };
      },
    },
  });
  t.after(() => {
    el.remove();
    dom.window.close();
  });
  await mount(dom, el, { entities: ["device_tracker.phone"] });
  assert.ok(calls.includes("map_tiles/access_token"));
  assert.ok(el._tileLayer._url.includes("/api/map_tiles/raster/"));
  assert.equal(el._tileLayer.options.token, "tok123");
  assert.equal(el._tileSource, "map_tiles");
});

test("_mapTilesRequest carries the token to the proxy only", () => {
  const { el } = makeCard();
  el._tileToken = "tok";
  const sameOrigin = el._mapTilesRequest("/api/map_tiles/vector/1/2/3.mvt");
  assert.equal(sameOrigin.url, "http://localhost/api/map_tiles/vector/1/2/3.mvt");
  assert.equal(sameOrigin.headers["X-Map-Tiles-Token"], "tok");
  const crossOrigin = el._mapTilesRequest(
    "https://ha.example/api/map_tiles/raster/1/2/3.png"
  );
  assert.equal(crossOrigin.headers, undefined);
  assert.ok(crossOrigin.url.includes("token=tok"));
  const foreign = el._mapTilesRequest("https://tiles.example/x.png");
  assert.equal(foreign.url, "https://tiles.example/x.png");
  assert.ok(!foreign.url.includes("token"));
});

test("maplibre worker ships next to the card bundle", () => {
  const worker = fileURLToPath(
    new URL("../www/maplibre-gl-worker.js", import.meta.url)
  );
  assert.ok(existsSync(worker), "worker file exists (npm run build copies it)");
  assert.ok(statSync(worker).size > 100000, "worker file is not a stub");
});

test("card falls back to raster tiles without the map tiles integration", async (t) => {
  const { dom, el } = makeCard();
  t.after(() => {
    el.remove();
    dom.window.close();
  });
  await mount(dom, el, { entities: ["device_tracker.phone"] });
  assert.ok(el._tileLayer._url.includes("cartocdn.com"));
  assert.equal(el._tileSource, "carto");
});

test("card rebuilds its map after the error card replaced it", async (t) => {
  const { dom, el } = makeCard();
  t.after(() => {
    el.remove();
    dom.window.close();
  });
  await mount(dom, el, { entities: ["device_tracker.phone"] });
  assert.ok(el._map);
  el._error = "refetch failed";
  await el.updateComplete;
  assert.equal(el._map, undefined, "stale map torn down");
  assert.ok(el.renderRoot.querySelector("ha-alert"), "error card shown");
  el._error = undefined;
  await el.updateComplete;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(el._map, "map rebuilt");
  assert.equal(el._map.getContainer(), el.renderRoot.querySelector("#map"));
});

test("aspect config and the stock aspect_ratio key shape the container", async (t) => {
  const aspect = makeCard();
  const stock = makeCard();
  t.after(() => {
    aspect.el.remove();
    aspect.dom.window.close();
    stock.el.remove();
    stock.dom.window.close();
  });
  await mount(aspect.dom, aspect.el, {
    entities: ["device_tracker.phone"],
    aspect: 2,
  });
  assert.match(
    aspect.el.renderRoot.querySelector("#root").getAttribute("style"),
    /--visit-heatmap-aspect:2 \/ 1;/
  );
  await mount(stock.dom, stock.el, {
    entities: ["device_tracker.phone"],
    aspect_ratio: "16:9",
  });
  assert.match(
    stock.el.renderRoot.querySelector("#root").getAttribute("style"),
    /--visit-heatmap-aspect:1\.777/
  );
});