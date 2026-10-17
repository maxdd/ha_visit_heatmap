// Builds the vector styles the frontend does not ship - every cartography but
// the default pair, and any style a card adjusts. Uses the same builder
// (@versatiles/style) and the same manifest of asset URLs the frontend's own
// build reads, so tiles, glyphs and sprite all resolve through core's proxy and
// the sheet this frontend vendored.
//
// A port of the frontend's build-map-style.ts and map-style-transforms.ts
// (Apache-2.0), minus the chunking: the card is one bundle, so the builder is
// imported directly rather than through a dynamic import.

import { osm } from "@versatiles/style";

const MAP_TILES_PATH = "/api/map_tiles";
const TILEJSON_URL = `${MAP_TILES_PATH}/tilejson.json`;

// Written by the frontend build (build-scripts/gulp/map-assets.js). Read rather
// than repeated here because the sprite URL carries a hash of the sheet that
// build vendored.
const STYLE_URLS_PATH = "/static/map/urls.json";

// /static is served with a month of max-age, so a cached manifest could pair a
// fresh frontend with the sprite sheet of an old one, now removed. Versioned,
// the way the frontend's own copy is.
let urls;
let urlsVersion;

const styleUrls = (version) => {
  if (urls !== undefined && urlsVersion === version) return urls;
  urlsVersion = version;
  const query = version ? `?v=${encodeURIComponent(version)}` : "";
  urls = fetch(`${STYLE_URLS_PATH}${query}`)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`style urls -> ${response.status}`);
      }
      return response.json();
    })
    .catch((err) => {
      // Nothing to fall back on: without the glyph and sprite URLs the style
      // would draw no labels and no icons at all.
      urls = undefined;
      urlsVersion = undefined;
      throw err;
    });
  return urls;
};

// MapLibre extends the fetched TileJSON with the style's own source options, so
// anything left here would freeze at build time - including attribution and
// zoom range, not just the URLs.
const TILEJSON_FIELDS = [
  "tiles",
  "attribution",
  "bounds",
  "minzoom",
  "maxzoom",
  "scheme",
];

/**
 * Repoints the style's one source at the proxy's TileJSON. Keyed on there being
 * exactly one: any other shape means the builder's own default host would reach
 * a browser unnoticed.
 */
const useTileJson = (name, style) => {
  const sources = Object.values(style.sources);
  if (sources.length !== 1) {
    throw new Error(
      `Style "${name}" has ${sources.length} sources, expected exactly one to ` +
        `point at the TileJSON. Check what @versatiles/style emits.`
    );
  }
  for (const field of TILEJSON_FIELDS) {
    delete sources[0][field];
  }
  sources[0].url = TILEJSON_URL;
  return style;
};

// Adds the English name to labels whose local name is not in Latin script.
// Shortbread tiles carry `name`, `name_en` and `name_de` only.
const NAME = ["get", "name"];
const NAME_EN = ["get", "name_en"];
// Strings compare by code point: anything from Basic Latin up to Latin
// Extended-B, digits and punctuation included.
const IS_LATIN = ["<", ["coalesce", NAME, ""], "ɐ"];
const ENGLISH_SCALE = 0.8;

// Streets are line-placed and cannot break lines.
const withEnglish = (placement) =>
  placement === "line"
    ? ["concat", NAME, " (", NAME_EN, ")"]
    : ["format", NAME, {}, "\n", {}, NAME_EN, { "font-scale": ENGLISH_SCALE }];

const isNameLabel = (layer) =>
  JSON.stringify(layer.layout?.["text-field"]) === JSON.stringify(NAME);

const addLatinLabels = (style) => ({
  ...style,
  layers: style.layers.map((layer) => {
    const layout = layer.layout;
    if (!layout || !isNameLabel(layer)) {
      return layer;
    }
    const textField = [
      "case",
      IS_LATIN,
      NAME,
      ["!", ["has", "name_en"]],
      NAME,
      withEnglish(layout["symbol-placement"]),
    ];
    return { ...layer, layout: { ...layout, "text-field": textField } };
  }),
});

// The atmosphere MapLibre scatters around the globe, which VersaTiles leaves
// off for a crisp edge. Against the space core draws behind the map, that edge
// is what wants softening.
const ATMOSPHERE_BLEND = 0.5;

const addAtmosphere = (style) => ({
  ...style,
  sky: { ...style.sky, "atmosphere-blend": ATMOSPHERE_BLEND },
});

/** Everything a freshly built style needs before it is handed to MapLibre */
export const finalizeMapStyle = (name, style) =>
  addAtmosphere(addLatinLabels(useTileJson(name, style)));

/**
 * Build one of the palettes the frontend left out. Theme and URLs come last:
 * the palette is the card's to pick from the theme mode, and the asset URLs are
 * core's proxy and this build's sprite sheet.
 */
export const buildMapStyle = async (palette, options, baseColors, version) => {
  const resolvedUrls = await styleUrls(version);
  const build = (opts) => osm({ ...opts, theme: palette, urls: resolvedUrls });

  // The builder throws on an option it does not know and on a color it cannot
  // parse. Those come from a card config, so one typo would otherwise drop the
  // whole base map to raster. Step back to the style as it ships - colors
  // included, or the default would come out as the builder's unpainted
  // cartography - and only then to the bare palette.
  const attempts = [
    options ?? {},
    ...(baseColors ? [{ colors: baseColors }] : []),
    {},
  ];
  let style;
  for (const attempt of attempts) {
    try {
      style = build(attempt);
      break;
    } catch {
      style = undefined;
    }
  }
  if (!style) {
    throw new Error(`Could not build map style "${palette}"`);
  }

  return finalizeMapStyle(palette, style);
};