import test from "node:test";
import assert from "node:assert/strict";
import {
  MAP_STYLES,
  DEFAULT_MAP_STYLE,
  paletteFor,
  isCustomMapStyle,
  withMapStyleBase,
  resolveMapStyle,
} from "./map-style-config.mjs";
import { finalizeMapStyle } from "./map-style.mjs";

test("map-style: the style list is the stock card's, default first", () => {
  assert.deepEqual(MAP_STYLES, [
    "default",
    "colorful",
    "natural",
    "muted",
    "gray",
    "toner",
  ]);
  assert.equal(DEFAULT_MAP_STYLE, "default");
});

test("paletteFor: theme mode picks the half", () => {
  assert.equal(paletteFor("default", false), "colorful");
  assert.equal(paletteFor("default", true), "colorful-dark");
  assert.equal(paletteFor("natural", false), "natural");
  assert.equal(paletteFor("natural", true), "natural-dark");
});

test("isCustomMapStyle: only a non-null object is a custom style", () => {
  assert.equal(isCustomMapStyle(undefined), false);
  assert.equal(isCustomMapStyle("natural"), false);
  assert.equal(isCustomMapStyle({}), true);
});

test("resolveMapStyle: the untouched default is the shipped pair", () => {
  const light = resolveMapStyle(undefined, false);
  assert.equal(light.shipped, "light");
  assert.equal(light.palette, "colorful");
  // The HA palette is what the shipped pair was painted with; the same colors
  // are handed along so a failed adjustment can step back to them.
  assert.equal(light.options.colors.water, "#b8daec");
  assert.equal(light.baseColors.water, "#b8daec");

  const dark = resolveMapStyle("default", true);
  assert.equal(dark.shipped, "dark");
  assert.equal(dark.palette, "colorful-dark");
  assert.equal(dark.options.colors.water, "#27357a");
});

test("resolveMapStyle: a named cartography is built, not shipped", () => {
  const resolved = resolveMapStyle("natural", false);
  assert.equal(resolved.shipped, undefined);
  assert.equal(resolved.palette, "natural");
  // Nothing adjusted: the builder's own palette, no options at all.
  assert.equal(resolved.options, undefined);

  assert.equal(resolveMapStyle("toner", true).palette, "toner-dark");
});

test("resolveMapStyle: a style that does not exist falls back", () => {
  assert.equal(resolveMapStyle("sepia", false).shipped, "light");
  assert.equal(resolveMapStyle({ base: "sepia" }, false).shipped, "light");
  // An object is still an object: its adjustments apply on the fallback base.
  const adjusted = resolveMapStyle(
    { base: "sepia", recolor: { rotate_hue: 30 } },
    false
  );
  assert.equal(adjusted.palette, "colorful");
  assert.equal(adjusted.shipped, undefined);
  assert.deepEqual(adjusted.options.recolor, { rotateHue: 30 });
});

test("resolveMapStyle: adjustments keep the palette's other colors", () => {
  const resolved = resolveMapStyle(
    { colors: { water: "#123456" }, recolor: { saturate: 0.5 } },
    false
  );
  // Built, because the card named something - even on the default base.
  assert.equal(resolved.shipped, undefined);
  assert.equal(resolved.palette, "colorful");
  assert.equal(resolved.options.colors.water, "#123456");
  assert.equal(resolved.options.colors.land, "#f5efe5");
  assert.deepEqual(resolved.options.recolor, { saturate: 0.5 });
  // What a failed adjustment steps back to: the palette's own colors.
  assert.equal(resolved.baseColors.water, "#b8daec");
});

test("resolveMapStyle: colors_dark replaces colors on the dark palette", () => {
  const config = { base: "natural", colors_dark: { water: "#654321" } };
  const dark = resolveMapStyle(config, true);
  assert.deepEqual(dark.options.colors, { water: "#654321" });
  assert.equal(dark.options.colors_dark, undefined);

  // And only on the dark palette: the light half keeps its own colors.
  const light = resolveMapStyle(config, false);
  assert.equal(light.options, undefined);
});

test("resolveMapStyle: builder options are camelCased and allowlisted", () => {
  const resolved = resolveMapStyle(
    {
      base: "gray",
      recolor: { rotate_hue: 30, invert_brightness: true },
      text: { font_stack: ["Roboto"] },
      // Not a builder option, and not colors_dark: dropped outright.
      urls: { osm: "https://example.com/{z}/{x}/{y}" },
      tiles: "https://example.com/{z}/{x}/{y}",
    },
    false
  );
  assert.deepEqual(resolved.options.recolor, {
    rotateHue: 30,
    invertBrightness: true,
  });
  assert.deepEqual(resolved.options.text, { fontStack: ["Roboto"] });
  assert.equal(resolved.options.urls, undefined);
  assert.equal(resolved.options.tiles, undefined);
});

test("withMapStyleBase: a bare name while there is nothing else", () => {
  assert.equal(withMapStyleBase(undefined, "natural"), "natural");
  assert.equal(withMapStyleBase("gray", "toner"), "toner");
});

test("withMapStyleBase: the default is written as absence", () => {
  assert.equal(withMapStyleBase(undefined, "default"), undefined);
  assert.equal(withMapStyleBase("natural", "default"), undefined);
  assert.deepEqual(
    withMapStyleBase({ colors: { water: "#fff" } }, "default"),
    { colors: { water: "#fff" } }
  );
  // A name the editor cannot offer is not written back either.
  assert.equal(withMapStyleBase(undefined, "sepia"), undefined);
});

test("withMapStyleBase: what only YAML can write is kept on edit", () => {
  assert.deepEqual(withMapStyleBase({ colors: { water: "#fff" } }, "gray"), {
    base: "gray",
    colors: { water: "#fff" },
  });
  // The picked base is replaced, not duplicated: an old base must not stay.
  assert.deepEqual(
    withMapStyleBase({ base: "gray", recolor: { saturate: 0 } }, "muted"),
    { base: "muted", recolor: { saturate: 0 } }
  );
});

test("finalizeMapStyle: one source points at the proxy's TileJSON", () => {
  const style = {
    version: 8,
    sources: {
      shortbread: {
        type: "vector",
        tiles: ["https://tiles.example.com/{z}/{x}/{y}"],
        attribution: "Example",
        bounds: [-180, -85, 180, 85],
        minzoom: 0,
        maxzoom: 14,
        scheme: "xyz",
      },
    },
    layers: [],
  };
  const out = finalizeMapStyle("unit", style);
  const source = out.sources.shortbread;
  assert.equal(source.url, "/api/map_tiles/tilejson.json");
  for (const field of [
    "tiles",
    "attribution",
    "bounds",
    "minzoom",
    "maxzoom",
    "scheme",
  ]) {
    assert.equal(field in source, false, `${field} should be dropped`);
  }
  assert.equal(source.type, "vector");
});

test("finalizeMapStyle: exactly one source, or the style is suspect", () => {
  assert.throws(
    () => finalizeMapStyle("none", { sources: {}, layers: [] }),
    /expected exactly one/
  );
  assert.throws(
    () =>
      finalizeMapStyle("two", {
        sources: { a: { type: "vector" }, b: { type: "vector" } },
        layers: [],
      }),
    /expected exactly one/
  );
});

test("finalizeMapStyle: non-Latin names get their English half", () => {
  const style = {
    sources: { shortbread: { type: "vector" } },
    sky: { "sky-color": "#000000" },
    layers: [
      { id: "water", type: "fill", source: "shortbread" },
      { id: "place", type: "symbol", layout: { "text-field": ["get", "name"] } },
      {
        id: "street",
        type: "symbol",
        layout: { "text-field": ["get", "name"], "symbol-placement": "line" },
      },
      // Another label shape: left alone.
      {
        id: "other",
        type: "symbol",
        layout: { "text-field": ["get", "name_en"] },
      },
    ],
  };
  const out = finalizeMapStyle("unit", style);

  // The atmosphere the frontend adds for its space backdrop.
  assert.deepEqual(out.sky, { "sky-color": "#000000", "atmosphere-blend": 0.5 });

  const [water, place, street, other] = out.layers;
  assert.equal(water.layout, undefined);
  assert.equal(place.layout["text-field"][0], "case");
  assert.equal(place.layout["text-field"][5][0], "format");
  // Streets are line-placed and cannot break lines.
  assert.equal(street.layout["text-field"][5][0], "concat");
  assert.deepEqual(other.layout["text-field"], ["get", "name_en"]);
  // The style handed in is not painted: labels are rebuilt, not mutated.
  assert.deepEqual(style.layers[1].layout["text-field"], ["get", "name"]);
});