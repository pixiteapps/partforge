// src/framework/materials/assets.js
// The ONLY module that turns an asset file name into a URL. `new URL("./assets/x",
// import.meta.url)` with a LITERAL path is what makes a consuming Vite build emit
// the file and rewrite the URL — a computed path is invisible to the bundler and
// ships a 404 (the partforge/geometry incident class). So every file is listed
// literally, once, here.
const URLS = {
  "env-studio.jpg": new URL("./assets/env-studio.jpg", import.meta.url).href,
  "env-workshop.jpg": new URL("./assets/env-workshop.jpg", import.meta.url).href,
  "env-print-bed.jpg": new URL("./assets/env-print-bed.jpg", import.meta.url).href,
  "env-outdoor.jpg": new URL("./assets/env-outdoor.jpg", import.meta.url).href,
  "ground-paper.jpg": new URL("./assets/ground-paper.jpg", import.meta.url).href,
  "ground-paper-normal.jpg": new URL("./assets/ground-paper-normal.jpg", import.meta.url).href,
  "ground-paper-rough.jpg": new URL("./assets/ground-paper-rough.jpg", import.meta.url).href,
  "ground-maple-color.jpg": new URL("./assets/ground-maple-color.jpg", import.meta.url).href,
  "ground-maple-normal.jpg": new URL("./assets/ground-maple-normal.jpg", import.meta.url).href,
  "ground-pei.jpg": new URL("./assets/ground-pei.jpg", import.meta.url).href,
  "ground-pei-rough.jpg": new URL("./assets/ground-pei-rough.jpg", import.meta.url).href,
  "ground-concrete.jpg": new URL("./assets/ground-concrete.jpg", import.meta.url).href,
  "ground-concrete-rough.jpg": new URL("./assets/ground-concrete-rough.jpg", import.meta.url).href,
  "ground-concrete-normal.jpg": new URL("./assets/ground-concrete-normal.jpg", import.meta.url).href,
  "pattern-oak-color.jpg": new URL("./assets/pattern-oak-color.jpg", import.meta.url).href,
  "pattern-oak-normal.jpg": new URL("./assets/pattern-oak-normal.jpg", import.meta.url).href,
  "pattern-oak-rough.jpg": new URL("./assets/pattern-oak-rough.jpg", import.meta.url).href,
  "pattern-walnut-color.jpg": new URL("./assets/pattern-walnut-color.jpg", import.meta.url).href,
  "pattern-walnut-normal.jpg": new URL("./assets/pattern-walnut-normal.jpg", import.meta.url).href,
  "pattern-walnut-rough.jpg": new URL("./assets/pattern-walnut-rough.jpg", import.meta.url).href,
  "pattern-carbon.jpg": new URL("./assets/pattern-carbon.jpg", import.meta.url).href,
};

// Single-mask patterns. Wood is a full PBR set named per preset (presets.js
// `textures`), so it has no entry here.
export const PATTERN_TEXTURES = { carbon: "pattern-carbon.jpg", concrete: "ground-concrete.jpg" };

export function assetUrl(name) {
  const url = URLS[name];
  if (!url) throw new Error(`partforge: unknown material asset "${name}"`);
  return url;
}
