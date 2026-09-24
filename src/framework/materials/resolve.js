// src/framework/materials/resolve.js
// Pure resolution of a sub-part's `display` block against the library. Never
// throws and never rejects a value: an unknown preset falls back to the default,
// an out-of-range override clamps, an unknown key is ignored — and every one of
// those is returned as an `issue` so lint can warn about it. Appearance must
// never be able to fail a build.
import { PRESETS, DEFAULT_PRESET_ID } from "./presets.js";
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

export function resolveMaterial(display) {
  const d = display && typeof display === "object" ? display : {};
  const issues = [];
  let preset = PRESETS[DEFAULT_PRESET_ID];
  if (d.material != null) {
    if (typeof d.material === "string" && Object.hasOwn(PRESETS, d.material)) preset = PRESETS[d.material];
    else issues.push({ kind: "unknown-material", key: "material", value: d.material });
  }
  const params = {
    color: preset.color,
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
  return { preset, params, issues };
}

// CAD-view appearance: the resolved colour on the CAD MeshStandardMaterial,
// flattened so it reads without an environment map (a metalness-1 material with
// no environment renders near-black), and lifted to a minimum luminance so a
// black-rubber part doesn't hide its geometry in the agent's screenshots.
const MIN_CAD_LUMA = 60; // 0..255, Rec. 709
export function cadAppearance(display) {
  const d = display && typeof display === "object" ? display : {};
  const { params } = resolveMaterial(d);
  if (d.material == null) {
    // Byte-for-byte today's behaviour for a part without `material`.
    return { color: params.color, metalness: 0.25, roughness: 0.55, opacity: params.opacity };
  }
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
// colour. Null when the sub-part says nothing about appearance, which is what
// keeps an appearance-free export byte-for-byte unchanged.
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
