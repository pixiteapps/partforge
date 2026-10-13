// Keys and bounds for the appearance card's sphere thumbnails. A tile depicts
// the PRESET, tinted: finish overrides (and see-through) are neither in the key
// nor in the render — re-rendering 25 spheres on every slider tick would make
// the card unusable, and a render that read them would cache one part's finish
// under a key every other part shares. thumbDisplay is what the render builds
// from, so it can depend on exactly what the key holds.
//
// An UNTINTABLE preset (brass, oak, ...) draws its own colour whatever the
// part's colour is, so its colour is dropped from both the render and the key:
// every part shares one sphere for it, and a colour pick re-renders only the
// tintable tiles. The CAD "no material" tile (and an unknown id) is tintable.
import { PRESETS } from "./presets.js";

const CAP = 120;
const tintable = (material) =>
  typeof material !== "string" || !Object.hasOwn(PRESETS, material) || PRESETS[material].tintable === true;
export function thumbDisplay(display) {
  const out = { material: display?.material };
  if (display?.color !== undefined && tintable(display?.material)) out.color = display.color;
  return out;
}
export function createMaterialThumbCache() {
  const map = new Map();
  return {
    key: (display, env, theme, mode) => {
      const look = thumbDisplay(display);
      return `${look.material ?? ""}|${look.color ?? ""}|${env}|${theme}|${mode}`;
    },
    get(k) { const v = map.get(k); if (v !== undefined) { map.delete(k); map.set(k, v); } return v; },
    set(k, url) { map.delete(k); map.set(k, url); if (map.size > CAP) map.delete(map.keys().next().value); },
    clear() { map.clear(); },
  };
}
