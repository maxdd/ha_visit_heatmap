import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const BUNDLE = readFileSync(
  fileURLToPath(new URL("../www/visit-heatmap-card.js", import.meta.url)),
  "utf8"
);

function makeCard() {
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  dom.window.eval(BUNDLE);
  const el = dom.window.document.createElement("visit-heatmap-card");
  el.hass = {
    states: {
      "device_tracker.phone": {
        entity_id: "device_tracker.phone",
        attributes: { latitude: 52.36, longitude: 4.9, friendly_name: "Phone" },
      },
      "device_tracker.hidden": {
        entity_id: "device_tracker.hidden",
        attributes: { latitude: 52.1, longitude: 4.1 },
      },
      "device_tracker.no_gps": { entity_id: "device_tracker.no_gps", attributes: {} },
      "person.alice": { entity_id: "person.alice", attributes: { latitude: 1, longitude: 1 } },
      "zone.home": {
        entity_id: "zone.home",
        attributes: { latitude: 52.3676, longitude: 4.9041, radius: 100 },
      },
    },
    entities: { "device_tracker.hidden": { hidden: true } },
    connection: null,
    locale: { language: "en" },
  };
  return { dom, el };
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

test("_buildLayers paints stationary, moving dots, and a journey line", () => {
  const { el } = makeCard();
  const now = Date.now();
  el._rows = [
    { device: "device_tracker.phone", lat: 52.3676, lon: 4.9041, last_seen: iso(now), moving: false },
    { device: "device_tracker.phone", lat: 52.3526, lon: 4.8879, last_seen: iso(now - 7 * DAY + 5 * 60e3), moving: true },
    { device: "device_tracker.phone", lat: 52.3376, lon: 4.8716, last_seen: iso(now - 7 * DAY), moving: true },
    { device: "device_tracker.phone", lat: 52.36, lon: 4.9, last_seen: iso(now - 40 * DAY), moving: false },
  ];
  el._buildLayers();
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
  assert.ok(Math.abs(el._opacity(rows.today) - 1) < 1e-9);
  assert.ok(Math.abs(el._opacity(rows.d7) - 0.4782969) < 1e-9);
  assert.equal(el._withinHorizon(rows.today), true);
  assert.equal(el._withinHorizon(rows.d40), false);
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
