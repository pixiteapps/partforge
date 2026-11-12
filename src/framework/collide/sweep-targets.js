// What a declared sweep (`verify.sweeps`, spec 2026-11-02-collisions-design.md "Sweeps")
// moves: its target read into a motion over one value v, and the sub-parts that motion
// moves (rigidly) or rebuilds. The engine (oracle/sweep.js) and lint (rules-collisions.js)
// both read sweeps through this one module, so lint's sweep-unknown-target and
// sweep-rebuilds say exactly what the engine will do.
//
// A BVH-free leaf: geometry-free probes and the placement rule only, never the collision
// world or the native core, so the lint closure and the worker's eager closure may load it
// (test/worker-layering.test.js). It sits outside oracle/ for
// that reason; oracle/cases.js re-exports presetMap from here.
import { viewSubParts, resolveParams } from "../part-model.js";
import { probePoses } from "../pose-probe.js";
import { viewAnimations, evaluate } from "../animation.js";
import { normalizeCollisions } from "./declaration.js";
import { CONTACT_EPS } from "./pairs.js";
import { sameMat } from "./motion.js";
import { poseMatrices } from "./place.js";
import { rangesOf, dofsOf } from "../pose/param-solve.js";
import { locateHandle } from "../pose/handle-source.js";
import { desugar } from "../panel/legacy.js";

// The motion is sampled at this many intervals (plus a path's waypoints) to tell what it
// moves: comparing the two ends alone would drop a full turn, whose ends place alike. Its
// blind spots: a sub-part that moves only inside a window narrower than 1/16 of the range,
// or whose motion is periodic at 1/16 of it, reads as still (and its sweep may be dropped).
export const MOTION_SAMPLES = 16;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

/**
 * Preset name -> overrides, discovered from the desugared node tree so both the legacy
 * `presets:` field and authored `{ type: "preset" }` nodes count. The duplicate-name guard
 * predates the duplicate-preset-name lint rule and stays: verify must fail loudly even on
 * an unlinted part.
 */
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

/** Waypoints blended linearly over t ∈ [0, 1]; a value that is not a number on both sides holds. */
function pathAt(waypoints) {
  const n = waypoints.length - 1;
  return (t) => {
    const s = Math.min(Math.max(t, 0), 1) * n;
    const i = Math.min(Math.floor(s), n - 1), u = s - i;
    const a = waypoints[i], b = waypoints[i + 1], out = { ...a };
    for (const k of Object.keys(b)) {
      if (isNum(a[k]) && isNum(b[k])) out[k] = a[k] + (b[k] - a[k]) * u;
      else if (u >= 1) out[k] = b[k];
    }
    return out;
  };
}

/** The motion as `{ lo, hi, at(v) → params }`, for a sweep entry normalizeSweeps gave. */
export function motionOf(part, view, full, s) {
  if (s.kind === "param") return { lo: s.range[0], hi: s.range[1], at: (v) => ({ ...full, [s.param]: v }) };
  if (s.kind === "path") return { lo: 0, hi: 1, at: pathAt(s.waypoints.map((w) => ({ ...full, ...w }))) };
  const anim = (viewAnimations(part).get(view) ?? []).find((a) => a.name === s.animation);
  return { lo: 0, hi: 1, at: (t) => ({ ...full, ...evaluate(anim, t).values }) };
}

/**
 * What a motion moves in `view`: `moving` (sub-parts whose placement changes, rigidly) and
 * `rebuild` (sub-parts whose build-scope probe hash changes, whose build or place is
 * untrusted at some sample). Throws when a sample cannot be resolved.
 */
export function scanMotion(part, view, motion, extra = []) {
  const ts = [...Array.from({ length: MOTION_SAMPLES + 1 }, (_, i) => i / MOTION_SAMPLES), ...extra];
  const vs = ts.map((t) => motion.lo + (motion.hi - motion.lo) * t);
  const names = new Set();
  const mats0 = new Map(), hash0 = new Map(); // each name's first sampled placement and hash
  const moving = new Set(), rebuild = new Set();
  for (const v of vs) {
    const q = motion.at(v);
    const { p, d } = resolveParams(part, q);
    const mats = poseMatrices(part, view, p, d);
    const hashes = probePoses(part, view, q, { scope: "build" });
    // the union over every sample: a sub-part enabled part of the way still counts
    for (const name of viewSubParts(part, view, p)) {
      const m = mats.get(name), h = hashes.get(name);
      if (!names.has(name)) { names.add(name); mats0.set(name, m); hash0.set(name, h?.baseHash); }
      if (m === null || m === undefined || !h?.trusted || h.baseHash !== hash0.get(name)) rebuild.add(name);
      else if (!sameMat(m, mats0.get(name))) moving.add(name);
    }
  }
  const order = Object.keys(part.parts).filter((n) => names.has(n));
  return { moving: order.filter((n) => moving.has(n) && !rebuild.has(n)), rebuild: order.filter((n) => rebuild.has(n)) };
}

/**
 * One declaration read without a view: `{ goal: true }` (a goal handle: a target, not a
 * motion — never swept), or `{ entries }`, each a sweep entry (a handle expands to one
 * param entry per DOF, "<name>.<param>") or one that keeps `skip: "unreadable"` with
 * `why`, the reason as a phrase ("sweeps param …"), or `skip: "no-motion"`. An
 * animation entry carries `animViews`, the views that declare it.
 */
export function readSweep(part, name, spec, full, declClear = normalizeCollisions(part)?.clearance ?? CONTACT_EPS) {
  if (!isPlainObject(spec)) return { entries: [{ name, kind: null, skip: "unreadable", why: "is not an object naming a motion", clearance: declClear, views: null }] };
  const views = Array.isArray(spec.views) ? spec.views : null;
  // Any finite clearance (oracle/sweep.js): 0 may touch, a negative one may press in
  // that deep. Only a value that is no finite number falls back to the declared default.
  const clearance = isNum(spec.clearance) ? spec.clearance : declClear;
  const base = { clearance, views };
  const unreadable = (kind, why) => ({ entries: [{ name, kind, ...base, skip: "unreadable", why }] });
  const ranges = rangesOf(part);
  const paramSweep = (sweepName, key, range, what) => {
    const r = ranges.get(key);
    const span = range ?? (r ? [r.min, r.max] : null);
    if (!Array.isArray(span) || !isNum(span[0]) || !isNum(span[1]) || !(span[1] > span[0])) {
      const why = range !== undefined ? "has a `range` that is not [lo, hi] with lo < hi"
        : r ? `${what} "${key}", whose control has no finite min and max`
        : `${what} "${key}", which is no control in \`parameters\``;
      return { name: sweepName, kind: "param", param: key, ...base, skip: "unreadable", why };
    }
    return { name: sweepName, kind: "param", param: key, range: [span[0], span[1]], ...base };
  };
  if (typeof spec.param === "string") return { entries: [paramSweep(name, spec.param, spec.range, "sweeps param")] };
  if (typeof spec.handle === "string") {
    const handle = part.handles?.[spec.handle];
    if (!handle || typeof handle !== "object") return unreadable("param", `names handle "${spec.handle}", which is not a key of \`handles\``);
    if (handle.drag === "goal") return { goal: true };
    try {
      const { p, d } = resolveParams(part, full);
      locateHandle(part, p, d, handle);
    } catch (e) { return unreadable("param", `names handle "${spec.handle}", whose point cannot be read (${e?.message || e})`); }
    return { entries: dofsOf(handle, Object.values(part.handles), full).map((k) => paramSweep(`${name}.${k}`, k, spec.range, `sweeps handle "${spec.handle}"'s param`)) };
  }
  if (typeof spec.from === "string" || typeof spec.to === "string" || Array.isArray(spec.path)) {
    let waypoints;
    if (Array.isArray(spec.path)) waypoints = spec.path;
    else {
      let presets;
      try { presets = presetMap(part); } catch (e) { return unreadable("path", `names presets, which cannot be read (${e?.message || e})`); }
      for (const n of [spec.from, spec.to]) {
        if (typeof n !== "string" || !Object.hasOwn(presets, n)) return unreadable("path", `names preset ${JSON.stringify(n)}, which is no preset in \`parameters\` (and needs both \`from\` and \`to\`)`);
      }
      waypoints = [presets[spec.from], presets[spec.to]];
    }
    if (waypoints.length < 2 || !waypoints.every(isPlainObject)) return unreadable("path", "has a `path` that is not two or more param objects");
    return { entries: [{ name, kind: "path", waypoints, ...base }] };
  }
  if (typeof spec.animation === "string") {
    const animViews = [];
    let anim = null;
    for (const [view, list] of viewAnimations(part)) {
      const a = list.find((x) => x.name === spec.animation);
      if (a) { animViews.push(view); anim ??= a; }
    }
    if (!anim) return unreadable("animation", `names animation "${spec.animation}", which no view declares`);
    const duration = anim.steps.reduce((s, st) => s + (isNum(st.duration) ? st.duration : 0), 0);
    if (!(duration > 0)) return { entries: [{ name, kind: "animation", animation: spec.animation, ...base, animViews, skip: "no-motion" }] };
    return { entries: [{ name, kind: "animation", animation: spec.animation, ...base, animViews }] };
  }
  return unreadable(null, "names no motion");
}

/**
 * One declaration's sweeps in `view`, at the full params `full`: readSweep's entries, each
 * readable one scanned for what it moves there (`moving`, `rebuild`). A sweep whose `views`
 * leave the view out, an animation another view declares, and one that moves nothing here
 * give no entry; a sample that cannot be resolved keeps `skip: "unreadable"`. `r` is the
 * declaration already read by readSweep, for a caller that reads it once for every view.
 */
export function sweepsInView(part, view, name, spec, full, declClear, r = readSweep(part, name, spec, full, declClear)) {
  if (r.goal) return [];
  const out = [];
  for (const s of r.entries) {
    if (s.views && !s.views.includes(view)) continue;
    if (s.animViews && !s.animViews.includes(view)) continue; // nothing it moves is here
    if (s.skip) { out.push(s); continue; }
    let scan;
    try {
      const extra = s.kind === "path" ? s.waypoints.map((_, i) => i / (s.waypoints.length - 1)) : [];
      scan = scanMotion(part, view, motionOf(part, view, full, s), extra);
    } catch (e) { out.push({ ...s, skip: "unreadable", why: `cannot be stepped (${e?.message || e})` }); continue; }
    if (!scan.moving.length && !scan.rebuild.length) continue; // nothing moves in this view
    out.push({ ...s, moving: scan.moving, rebuild: scan.rebuild });
  }
  return out;
}
