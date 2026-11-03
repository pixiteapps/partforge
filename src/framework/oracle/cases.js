// Enumerate the parameter configurations verify() checks: the default config plus
// every declared preset (or an explicit part.verify.cases list).

import { desugar } from "../panel/legacy.js";

// Preset name -> overrides, discovered from the desugared node tree so both the
// legacy `presets:` field and authored `{ type: "preset" }` nodes count. The
// duplicate-name guard predates the duplicate-preset-name lint rule and stays:
// verify must fail loudly even on an unlinted part.
export function presetMap(part) {
  const map = {};
  const walk = (nodes) => {
    for (const node of nodes ?? []) {
      if (node.kind === "preset") {
        for (const [name, overrides] of Object.entries(node.presets ?? {})) {
          if (name in map) throw new Error(`duplicate preset name across sections: "${name}"`);
          map[name] = overrides;
        }
      }
      if (node.kind === "group") walk(node.children);
    }
  };
  walk(desugar(part.parameters ?? []));
  return map;
}

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
