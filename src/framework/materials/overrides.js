// src/framework/materials/overrides.js
// The viewer-side override of a sub-part's appearance, and the viewing state
// beside it. Pure: no three, no DOM (lint purity scans this folder).
//
// Two kinds of key, deliberately separate (spec A.1):
//   - APPEARANCE keys merge over the authored `display` into effective(), which
//     every material read uses — CAD, realistic, the throwaway thumbnail scene.
//     A host may persist these into source.
//   - VIEWING keys (`hidden`, `opacity`) are how the user is LOOKING. They never
//     reach effective(), exports, lint or declaresMaterials, and no host saves
//     them. `opacity` MULTIPLIES an authored display.opacity (the arithmetic
//     animation opacity already uses), so a ghost can be faded further but not
//     made solid from here.
import { DISPLAY_KEYS, OVERRIDE_RANGES } from "./resolve.js";

export const APPEARANCE_OVERRIDE_KEYS = DISPLAY_KEYS.filter((k) => k !== "opacity");
export const VIEWING_KEYS = ["hidden", "opacity"];
export const MIN_USER_OPACITY = 0.05;

const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isColor = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffff;
const finite = (v) => typeof v === "number" && Number.isFinite(v);

// Only known keys survive; `null` is the "clear this key" value and survives
// as-is. Bad values are DROPPED (not clamped) where clamping would invent a
// choice: a non-string material, a colour out of range. Numeric overrides clamp
// to OVERRIDE_RANGES exactly as resolve.js clamps authored ones. `opacity`
// floors at MIN_USER_OPACITY and reads >= 1 as a clear; `hidden` must be a real
// boolean (a host's "false" string would otherwise read as truthy and hide the
// part), anything else is dropped.
export function sanitizeDisplayPatch(patch) {
  if (!isObject(patch)) return {};
  const out = {};
  for (const [key, v] of Object.entries(patch)) {
    if (v === null) {
      if (APPEARANCE_OVERRIDE_KEYS.includes(key) || VIEWING_KEYS.includes(key)) out[key] = null;
      continue;
    }
    if (key === "material") { if (typeof v === "string" && v.length > 0) out.material = v; continue; }
    if (key === "color") { if (isColor(v)) out.color = v; continue; }
    if (key === "hidden") { if (typeof v === "boolean") out.hidden = v; continue; }
    if (key === "opacity") {
      if (!finite(v)) continue;
      out.opacity = v >= 1 ? null : Math.max(MIN_USER_OPACITY, v);
      continue;
    }
    if (key in OVERRIDE_RANGES) {
      if (!finite(v)) continue;
      const [lo, hi] = OVERRIDE_RANGES[key];
      out[key] = Math.min(hi, Math.max(lo, v));
    }
  }
  return out;
}

// Merge a SANITIZED patch over the current override. `hidden: false` and
// `opacity: null` (or >= 1) are clears like any other null. Returns null when nothing is
// left, so a Map entry can be deleted rather than kept empty.
export function mergeOverride(current, patch) {
  const next = { ...(isObject(current) ? current : {}) };
  for (const [key, v] of Object.entries(patch ?? {})) {
    if (v === null || (key === "hidden" && v === false) || (key === "opacity" && v >= 1)) delete next[key];
    else next[key] = v;
  }
  return Object.keys(next).length ? next : null;
}

// The display every material read sees: authored, with the override's
// APPEARANCE keys on top. Viewing keys are never in it.
export function effectiveDisplay(authored, override) {
  const out = isObject(authored) ? { ...authored } : {};
  if (!isObject(override)) return out;
  for (const key of APPEARANCE_OVERRIDE_KEYS) if (key in override) out[key] = override[key];
  return out;
}

export function isAppearanceNoop(authored, override) {
  if (!isObject(override)) return true;
  const a = isObject(authored) ? authored : {};
  return APPEARANCE_OVERRIDE_KEYS.every((key) => !(key in override) || override[key] === a[key]);
}

// A carried map, made safe for THIS part (spec A.4): names the part no longer
// declares go; appearance keys that now equal the authored value go (an owner's
// saved change self-cleans this way); every kept entry is re-sanitized, since
// the token came from a host; empties go.
export function pruneOverrides(map, part) {
  const out = {};
  if (!isObject(map)) return out;
  for (const [name, raw] of Object.entries(map)) {
    // Own names only: `parts` is a plain object, so "toString" or "constructor"
    // would otherwise read as declared sub-parts and be replayed into the viewer.
    const parts = part?.parts;
    if (!isObject(parts) || !Object.hasOwn(parts, name)) continue;
    const sp = parts[name];
    if (!sp) continue;
    const clean = mergeOverride(null, sanitizeDisplayPatch(raw));
    if (!clean) continue;
    const authored = isObject(sp.display) ? sp.display : {};
    for (const key of APPEARANCE_OVERRIDE_KEYS) if (key in clean && clean[key] === authored[key]) delete clean[key];
    if (Object.keys(clean).length) out[name] = clean;
  }
  return out;
}

// The one visibility decision viewer.js's applySubOpacity makes, as a pure
// function of its inputs. `anim` is the animation driver's opacity (undefined =
// none), `user` the viewing override's (undefined = none). `fade` is null when
// the mesh should sit on its base material, else the fade clone's opacity.
export function subPartVisibility({ shown, anim, user, hidden, renderMode, staticOpacity = 1 }) {
  const off = { meshVisible: false, linesVisible: false, fade: null };
  if (!shown || hidden) return off;
  const a = anim === undefined ? 1 : anim;
  const u = user === undefined ? 1 : user;
  const v = a * u;
  if (v <= 0) return off;
  const linesVisible = renderMode === "cad";
  if (v >= 1) return { meshVisible: true, linesVisible, fade: null };
  return { meshVisible: true, linesVisible, fade: staticOpacity * v };
}
