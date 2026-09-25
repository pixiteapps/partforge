// src/framework/materials/resolve.js
// Pure resolution of a sub-part's `display` block against the library. Never
// throws and never rejects a value: an unknown preset falls back to the
// no-material look (below),
// an out-of-range override clamps, an unknown key is ignored — and every one of
// those is returned as an `issue` so lint can warn about it. Appearance must
// never be able to fail a build.
import { PRESETS } from "./presets.js";
import { ENVIRONMENTS, DEFAULT_ENVIRONMENT_ID } from "./environments.js";

export const OVERRIDE_RANGES = {
  roughness: [0, 1],
  metalness: [0, 1],
  clearcoat: [0, 1],
  clearcoatRoughness: [0, 1],
  anisotropy: [0, 1],
  textureScale: [0.01, 1000],
};

export const DISPLAY_KEYS = ["color", "opacity", "material", ...Object.keys(OVERRIDE_RANGES)];

const isColor = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffff;

// A sub-part with no usable material — none named, or one the library does not
// know. The CAD view draws it in the viewer's neutral blue-grey drafting look
// (the look every part had before the library existed; viewer.js's base
// material and threemf.js's uncoloured-object colour are the same literal).
// Realistic mode draws it as a PLA print — the pla-print finish, layer lines
// and all — in that same colour, or the part's own `color`, so a part is the
// same colour in both views, just printed. `declaresMaterials` still counts
// only a NAMED material: this default never makes a part "declare" one.
export const NO_MATERIAL_COLOR = 0x9fb4cc;
export const NO_MATERIAL_PRESET_ID = "pla-print";
const NO_MATERIAL_CAD = { color: NO_MATERIAL_COLOR, metalness: 0.25, roughness: 0.55 };

const knownMaterial = (m) => typeof m === "string" && Object.hasOwn(PRESETS, m);

export function resolveMaterial(display) {
  const d = display && typeof display === "object" ? display : {};
  const issues = [];
  if (d.material != null && !knownMaterial(d.material)) issues.push({ kind: "unknown-material", key: "material", value: d.material });
  const preset = knownMaterial(d.material) ? PRESETS[d.material] : PRESETS[NO_MATERIAL_PRESET_ID];
  const baseColor = knownMaterial(d.material) ? preset.color : NO_MATERIAL_COLOR;
  return { preset, ...applyDisplay(d, preset, baseColor, issues) };
}

// A preset record's numbers with the display block's colour, opacity and clamped
// overrides applied. Pushes onto `issues`; returns them with the params.
function applyDisplay(d, preset, baseColor, issues) {
  const params = {
    color: baseColor,
    metalness: preset.metalness,
    roughness: preset.roughness,
    clearcoat: preset.clearcoat ?? 0,
    clearcoatRoughness: preset.clearcoatRoughness ?? 0,
    anisotropy: preset.anisotropy ?? 0,
    transmission: preset.transmission ?? 0,
    thickness: preset.thickness ?? 0,
    ior: preset.ior ?? 1.5,
    pattern: preset.pattern ?? null,
    textureScale: preset.textureScale ?? 1,
    envIntensity: preset.envIntensity ?? 1,
    specularIntensity: preset.specularIntensity ?? 1,
    textures: preset.textures ?? null,
    opacity: 1,
  };
  if (isColor(d.color)) params.color = d.color;
  if (typeof d.opacity === "number" && Number.isFinite(d.opacity)) params.opacity = Math.min(1, Math.max(0, d.opacity));
  for (const [key, [lo, hi]] of Object.entries(OVERRIDE_RANGES)) {
    if (!(key in d)) continue;
    const v = d[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      issues.push({ kind: "material-override-clamped", key, value: v, clampedTo: params[key] });
      continue;
    }
    const c = Math.min(hi, Math.max(lo, v));
    if (c !== v) issues.push({ kind: "material-override-clamped", key, value: v, clampedTo: c });
    params[key] = c;
  }
  for (const key of Object.keys(d)) {
    if (!DISPLAY_KEYS.includes(key)) issues.push({ kind: "material-key-unknown", key, value: d[key] });
  }
  // `tinted`: the author named a colour. A textured preset's colour map carries
  // its own colour, so only an explicit tint multiplies it (physical.js).
  return { params, issues, tinted: isColor(d.color) };
}

// CAD-view appearance: the resolved colour on the CAD MeshStandardMaterial,
// flattened so it reads without an environment map (a metalness-1 material with
// no environment renders near-black), and lifted to a minimum luminance so a
// black-rubber part doesn't hide its geometry in the agent's screenshots.
const MIN_CAD_LUMA = 60; // 0..255, Rec. 709
export function cadAppearance(display) {
  const d = display && typeof display === "object" ? display : {};
  if (d.material == null) {
    // The drafting look, untouched by overrides — as it always was.
    const { params } = resolveMaterial(d);
    return { color: params.color, metalness: NO_MATERIAL_CAD.metalness, roughness: NO_MATERIAL_CAD.roughness, opacity: params.opacity };
  }
  // An unknown material flattens the drafting look rather than the realistic
  // PLA default, exactly as it did when it fell back to the retired "default"
  // preset.
  const { params } = knownMaterial(d.material) ? resolveMaterial(d) : applyDisplay(d, NO_MATERIAL_CAD, NO_MATERIAL_COLOR, []);
  return {
    color: liftLuma(params.color, MIN_CAD_LUMA),
    metalness: Math.min(params.metalness, 0.5),
    roughness: Math.max(params.roughness, 0.3),
    opacity: params.opacity,
  };
}

function liftLuma(color, min) {
  let r = (color >> 16) & 255, g = (color >> 8) & 255, b = color & 255;
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (luma >= min) return color;
  // Mix toward mid-grey just far enough to reach `min`, keeping hue.
  const t = (min - luma) / (128 - luma || 1);
  r = Math.round(r + (128 - r) * t); g = Math.round(g + (128 - g) * t); b = Math.round(b + (128 - b) * t);
  return (r << 16) | (g << 8) | b;
}

// The colour a 3MF object carries: the explicit tint, else the preset's own
// colour (the blue-grey for an unknown material, never the realistic PLA
// default's). Null when the sub-part says nothing about appearance, which is
// what keeps an appearance-free export byte-for-byte unchanged.
export function printColor(display) {
  if (!display || typeof display !== "object") return null;
  if (isColor(display.color)) return display.color;
  if (display.material == null) return null;
  return resolveMaterial(display).params.color;
}

export function declaresMaterials(part) {
  return Object.values(part?.parts ?? {}).some((sp) => sp?.display?.material != null);
}

export function resolveEnvironmentId(id) {
  if (id == null) return { id: DEFAULT_ENVIRONMENT_ID, known: true };
  if (typeof id === "string" && Object.hasOwn(ENVIRONMENTS, id)) return { id, known: true };
  return { id: DEFAULT_ENVIRONMENT_ID, known: false };
}
