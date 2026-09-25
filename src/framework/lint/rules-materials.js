// src/framework/lint/rules-materials.js
// Appearance findings. All WARNINGS by design: a misspelled material must never
// block geometry, and the viewer already falls back (resolve.js). Pure — imports
// only the three-free materials data (test/lint-purity.test.js).
import { warn } from "./finding.js";
import { PRESETS } from "../materials/presets.js";
import { ENVIRONMENTS } from "../materials/environments.js";
import { resolveMaterial, resolveEnvironmentId, OVERRIDE_RANGES } from "../materials/resolve.js";
import { suggest } from "../geometry/op-options.js";

const listedPresets = () => Object.keys(PRESETS);
const subParts = (part) => Object.entries(part?.parts ?? {}).filter(([, sp]) => sp && typeof sp === "object");
const issuesOf = (part, kind) => subParts(part).flatMap(([name, sp]) =>
  resolveMaterial(sp.display).issues.filter((i) => i.kind === kind).map((i) => ({ name, ...i })));

export const MATERIAL_RULES = [
  {
    id: "unknown-material",
    run: ({ part }) => issuesOf(part, "unknown-material").map(({ name, value }) => {
      const near = typeof value === "string" ? suggest(value, listedPresets()) : null;
      return warn("unknown-material",
        `sub-part "${name}" names material ${JSON.stringify(value)}, which is not in the library`,
        `${near ? `Did you mean "${near}"? ` : ""}The viewer draws it as if it named no material instead (a PLA print in realistic mode). Known materials: ${listedPresets().join(", ")}.`,
        `parts.${name}.display.material`);
    }),
  },
  {
    id: "unknown-environment",
    run: ({ part }) => {
      const env = part?.meta?.environment;
      if (resolveEnvironmentId(env).known) return [];
      return [warn("unknown-environment",
        `meta.environment ${JSON.stringify(env)} is not a known environment`,
        `Realistic mode uses "studio" instead. Known environments: ${Object.keys(ENVIRONMENTS).join(", ")}.`,
        "meta.environment")];
    },
  },
  {
    id: "material-key-unknown",
    run: ({ part }) => issuesOf(part, "material-key-unknown").map(({ name, key }) =>
      warn("material-key-unknown",
        `sub-part "${name}" display has unknown key "${key}"`,
        `It is ignored. display accepts color, opacity, material and the overrides ${Object.keys(OVERRIDE_RANGES).join(", ")}; transmission, IOR, sheen and iridescence come only from a preset.`,
        `parts.${name}.display.${key}`)),
  },
  {
    id: "material-override-clamped",
    run: ({ part }) => issuesOf(part, "material-override-clamped").map(({ name, key, value, clampedTo }) => {
      const [lo, hi] = OVERRIDE_RANGES[key];
      return warn("material-override-clamped",
        `sub-part "${name}" display.${key} = ${JSON.stringify(value)} is outside ${lo}..${hi}; using ${clampedTo}`,
        `Give ${key} a number from ${lo} to ${hi}.`,
        `parts.${name}.display.${key}`);
    }),
  },
];
