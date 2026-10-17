// Which vector cartography the base map draws, resolved from the card's
// `map_style`. The stock map card grew the same picker, so the style names,
// the custom-style object and the color handling are its behavior, mirrored
// here (frontend src/common/map/map-styles.ts, Apache-2.0; see ADR-0008).
//
// Only the resolution lives here. The default pair ships with the frontend
// and is fetched as-is; every other cartography is built in the browser by
// map-style.mjs — so this module stays free of the builder and is testable
// without it.

/** Style ids, in the order the editor offers them */
export const MAP_STYLES = [
  "default",
  "colorful",
  "natural",
  "muted",
  "gray",
  "toner",
];

export const DEFAULT_MAP_STYLE = "default";

// The colors the default style is painted in: the frontend's own palette, so
// the card's default matches the stock map. Copies of HA_MAP_COLORS and
// HA_MAP_COLORS_DARK (frontend src/common/map/ha-map-palette.ts). The frontend
// bakes them into the shipped styles; a custom card has to carry them for the
// styles it builds itself.
const HA_MAP_COLORS = {
  background: "#f5efe5",
  land: "#f5efe5",
  water: "#b8daec",
  labelWater: "#5487aa",
  natureWood: "#cfe4bc",
  natureGrass: "#e2eed8",
  naturePark: "#cfe4bc",
  natureLeisure: "#e2eed8",
  natureAgriculture: "#e8efe1",
  natureWetland: "#e5ecdf",
  natureSand: "#f3eadd",
  natureRock: "#f3eadd",
  glacier: "#faf6f0",
  areaResidential: "#f1e9da",
  areaCommercial: "#f7e0d8",
  areaIndustrial: "#f0e7cb",
  areaWaste: "#eee3d3",
  areaBurial: "#f1e9da",
  siteParking: "#efe7d6",
  siteSports: "#cfe4bc26",
  building: "#eadec7",
  buildingBg: "#e0cdae",
  roadStreet: "#fcfaf8",
  roadStreetBg: "#e9dbc4",
  roadTrunk: "#ffe7be",
  roadTrunkBg: "#ebd09f",
  roadMotorway: "#f1d6a5",
  roadMotorwayBg: "#e8bd6e",
  transitRail: "#ece0cb",
  transitSubway: "#ece2cf",
  transitCycle: "#f3eee2",
  transitFoot: "#f3eee2",
  boundary: "#dbc49f",
  boundaryDisputed: "#e5d7bd",
  label: "#4b473c",
  labelHalo: "#faf8f5cc",
  labelSymbol: "#8f8774",
  labelPoi: "#8f877466",
  labelShield: "#fbf8f3",
  labelHousenumber: "#8f87744d",
};

/** Drawn on the dark palette, in full: a light value left standing here would
 * show through on a dark map. */
const HA_MAP_COLORS_DARK = {
  background: "#191b2c",
  land: "#191b2c",
  water: "#27357a",
  labelWater: "#9cc0f0",
  natureWood: "#254948",
  natureGrass: "#213b39",
  naturePark: "#28504b",
  natureLeisure: "#213532",
  natureAgriculture: "#203233",
  natureWetland: "#253337",
  natureSand: "#2a2c3d",
  natureRock: "#2a2c3d",
  glacier: "#2a2c3d",
  areaResidential: "#1d2034",
  areaCommercial: "#29213a",
  areaIndustrial: "#242431",
  areaWaste: "#1d2034",
  areaBurial: "#1d2034",
  siteParking: "#1d2034",
  siteSports: "#25413926",
  building: "#21243c",
  buildingBg: "#2a2e4a",
  roadStreet: "#2b3052",
  roadStreetBg: "#1a1d33",
  roadTrunk: "#383e67",
  roadTrunkBg: "#22263f",
  roadMotorway: "#454d7d",
  roadMotorwayBg: "#2a2f4c",
  transitRail: "#2c3150",
  transitSubway: "#2c3150",
  transitCycle: "#2b3052",
  transitFoot: "#2b3052",
  boundary: "#3b4068",
  boundaryDisputed: "#3b4068",
  label: "#e7ecf8",
  labelHalo: "#12141fcc",
  labelSymbol: "#959dbd",
  labelPoi: "#959dbd66",
  labelShield: "#191b2c",
  labelHousenumber: "#959dbd4d",
};

/** A cartography plus the colors painted over it; only the default has any */
const STYLE_PALETTES = {
  default: {
    palette: "colorful",
    colors: HA_MAP_COLORS,
    colorsDark: HA_MAP_COLORS_DARK,
  },
  colorful: { palette: "colorful" },
  natural: { palette: "natural" },
  muted: { palette: "muted" },
  gray: { palette: "gray" },
  toner: { palette: "toner" },
};

const isStyle = (value) => MAP_STYLES.includes(value);

export const isCustomMapStyle = (style) =>
  typeof style === "object" && style !== null;

/** The palette id @versatiles/style is asked for, theme included */
export const paletteFor = (style, darkMode) => {
  const { palette } = STYLE_PALETTES[style];
  return darkMode ? `${palette}-dark` : palette;
};

// An allowlist, not a passthrough: the builder also takes the tile, glyph and
// sprite URLs, and those stay the card's.
const BUILDER_OPTIONS = ["colors", "recolor", "text", "icon", "layers"];

const camelCase = (key) =>
  key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());

// Both spellings are accepted so an options object copied from the versatiles
// styler pastes as it is. Deep, because the builder nests its options.
const camelCaseKeys = (value) => {
  if (Array.isArray(value)) {
    return value.map(camelCaseKeys);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        camelCase(key),
        camelCaseKeys(entry),
      ])
    );
  }
  return value;
};

const builderOptions = (style, darkMode) => {
  const options = {};
  for (const name of BUILDER_OPTIONS) {
    const value = style[name] ?? style[camelCase(name)];
    if (value !== undefined) {
      options[camelCase(name)] = camelCaseKeys(value);
    }
  }

  // `colors_dark` is not an option of the builder's, so the allowlist above
  // has already dropped it; on the dark palette it stands in for `colors`.
  // Ours rather than the builder's, so it is spelled the way configs are and
  // has no camelCase twin - unlike the options pasted from the styler.
  const colorsDark = style.colors_dark;
  if (darkMode && colorsDark !== undefined) {
    options.colors = camelCaseKeys(colorsDark);
  }

  return options;
};

/**
 * A picked cartography back into a config value, keeping whatever only YAML
 * can write. A bare name while there is nothing else, an object once there is.
 *
 * The editor offers the cartography and nothing else, so without this an edit
 * would drop a hand-written palette without saying so.
 */
export const withMapStyleBase = (current, base) => {
  // The form always holds a value, so writing the default back would add
  // `map_style: default` to every card the editor touches.
  const style = isStyle(base) && base !== DEFAULT_MAP_STYLE ? base : undefined;

  const carried = isCustomMapStyle(current) ? { ...current } : {};
  delete carried.base;

  if (!Object.keys(carried).length) {
    return style;
  }
  return {
    ...(style && { base: style }),
    ...carried,
  };
};

/**
 * What the card should draw: `shipped` when the frontend's own light/dark pair
 * is exactly it, otherwise a palette (and options) for the builder in
 * map-style.mjs. A style that does not exist would leave the map blank, so it
 * falls back to the default.
 */
export const resolveMapStyle = (style, darkMode) => {
  const custom = isCustomMapStyle(style) ? style : undefined;
  const named = custom ? custom.base : style;
  const mapStyle = isStyle(named) ? named : DEFAULT_MAP_STYLE;

  const palette = paletteFor(mapStyle, darkMode);
  const options = custom ? builderOptions(custom, darkMode) : {};
  // Before the palette's own colors are merged in below, so it answers whether
  // the card asked for anything of its own.
  const cardAdjusted = Object.keys(options).length > 0;

  // Bottom up - the palette's colors, then what the card names - so a card
  // that sets one color keeps the rest of the look.
  const { colors, colorsDark } = STYLE_PALETTES[mapStyle];
  const styleColors = (darkMode ? colorsDark : colors) ?? colors;
  if (styleColors) {
    options.colors = { ...styleColors, ...options.colors };
  }

  if (!Object.keys(options).length) {
    return { palette };
  }

  const base = styleColors ? { baseColors: styleColors } : {};

  // Anything added on top of the shipped default has to be built here; only
  // the untouched default is the pair the frontend already wrote out.
  return mapStyle === DEFAULT_MAP_STYLE && !cardAdjusted
    ? { palette, options, ...base, shipped: darkMode ? "dark" : "light" }
    : { palette, options, ...base };
};