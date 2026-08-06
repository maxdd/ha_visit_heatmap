import test from "node:test";
import assert from "node:assert/strict";
import {
  haversineM,
  decayOpacity,
  withinHorizon,
  parseEntities,
  journeySegments,
} from "./logic.mjs";

const DAY = 86400e3;
const BASE = Date.parse("2026-08-06T12:00:00Z");

const mk = (lastSeen, lat, lon) => ({
  device: "device_tracker.phone",
  last_seen: new Date(lastSeen).toISOString(),
  lat,
  lon,
  moving: true,
});

test("haversineM: demo home -> park distance", () => {
  const d = haversineM(52.3676, 4.9041, 52.3566, 4.9004);
  assert.ok(d > 1200 && d < 1300, `got ${d.toFixed(1)} m`);
});

test("decayOpacity: exact curve at 0/1/7/30 days", () => {
  assert.equal(decayOpacity(BASE, BASE, 0.1), 1);
  assert.ok(Math.abs(decayOpacity(BASE, BASE - DAY, 0.1) - 0.9) < 1e-9);
  assert.ok(Math.abs(decayOpacity(BASE, BASE - 7 * DAY, 0.1) - 0.4782969) < 1e-9);
  assert.ok(Math.abs(decayOpacity(BASE, BASE - 30 * DAY, 0.1) - 0.042391158) < 1e-9);
});

test("decayOpacity: clamps to [0,1] and handles rate 0", () => {
  assert.equal(decayOpacity(BASE, BASE + 5 * DAY, 0.1), 1);
  assert.ok(decayOpacity(BASE, BASE - 500 * DAY, 0.1) < 1e-20);
  assert.equal(decayOpacity(BASE, BASE - 1e7 * DAY, 0.1), 0);
  assert.equal(decayOpacity(BASE, BASE - 30 * DAY, 0), 1);
  assert.equal(decayOpacity(BASE, BASE, 1), 1);
});

test("withinHorizon: boundary is inclusive", () => {
  assert.equal(withinHorizon(BASE, BASE - 30 * DAY, 30), true);
  assert.equal(withinHorizon(BASE, BASE - (30 * DAY + 1), 30), false);
  assert.equal(withinHorizon(BASE, BASE, 30), true);
});

test("journeySegments: joins consecutive, breaks on gap", () => {
  const pts = [
    mk(BASE - 2 * DAY, 52.0, 4.0),
    mk(BASE - 1 * DAY, 52.1, 4.1),
    mk(BASE - 1 * DAY + 60_000, 52.2, 4.2),
  ];
  const segs = journeySegments(pts, { maxGapMs: 30 * 60e3 });
  assert.equal(segs.length, 1);
  assert.equal(segs[0].a.last_seen, pts[1].last_seen);
  assert.equal(segs[0].b.last_seen, pts[2].last_seen);
});

test("journeySegments: stationary-between suppresses the segment", () => {
  const pts = [mk(BASE - 120_000, 52.0, 4.0), mk(BASE - 60_000, 52.2, 4.2)];
  const opts = { maxGapMs: 30 * 60e3 };
  assert.equal(journeySegments(pts, { ...opts, hasStationaryBetween: () => true }).length, 0);
  assert.equal(journeySegments(pts, { ...opts, hasStationaryBetween: () => false }).length, 1);
});

test("parseEntities: show_all keeps GPS device_trackers only, not hidden", () => {
  const states = {
    "device_tracker.phone": { entity_id: "device_tracker.phone", attributes: { latitude: 1, longitude: 2 } },
    "device_tracker.hidden": { entity_id: "device_tracker.hidden", attributes: { latitude: 3, longitude: 4 } },
    "device_tracker.no_gps": { entity_id: "device_tracker.no_gps", attributes: {} },
    "person.alice": { entity_id: "person.alice", attributes: { latitude: 5, longitude: 6 } },
    "zone.home": { entity_id: "zone.home", attributes: { latitude: 7, longitude: 8 } },
    "sensor.x": { entity_id: "sensor.x", attributes: { latitude: 9, longitude: 10 } },
  };
  const registry = { "device_tracker.hidden": { hidden: true } };
  assert.deepEqual(parseEntities({ show_all: true }, states, registry), [
    { entity: "device_tracker.phone" },
  ]);
});

test("parseEntities: explicit list keeps order and normalizes strings", () => {
  const out = parseEntities({
    entities: ["device_tracker.a", { entity: "device_tracker.b", color: "#f00" }],
  });
  assert.deepEqual(out, [
    { entity: "device_tracker.a" },
    { entity: "device_tracker.b", color: "#f00" },
  ]);
});
