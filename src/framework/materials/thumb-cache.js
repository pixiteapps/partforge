// Keys and bounds for the appearance card's sphere thumbnails. A tile depicts
// the PRESET, tinted: finish overrides (and see-through) are neither in the key
// nor in the render — re-rendering 25 spheres on every slider tick would make
// the card unusable, and a render that read them would cache one part's finish
// under a key every other part shares. thumbDisplay is what the render builds
// from, so it can depend on exactly what the key holds.
const CAP = 120;
export function thumbDisplay(display) {
  const out = { material: display?.material };
  if (display?.color !== undefined) out.color = display.color;
  return out;
}
export function createMaterialThumbCache() {
  const map = new Map();
  return {
    key: (display, env, theme, mode) => `${display?.material ?? ""}|${display?.color ?? ""}|${env}|${theme}|${mode}`,
    get(k) { const v = map.get(k); if (v !== undefined) { map.delete(k); map.set(k, v); } return v; },
    set(k, url) { map.delete(k); map.set(k, url); if (map.size > CAP) map.delete(map.keys().next().value); },
    clear() { map.clear(); },
  };
}
