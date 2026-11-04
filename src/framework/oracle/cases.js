// Enumerate the parameter configurations verify() checks: the default config plus
// every declared preset (or an explicit part.verify.cases list).

import { presetMap } from "../collide/sweep-targets.js";

// Preset name -> overrides. It lives in collide/sweep-targets.js, a BVH-free leaf that
// lint and the sweep engine share; re-exported here for verify's case expansion.
export { presetMap };

export function expandCases(part) {
  const presets = presetMap(part);
  const make = (name) => {
    if (name === "defaults") return { name, params: { ...part.defaults } };
    if (!(name in presets)) throw new Error(`unknown verify case "${name}" (not "defaults" or a preset)`);
    return { name, params: { ...part.defaults, ...presets[name] } };
  };
  const names = part.verify?.cases ?? ["defaults", ...Object.keys(presets)];
  return names.map(make);
}
