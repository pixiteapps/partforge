// Parameter-space inverse kinematics for on-screen handles: which parameter values a
// drag writes. Angles mode solves for the handle's listed parameters through the part's
// own derive (resolveParams) with the shared DLS core; goal mode writes the dragged
// point onto the goal parameters and the solved joint angles back into the seed.
//
// Pure and three-free, DOM-free, node:-free. Core, so it never imports a domain: a
// posed limb is recognised by plain data alone — `typeof d[name]?.ikInfo === "function"`.
import { solveDLS } from "../solve/dls.js";
import { resolveParams } from "../part-model.js";
import { controlNodes } from "../panel/model.js";
import { desugar } from "../panel/legacy.js";

/** The residual of an evaluation whose derive threw: far worse than any real pose. */
const FAILED = 1e6;
/**
 * The Jacobian step, in normalised units: each DOF with a finite schema range is solved
 * as u in [0, 1] across it, so one step suits degrees and 0..1 curls alike. 1e-3 of the
 * range keeps the step well above world()'s 0.001 mm rounding.
 */
const H = 1e-3;
/**
 * A hold's residual weight against the grabbed point's 1. A pin is a constraint the
 * cursor must not drag along: when both cannot be met, the grabbed point gives way.
 */
const HOLD_WEIGHT = 10;

const isLimb = (v) => typeof v?.ikInfo === "function";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Every numeric control's { min, max, step } by key, hidden ones included (the schema walk lint uses). */
const RANGES = new WeakMap();
function rangesOf(part) {
  let ranges = RANGES.get(part);
  if (ranges) return ranges;
  ranges = new Map();
  for (const c of controlNodes(desugar(part?.parameters))) {
    if (c.type === "checkbox" || typeof c.key !== "string" || ranges.has(c.key)) continue;
    ranges.set(c.key, { min: c.min, max: c.max, step: c.step });
  }
  if (part && typeof part === "object") RANGES.set(part, ranges);
  return ranges;
}

const clamp = (v, r) => {
  if (!r) return v;
  if (isNum(r.min) && v < r.min) v = r.min;
  if (isNum(r.max) && v > r.max) v = r.max;
  return v;
};

/**
 * The starting damping: the grabbed limb's length (mm, joint to joint to tip). A DOF
 * spans its whole range in one normalised unit, so the Jacobian's entries are on the
 * order of this length; damping at that scale halves the first Gauss-Newton step,
 * which keeps a long jump out of a far basin, and the solver relaxes it after every
 * step that helps. Falls back to 1 when the length cannot be read.
 */
function limbLength(posed) {
  try {
    const { joints, points } = posed.ikInfo();
    const chain = [...joints.map((j) => points[j.name]), points.tip];
    let len = 0;
    for (let i = 1; i < chain.length; i++) len += Math.hypot(chain[i][0] - chain[i - 1][0], chain[i][1] - chain[i - 1][1], chain[i][2] - chain[i - 1][2]);
    return len > 0 ? len : 1;
  } catch {
    return 1;
  }
}

/** The posed limb a handle names, or null when derive throws or it is not a posed limb. */
function posedLimb(part, params, name) {
  try {
    const { d } = resolveParams(part, params);
    return isLimb(d?.[name]) ? d[name] : null;
  } catch {
    return null;
  }
}

/** The handle limb's ikInfo() at these params; null when derive throws or the limb is missing. */
export function limbInfo(part, params, handle) {
  const posed = posedLimb(part, params, handle?.limb);
  if (!posed) return null;
  try { return posed.ikInfo(); } catch { return null; }
}

/** The handle's DOFs: its listed params, less every param of a handle in allHandles whose lock is on. */
function dofsOf(handle, allHandles, p) {
  const frozen = new Set();
  for (const h of allHandles) {
    if (h?.lock == null || !p[h.lock]) continue;
    const listed = Array.isArray(h.params) ? h.params : [];
    for (const k of listed) frozen.add(k);
  }
  return (Array.isArray(handle.params) ? handle.params : []).filter((k) => !frozen.has(k));
}

/**
 * Solve the handle's angles-mode parameters so the grabbed point (a joint name or "tip")
 * reaches `target` while every hold `{ limb, at, point }` stays at its point.
 * Returns `{ values, error }` (values: every DOF, clamped to its schema range; error: the
 * residual norm in mm, each hold's share weighted by HOLD_WEIGHT) or null when the start
 * pose itself fails. Never throws for a derive that throws: that evaluation just scores
 * FAILED.
 */
export function solveAngles({ part, params, handle, grab, target, holds = [], iterations = 8, allHandles = [handle] }) {
  const base = { ...part.defaults, ...params };
  const keys = dofsOf(handle, allHandles, base);
  const ranges = rangesOf(part);
  // Per DOF, x = offset + scale * u: u in [0, 1] over a finite range, else the raw value.
  const offset = [], scale = [], lo = [], hi = [], u0 = [];
  for (const k of keys) {
    const r = ranges.get(k);
    const v = clamp(isNum(base[k]) ? base[k] : 0, r);
    if (r && isNum(r.min) && isNum(r.max) && r.max > r.min) {
      offset.push(r.min); scale.push(r.max - r.min); lo.push(0); hi.push(1);
      u0.push((v - r.min) / (r.max - r.min));
    } else {
      offset.push(0); scale.push(1);
      lo.push(isNum(r?.min) ? r.min : -Infinity); hi.push(isNum(r?.max) ? r.max : Infinity);
      u0.push(v);
    }
  }
  const valuesOf = (u) => {
    const out = {};
    keys.forEach((k, i) => { out[k] = offset[i] + scale[i] * u[i]; });
    return out;
  };
  const points = [{ limb: handle.limb, at: grab, point: target }, ...holds];
  const m = points.length * 3;
  const evaluate = (u) => {
    const { d } = resolveParams(part, { ...base, ...valuesOf(u) });
    const r = new Float64Array(m);
    points.forEach(({ limb, at, point }, i) => {
      const o = d[limb].world(at).origin;
      const w = i === 0 ? 1 : HOLD_WEIGHT;
      for (let c = 0; c < 3; c++) r[3 * i + c] = w * (o[c] - point[c]);
    });
    return r;
  };
  let lambda;
  try {
    evaluate(u0);
    lambda = limbLength(resolveParams(part, { ...base, ...valuesOf(u0) }).d[handle.limb]);
  } catch {
    return null;
  }
  // The Jacobian probes u ± H, past a bound when a DOF sits on one (a straight finger is
  // curl 0). Outside its range a parameter may make derive throw, which would poison the
  // whole column, so a probe is clamped back in: the derivative at a bound is one-sided
  // (half its size), never garbage.
  const residuals = (u) => {
    const inside = Float64Array.from(u, (v, i) => Math.min(hi[i], Math.max(lo[i], v)));
    try { return evaluate(inside); } catch { return new Float64Array(m).fill(FAILED); }
  };
  if (keys.length === 0) {
    const r = residuals(u0);
    return { values: {}, error: Math.hypot(...r) };
  }
  const { x, error } = solveDLS({ x0: u0, lo, hi, residuals, iterations, h: H, lambda });
  return { values: valuesOf(x), error };
}

/**
 * A goal-mode drag: the part-space point onto `handle.params.position`, and the aim
 * angles (pitch, yaw, roll — an array or an object) onto `handle.params.aim` when both
 * are given. With `part`, each value is clamped to its schema range.
 */
export function goalValues({ handle, point, aimAngles, part }) {
  const ranges = part ? rangesOf(part) : null;
  const out = {};
  const put = (k, v) => { if (typeof k === "string" && isNum(v)) out[k] = ranges ? clamp(v, ranges.get(k)) : v; };
  const { position, aim } = handle.params ?? {};
  (position ?? []).forEach((k, i) => put(k, point?.[i]));
  if (Array.isArray(aim) && aimAngles != null) {
    const angles = Array.isArray(aimAngles) ? aimAngles : [aimAngles.pitch, aimAngles.yaw, aimAngles.roll];
    aim.forEach((k, i) => put(k, angles[i]));
  }
  return out;
}

/**
 * The solved angles of a goal-mode handle's limb, written into `handle.seed` in order:
 * each driven joint (followers take no value) in limb order, a hinge as one value and a
 * ball as bend, spread, twist. Null when derive throws or the limb is missing.
 */
export function seedValues({ part, params, handle }) {
  const posed = posedLimb(part, params, handle?.limb);
  if (!posed) return null;
  let joints;
  try { joints = posed.ikInfo().joints; } catch { return null; }
  const flat = [];
  joints.forEach((j, i) => {
    if (j.follower) return;
    const v = posed.values[i];
    if (j.type === "ball") flat.push(v.bend, v.spread, v.twist);
    else flat.push(v);
  });
  const out = {};
  (handle.seed ?? []).forEach((k, i) => { if (i < flat.length && isNum(flat[i])) out[k] = flat[i]; });
  return out;
}

const decimals = (n) => {
  if (!isNum(n)) return 0;
  const s = String(n);
  const e = s.match(/e-(\d+)$/);
  if (e) return Number(e[1]);
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
};

/**
 * Release-time snapping: each key with a schema `step` goes to the nearest step from the
 * range's `min` (0 without one) and is clamped to the range. The result is rounded to the
 * step's and min's decimal places, so an integer step (with an integer min) yields an
 * integer. Keys without a schema entry pass through.
 */
export function snapValues(part, values) {
  const ranges = rangesOf(part);
  const out = {};
  for (const [k, v] of Object.entries(values)) {
    const r = ranges.get(k);
    if (!r || !isNum(v)) { out[k] = v; continue; }
    let s = v;
    if (isNum(r.step) && r.step > 0) {
      const from = isNum(r.min) ? r.min : 0;
      s = from + Math.round((v - from) / r.step) * r.step;
      const places = Math.max(decimals(r.step), decimals(from));
      s = Number(s.toFixed(Math.min(places, 15)));
    }
    out[k] = clamp(s, r);
  }
  return out;
}
