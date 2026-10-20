// src/framework/sub-part-list.js
// The row model behind the popover's Parts section and the runtime's
// listSubParts(): one row per sub-part, in definition order, saying whether it
// is in the view, how it is overridden, and what its swatch should look like.
// Pure (no DOM, no three) so the popover, a host and the tests read one model.
import { viewSubParts } from "./part-model.js";
import { partLabel } from "./export-select.js";
import { resolveMaterial, NO_MATERIAL_COLOR } from "./materials/resolve.js";
import { PRESETS } from "./materials/presets.js";
import { effectiveDisplay, APPEARANCE_OVERRIDE_KEYS } from "./materials/overrides.js";

const known = (m) => typeof m === "string" && Object.hasOwn(PRESETS, m);
const isColor = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffff;

// The swatch colour: the explicit colour wins (it tints any preset, resolve.js),
// else a known preset's own colour, else the drafting blue-grey.
function swatchColor(effective) {
  if (isColor(effective.color)) return effective.color;
  if (known(effective.material)) return resolveMaterial(effective).params.color;
  return NO_MATERIAL_COLOR;
}

export function subPartRows(part, { view, params, overrides = {} } = {}) {
  const inViewNames = new Set(viewSubParts(part, view, params ?? part.defaults ?? {}));
  return Object.keys(part.parts).map((name) => {
    const sp = part.parts[name];
    const override = overrides?.[name] ?? null;
    const effective = effectiveDisplay(sp.display, override);
    const m = effective.material;
    const materialLabel = m == null ? null : known(m) ? PRESETS[m].label : "unknown";
    return {
      name,
      label: partLabel(part, name),
      inView: inViewNames.has(name),
      hidden: override?.hidden === true,
      opacity: typeof override?.opacity === "number" ? override.opacity : 1,
      effective,
      color: swatchColor(effective),
      materialLabel,
      tintable: m == null || !known(m) || PRESETS[m].tintable === true,
      overridden: !!override && APPEARANCE_OVERRIDE_KEYS.some((k) => k in override),
    };
  });
}
