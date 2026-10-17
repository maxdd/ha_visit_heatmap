// Copies MapLibre's worker next to the card bundle. MapLibre v6 resolves its
// worker from `import.meta.url`, which a bundled IIFE card cannot provide, so
// the card points `setWorkerUrl` at this file (served from /visit_heatmap/).
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(
  new URL("../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url)
);
const target = fileURLToPath(
  new URL(
    "../custom_components/visit_heatmap/www/maplibre-gl-worker.js",
    import.meta.url
  )
);

copyFileSync(source, target);
console.log(`maplibre worker -> ${target}`);