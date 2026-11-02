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
import { anglesFromAim, aimTurn } from "../solve/aim.js";
import { angleAbout, axisBasis, wrapTo180 } from "../solve/axis-angle.js";
import { locateHandle } from "./handle-source.js";

export { angleAbout, axisBasis };

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
/**
 * The solve stops once the residual is this small (mm): world() rounds to 0.001 mm, so
 * a residual at that size is as met as it can be read, and another Jacobian (2 derives
 * per DOF) buys nothing. Warm-started from the last frame, a drag usually gets there in
 * three or four iterations of the eight allowed — about half the derives.
 */
const TOL_MM = 1e-3;

const isLimb = (v) => typeof v?.ikInfo === "function";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Every numeric control's { min, max, step, wrap } by key, hidden ones included (the schema walk lint uses). */
const RANGES = new WeakMap();
export function rangesOf(part) {
  let ranges = RANGES.get(part);
  if (ranges) return ranges;
  ranges = new Map();
  for (const c of controlNodes(desugar(part?.parameters))) {
    if (c.type === "checkbox" || typeof c.key !== "string" || ranges.has(c.key)) continue;
    ranges.set(c.key, { min: c.min, max: c.max, step: c.step, wrap: c.wrap === true });
  }
  if (part && typeof part === "object") RANGES.set(part, ranges);
  return ranges;
}

const clamp = (v, r) => {
  if (!r || r.wrap) return v;   // a wrapped control turns without end: stored unreduced
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
  const posed = posedLimb(part, params, handle?.on);
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
 * The solver's variables for `keys`: per DOF, x = offset + scale * u. A finite schema
 * range is solved as u in [0, 1] across it, so one step suits degrees and 0..1 curls
 * alike; a param with no range is solved raw and unbounded. A wrapped param keeps its
 * range's scale (one turn is one unit, so the Jacobian is on the same footing as a
 * bounded DOF's and the starting damping means the same) but no bounds: u runs past 1,
 * and the value past `max`, as a drag turns it on.
 */
function dofSpace(ranges, base, keys) {
  const offset = [], scale = [], lo = [], hi = [], u0 = [];
  for (const k of keys) {
    const r = ranges.get(k);
    const v = clamp(isNum(base[k]) ? base[k] : 0, r);
    const finite = r && isNum(r.min) && isNum(r.max) && r.max > r.min;
    if (finite && !r.wrap) {
      offset.push(r.min); scale.push(r.max - r.min); lo.push(0); hi.push(1);
      u0.push((v - r.min) / (r.max - r.min));
    } else if (finite) {
      offset.push(r.min); scale.push(r.max - r.min); lo.push(-Infinity); hi.push(Infinity);
      u0.push((v - r.min) / (r.max - r.min));
    } else {
      offset.push(0); scale.push(1);
      lo.push(r?.wrap || !isNum(r?.min) ? -Infinity : r.min); hi.push(r?.wrap || !isNum(r?.max) ? Infinity : r.max);
      u0.push(v);
    }
  }
  const valuesOf = (u) => {
    const out = {};
    keys.forEach((k, i) => { out[k] = offset[i] + scale[i] * u[i]; });
    return out;
  };
  return { lo, hi, u0, valuesOf };
}

/** A hold's point reference: `{ ref, point }`, or the older `{ limb, at, point }`. */
const refOf = (hold) => hold.ref ?? { limb: hold.limb, at: hold.at };

/**
 * Where a point reference sits at a resolved (p, d): `{ limb, at }` reads the posed limb's
 * frame (the limb path, unchanged), `{ handleId, handle }` any handle (locateHandle).
 * Throws when it cannot be read — the solve scores that evaluation FAILED.
 */
function locate(part, p, d, ref) {
  return ref.handle ? locateHandle(part, p, d, ref.handle) : d[ref.limb].world(ref.at).origin;
}

/**
 * Run the DLS over `space` with `evaluate(u)` (which may throw) as the residual.
 * The Jacobian probes u ± H, past a bound when a DOF sits on one (a straight finger is
 * curl 0). Outside its range a parameter may make derive throw, which would poison the
 * whole column, so a probe is clamped back in: the derivative at a bound is one-sided
 * (half its size), never garbage.
 */
function runSolve(space, evaluate, m, { iterations, lambda, tol }) {
  const { lo, hi, u0 } = space;
  const residuals = (u) => {
    const inside = Float64Array.from(u, (v, i) => Math.min(hi[i], Math.max(lo[i], v)));
    try { return evaluate(inside); } catch { return new Float64Array(m).fill(FAILED); }
  };
  if (u0.length === 0) {
    const r = residuals(u0);
    return { x: u0, error: Math.hypot(...r) };
  }
  return solveDLS({ x0: u0, lo, hi, residuals, iterations, h: H, lambda, tol });
}

/**
 * Solve the handle's angles-mode parameters so the grabbed point (a joint name or "tip")
 * reaches `target` while every hold stays at its point. A hold is `{ ref, point }` (`ref`
 * `{ limb, at }` or `{ handleId, handle }`, see locate) or the older `{ limb, at, point }`.
 * Returns `{ values, error }` (values: every DOF, clamped to its schema range; error: the
 * residual norm in mm, each hold's share weighted by HOLD_WEIGHT) or null when the start
 * pose itself fails. Never throws for a derive that throws: that evaluation just scores
 * FAILED. It stops early once the residual is at most `tol` (default TOL_MM).
 */
export function solveAngles({ part, params, handle, grab, target, holds = [], iterations = 8, allHandles = [handle], tol = TOL_MM }) {
  const base = { ...part.defaults, ...params };
  const keys = dofsOf(handle, allHandles, base);
  const space = dofSpace(rangesOf(part), base, keys);
  const points = [{ ref: { limb: handle.on, at: grab }, point: target }, ...holds.map((h) => ({ ref: refOf(h), point: h.point }))];
  const m = points.length * 3;
  const evaluate = (u) => {
    const { p, d } = resolveParams(part, { ...base, ...space.valuesOf(u) });
    const r = new Float64Array(m);
    points.forEach(({ ref, point }, i) => {
      const o = locate(part, p, d, ref);
      const w = i === 0 ? 1 : HOLD_WEIGHT;
      for (let c = 0; c < 3; c++) r[3 * i + c] = w * (o[c] - point[c]);
    });
    return r;
  };
  let lambda;
  try {
    evaluate(space.u0);
    lambda = limbLength(resolveParams(part, { ...base, ...space.valuesOf(space.u0) }).d[handle.on]);
  } catch {
    return null;
  }
  const { x, error } = runSolve(space, evaluate, m, { iterations, lambda, tol });
  return { values: keys.length ? space.valuesOf(x) : {}, error };
}

/**
 * The hold weights a generic handle's solve tries in turn. A generic handle's params
 * often move a pinned point exactly as fast as the grabbed one (every rim in a gear train
 * turns at one pitch-line speed, every corner of a box moves with its width), and a
 * least-squares hold gives way by about the miss over the weight squared: at HOLD_WEIGHT
 * a pinned gear would still let the train turn 1% of the way, frame after frame. So when
 * a hold is left more than TOL_MM off its point, the solve runs again from the start
 * with the weight ten times firmer, up to 1000 (a 180 degree pull then leaks 0.0002).
 */
const HOLD_WEIGHTS = [HOLD_WEIGHT, 100, 1000];

/**
 * The starting damping for a generic handle — the role limbLength plays for a limb: the
 * scale of the Jacobian's entries in mm per normalised unit. Rotary: the grab radius
 * (at least 1 mm). Otherwise how far the point moves when every DOF goes from its min to
 * its max (one derive at each end); 1 when a DOF is unbounded or wraps, or either end
 * cannot be read.
 */
function handleSpan(part, base, handle, keys, ranges, target) {
  if (isNum(target?.angleDeg)) return Math.max(1, isNum(target.radius) ? target.radius : 1);
  const ends = [{}, {}];
  for (const k of keys) {
    const r = ranges.get(k);
    if (!r || r.wrap || !isNum(r.min) || !isNum(r.max)) return 1;
    ends[0][k] = r.min;
    ends[1][k] = r.max;
  }
  try {
    const [a, b] = ends.map((e) => {
      const { p, d } = resolveParams(part, { ...base, ...e });
      return locateHandle(part, p, d, handle);
    });
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    return len > 0 ? len : 1;
  } catch {
    return 1;
  }
}

/**
 * Solve a generic handle's (`on` / `point`, or a limb handle read through locateHandle)
 * listed parameters so its point reaches `target` while every hold (as solveAngles) stays
 * at its point. `target` is `{ point: [x, y, z] }` for a point, axis or plane drag (the
 * caller has already put it on the line or plane), or `{ angleDeg, axis: { origin,
 * direction }, radius }` for a rotary drag: the point's angle about the axis
 * (angleAbout's convention) should be `angleDeg`. The rotary residual is two numbers in
 * mm — radius × the wrapped angle miss (-180..180, so a full turn never reads as a step
 * backwards), and the point's travel along the axis since the start of the solve (so a
 * slide cannot fake a turn) — and so weighs against a hold as a point's would.
 *
 * Returns `{ values, error }` (error: the weighted residual norm, mm) or null when the
 * start pose cannot be read. A frame whose derive or `point` throws scores FAILED, so the
 * drag holds the last readable values. Holds are firmed up as HOLD_WEIGHTS says.
 */
export function solveHandle({ part, params, handle, target, holds = [], allHandles = [handle], iterations = 8, tol = TOL_MM }) {
  const base = { ...part.defaults, ...params };
  const keys = dofsOf(handle, allHandles, base);
  const ranges = rangesOf(part);
  const space = dofSpace(ranges, base, keys);
  const rotary = isNum(target?.angleDeg) && target.axis;
  const pins = holds.map((h) => ({ ref: refOf(h), point: h.point }));
  const lead = rotary ? 2 : 3;
  const m = lead + pins.length * 3;
  const at = (u) => {
    const { p, d } = resolveParams(part, { ...base, ...space.valuesOf(u) });
    return { p, d, o: locateHandle(part, p, d, handle) };
  };
  let start;
  try { start = at(space.u0).o; } catch { return null; }
  let n = null, radius = 1;
  if (rotary) {
    const dir = target.axis.direction;
    const len = Math.hypot(dir[0], dir[1], dir[2]);
    n = [dir[0] / len, dir[1] / len, dir[2] / len];
    radius = isNum(target.radius) && target.radius > 0 ? target.radius : 1;
  }
  const evaluate = (u, w) => {
    const { p, d, o } = at(u);
    const r = new Float64Array(m);
    if (rotary) {
      r[0] = radius * ((wrapTo180(angleAbout(o, target.axis) - target.angleDeg) * Math.PI) / 180);
      r[1] = (o[0] - start[0]) * n[0] + (o[1] - start[1]) * n[1] + (o[2] - start[2]) * n[2];
    } else {
      for (let c = 0; c < 3; c++) r[c] = o[c] - target.point[c];
    }
    pins.forEach(({ ref, point }, i) => {
      const q = locate(part, p, d, ref);
      for (let c = 0; c < 3; c++) r[lead + 3 * i + c] = w * (q[c] - point[c]);
    });
    return r;
  };
  try { evaluate(space.u0, HOLD_WEIGHT); } catch { return null; }
  const lambda = handleSpan(part, base, handle, keys, ranges, target);
  /** The farthest any hold sits off its point at u, in mm (Infinity when unreadable). */
  const slip = (u) => {
    let r;
    try { r = evaluate(u, 1); } catch { return Infinity; }
    let worst = 0;
    for (let i = 0; i < pins.length; i++) worst = Math.max(worst, Math.hypot(r[lead + 3 * i], r[lead + 3 * i + 1], r[lead + 3 * i + 2]));
    return worst;
  };
  let out;
  for (const w of pins.length ? HOLD_WEIGHTS : [HOLD_WEIGHT]) {
    out = runSolve(space, (u) => evaluate(u, w), m, { iterations, lambda, tol });
    if (!pins.length || slip(out.x) <= TOL_MM) break;
  }
  return { values: keys.length ? space.valuesOf(out.x) : {}, error: out.error };
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
  const posed = posedLimb(part, params, handle?.on);
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

// ---- joint rings ------------------------------------------------------------------
// A ring turns ONE joint (forward kinematics) by writing the parameter that drives it:
// a goal handle's seed entry (joint order, a ball taking three), or an angles handle's
// `joints` entry. These are the pure halves: which joints have a ring, and what a turn
// writes.

const BALL_SLOTS = ["bend", "spread", "twist"];
/** The ring a hinge shows: its axis kind's (bend red, spread blue, twist green); a vector axis shows bend's. */
const hingeSlot = (joint) => (joint.axisKind === "spread" || joint.axisKind === "twist" ? joint.axisKind : "bend");
const isDirection = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum) && v.some((c) => c !== 0);

/**
 * A `joints` key split into its limb (a key of derive's result; null: the handle's own) and
 * joint name, at the LAST "." — "palm.wristPitch" is limb "palm", joint "wristPitch".
 */
export function parseJointKey(key) {
  const s = String(key);
  const i = s.lastIndexOf(".");
  return i < 0 ? { limb: null, joint: s } : { limb: s.slice(0, i), joint: s.slice(i + 1) };
}

/**
 * A `joints` entry as `{ slot: { param, scale } }`: a parameter name (scale 1), `{ param,
 * scale? }` for a hinge driven by scale × param, or `{ bend?, spread?, twist? }` (parameter
 * names) for a ball. Null when malformed (lint reports it).
 */
export function jointEntrySlots(entry, joint) {
  if (typeof entry === "string") return joint.type === "ball" ? null : { [hingeSlot(joint)]: { param: entry, scale: 1 } };
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  if (joint.type === "ball") {
    const out = {};
    for (const k of BALL_SLOTS) if (typeof entry[k] === "string") out[k] = { param: entry[k], scale: 1 };
    return Object.keys(out).length ? out : null;
  }
  if (typeof entry.param !== "string") return null;
  const scale = entry.scale ?? 1;
  return isNum(scale) && scale !== 0 ? { [hingeSlot(joint)]: { param: entry.param, scale } } : null;
}

/** Every parameter a locked handle drives: its params and its `joints` entries (a ring writing one is not shown). */
function lockedParams(handles, p) {
  const out = new Set();
  for (const h of handles) {
    if (h?.lock == null || !p[h.lock]) continue;
    for (const k of Array.isArray(h.params) ? h.params : []) out.add(k);
    if (h.joints && typeof h.joints === "object") {
      for (const e of Object.values(h.joints)) {
        if (typeof e === "string") out.add(e);
        else if (e && typeof e === "object") for (const v of Object.values(e)) if (typeof v === "string") out.add(v);
      }
    }
  }
  return out;
}

/** A slot's range in joint degrees: a hinge's range; a ball's bend and spread within its cone, twist free. */
const slotRange = (joint, slot) => (joint.type === "ball"
  ? (slot === "twist" ? [-Infinity, Infinity] : [-joint.cone, joint.cone])
  : [...joint.range]);

/**
 * The joint rings the handles `ids` offer, from each limb's ikInfo (`infoOf(limbKey)`, null
 * when it has none): `[{ limb (derive's key), joint, handleId, mode, slots: { ring: { param,
 * scale, range, component } } }]`, one entry per joint (the first handle naming it wins).
 * `ring` is the joint gizmo's ring name (bend, spread or twist); `component` is the ball
 * value's key, null for a hinge; `range` is in joint degrees. A goal handle maps its `seed`
 * (driven joints in order, followers skipped, a ball taking three); an angles handle maps its
 * `joints`. A slot whose parameter a locked handle drives is left out.
 */
export function jointRings({ part, params, ids, infoOf }) {
  const handles = part?.handles && typeof part.handles === "object" ? part.handles : {};
  const base = { ...part?.defaults, ...params };
  const locked = lockedParams(Object.values(handles), base);
  const out = [];
  const seen = new Set();
  const add = (limbKey, joint, handleId, mode, slots) => {
    const key = `${limbKey}\u0000${joint.name}`;
    if (seen.has(key) || joint.follower) return;
    const kept = {};
    for (const [ring, s] of Object.entries(slots)) {
      if (locked.has(s.param)) continue;
      kept[ring] = { ...s, range: slotRange(joint, ring), component: joint.type === "ball" ? ring : null };
    }
    if (!Object.keys(kept).length) return;
    seen.add(key);
    out.push({ limb: limbKey, joint: joint.name, handleId, mode, slots: kept });
  };
  for (const handleId of ids) {
    const h = handles[handleId];
    if (!h || typeof h !== "object") continue;
    if (h.drag === "goal" && Array.isArray(h.seed) && h.seed.length) {
      const info = infoOf(h.on);
      if (!info) continue;
      let k = 0;
      for (const j of info.joints) {
        if (j.follower) continue;
        if (j.type === "ball") {
          const slots = {};
          BALL_SLOTS.forEach((ring, c) => { if (typeof h.seed[k + c] === "string") slots[ring] = { param: h.seed[k + c], scale: 1 }; });
          k += 3;
          add(h.on, j, handleId, "goal", slots);
        } else {
          if (typeof h.seed[k] === "string") add(h.on, j, handleId, "goal", { [hingeSlot(j)]: { param: h.seed[k], scale: 1 } });
          k += 1;
        }
      }
    } else if (h.drag === "angles" && h.joints && typeof h.joints === "object" && !Array.isArray(h.joints)) {
      for (const [key, entry] of Object.entries(h.joints)) {
        const { limb, joint } = parseJointKey(key);
        const limbKey = limb ?? h.on;
        const info = infoOf(limbKey);
        const j = info?.joints.find((x) => x.name === joint);
        const slots = j && jointEntrySlots(entry, j);
        if (slots) add(limbKey, j, handleId, "angles", slots);
      }
    }
  }
  return out;
}

/** A joint's exact posed value at these params (a ball's one component), or null. */
export function posedJointValue(part, params, limbKey, joint, component = null) {
  const posed = posedLimb(part, params, limbKey);
  if (!posed) return null;
  let joints;
  try { joints = posed.ikInfo().joints; } catch { return null; }
  const i = joints.findIndex((j) => j.name === joint);
  const v = i < 0 ? undefined : posed.values?.[i];
  const out = component ? v?.[component] : v;
  return isNum(out) ? out : null;
}

/** The ball component (or hinge value) a coupled value array holds for joint `i`. */
const valueAt = (values, i, component) => (component ? values?.[i]?.[component] : values?.[i]);
/** Two joint values the same, to rounding (a cone clamp scales both swing components). */
const same = (a, b) => isNum(a) && isNum(b) && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));

/** A ball's partial override or a hinge's value for joint `j` at `value` of `component`. */
const overrideOf = (component, value) => (component ? { [component]: value } : value);

/**
 * A goal handle's writes for a forward-kinematics pose: `overrides` (`{ joint: value }`, a
 * ball's partial `{ bend?, spread?, twist? }`) on the posed limb. Returns `{ values (every
 * seed parameter, then the goal at the posed `at` frame), goalClamped (a goal parameter's
 * schema range clipped it), F (the ikForward result) }`, or null when FK throws.
 */
function goalFromForward({ part, params, handle, posed, info, overrides, ranges }) {
  let F;
  try {
    F = posed.ikForward(overrides, typeof handle.at === "string" ? handle.at : "tip");
  } catch {
    return null;
  }
  const flat = [];
  info.joints.forEach((j, i) => {
    if (j.follower) return;
    const v = F.values[i];
    if (j.type === "ball") flat.push(v.bend, v.spread, v.twist);
    else flat.push(v);
  });
  const seed = {};
  (handle.seed ?? []).forEach((k, i) => { if (typeof k === "string" && i < flat.length && isNum(flat[i])) seed[k] = clamp(flat[i], ranges.get(k)); });
  const aim = handle.params?.aim;
  let aimAngles = null;
  if (Array.isArray(aim) && aim.length >= 2 && isDirection(handle.toward)) {
    const cur = (k) => (isNum(params[k]) ? params[k] : part.defaults?.[k]);
    const r = ranges.get(aim[0]);
    const a = anglesFromAim(handle.toward, { aim: F.y, up: aim.length >= 3 ? F.z : null }, {
      near: { pitch: cur(aim[0]), yaw: cur(aim[1]) },
      pitchRange: r && isNum(r.min) && isNum(r.max) ? [r.min, r.max] : null,
    });
    aimAngles = [a.pitch, a.yaw, a.roll];
  }
  // the goal as the turned pose has it, and as the schema lets it be written
  const want = goalValues({ handle, point: F.origin, aimAngles });
  const goal = goalValues({ handle, point: F.origin, aimAngles, part });
  const goalClamped = Object.keys(want).some((k) => !same(want[k], goal[k]));
  return { values: { ...goal, ...seed }, goalClamped, F };
}

/** One goal-mode turn: the values it writes, and whether a goal parameter's schema range clipped the turned pose. */
function goalTurn({ ring, s, value, info, ...rest }) {
  const out = goalFromForward({ ...rest, info, overrides: { [ring.joint]: overrideOf(s.component, value) } });
  if (!out) return null;
  const i = info.joints.findIndex((j) => j.name === ring.joint);
  return { values: out.values, goalClamped: out.goalClamped, coupled: valueAt(out.F.values, i, s.component) };
}

/**
 * The orientation residual's weight, mm per unit of direction difference (about mm per
 * radian): an aim ring held against pins trades this many mm of goal point for a radian of aim.
 */
const AIM_WEIGHT_MM = 100;
/**
 * A hold's weight in a goal drag (solveGoalPinned): firmer than HOLD_WEIGHT, since the goal
 * point routinely runs far past what the pinned limb can reach (the elbow pinned leaves the
 * arm four joints for a six-number goal), and a least-squares hold gives way by about the
 * miss over the weight squared — 0.35 mm for a 36 mm miss at 10, 0.004 mm at 100.
 */
const GOAL_HOLD_WEIGHT = 100;

/**
 * A goal-mode drag that holds pins: solve the handle's seeded joints (forward kinematics on
 * the posed limb, its `ikForward` — derive's own goal solve would pull the limb straight to
 * the goal and ignore the pins) so the goal point `at` reaches `target` while each hold
 * `{ limb, at, point }` on the handle's limb stays at its point (GOAL_HOLD_WEIGHT). With
 * `aimAngles` (an aim ring's pitch/yaw/roll) the goal frame's +Y and, with three aim params,
 * +Z are pulled toward that aim as well (AIM_WEIGHT_MM), and `target` is the goal point to
 * keep. Holds on other limbs are not in this residual.
 *
 * Writes what a joint ring writes (goalFromForward): every seed parameter at the solved
 * pose, and the goal parameters rewritten to the posed `at` frame — so the next derive's
 * goal solve starts at its answer and lands on this pose. A goal value the schema would clip
 * stops the pose at the last fraction of the way from the current pose whose goal fits
 * (bisected, as jointRingValues). Returns `{ values, error }` (error: the weighted residual
 * norm, mm) or null when the limb cannot be read.
 */
export function solveGoalPinned({ part, params, handle, target, holds = [], aimAngles = null, iterations = 8, tol = TOL_MM }) {
  const posed = posedLimb(part, params, handle?.on);
  if (!posed || typeof posed.ikForward !== "function" || !Array.isArray(handle.seed)) return null;
  let info;
  try { info = posed.ikInfo(); } catch { return null; }
  const ranges = rangesOf(part);
  const at = typeof handle.at === "string" ? handle.at : "tip";
  // One DOF per seed entry: the joint (and a ball's component) it drives, in joint degrees.
  const dofs = [];
  let k = 0;
  info.joints.forEach((j, i) => {
    if (j.follower) return;
    const comps = j.type === "ball" ? BALL_SLOTS : [null];
    comps.forEach((component, c) => {
      const param = handle.seed[k + c];
      if (typeof param !== "string") return;
      const start = valueAt(posed.values, i, component);
      if (!isNum(start)) return;
      const r = ranges.get(param);
      const range = slotRange(j, component ?? "bend");
      const lo = Math.max(range[0], isNum(r?.min) ? r.min : -Infinity);
      const hi = Math.min(range[1], isNum(r?.max) ? r.max : Infinity);
      dofs.push({ joint: j.name, component, start: Math.min(hi, Math.max(lo, start)), lo, hi });
    });
    k += comps.length;
  });
  if (!dofs.length) return null;
  // x = offset + scale * u: u in [0, 1] over a finite range (as solveAngles), else raw degrees
  const finite = (d) => isNum(d.lo) && isNum(d.hi) && d.hi > d.lo;
  const offset = dofs.map((d) => (finite(d) ? d.lo : 0));
  const scale = dofs.map((d) => (finite(d) ? d.hi - d.lo : 1));
  const lo = dofs.map((d) => (finite(d) ? 0 : d.lo));
  const hi = dofs.map((d) => (finite(d) ? 1 : d.hi));
  const u0 = dofs.map((d, i) => (d.start - offset[i]) / scale[i]);
  const overridesOf = (u) => {
    const o = {};
    dofs.forEach((d, i) => {
      const v = offset[i] + scale[i] * Math.min(hi[i], Math.max(lo[i], u[i]));
      if (d.component) o[d.joint] = { ...(o[d.joint] ?? {}), [d.component]: v };
      else o[d.joint] = v;
    });
    return o;
  };
  let aim = null;
  if (Array.isArray(aimAngles) && isDirection(handle.toward)) {
    const [pitch = 0, yaw = 0, roll] = aimAngles;
    const t = aimTurn(handle.toward, { pitch, yaw, roll: handle.params?.aim?.length >= 3 ? roll ?? 0 : undefined });
    aim = { y: t.aim, z: handle.params?.aim?.length >= 3 ? t.up : null };
  }
  const own = holds.filter((h) => h?.limb === handle.on && Array.isArray(h.point));
  const m = 3 + (aim ? (aim.z ? 6 : 3) : 0) + own.length * 3;
  const residuals = (u) => {
    const r = new Float64Array(m);
    try {
      const o = overridesOf(u);
      const F = posed.ikForward(o, at);
      let n = 0;
      for (let c = 0; c < 3; c++) r[n++] = F.origin[c] - target[c];
      if (aim) {
        for (let c = 0; c < 3; c++) r[n++] = AIM_WEIGHT_MM * (F.y[c] - aim.y[c]);
        if (aim.z) for (let c = 0; c < 3; c++) r[n++] = AIM_WEIGHT_MM * (F.z[c] - aim.z[c]);
      }
      for (const h of own) {
        const p = posed.ikForward(o, h.at).origin;
        for (let c = 0; c < 3; c++) r[n++] = GOAL_HOLD_WEIGHT * (p[c] - h.point[c]);
      }
    } catch {
      r.fill(FAILED);
    }
    return r;
  };
  const { x, error } = solveDLS({ x0: u0, lo, hi, residuals, iterations, h: H, lambda: limbLength(posed), tol });
  const args = { part, params, handle, posed, info, ranges };
  const solved = overridesOf(x);
  const write = goalFromForward({ ...args, overrides: solved });
  if (!write) return null;
  if (!write.goalClamped) return { values: write.values, error };
  // Stop at the last fraction of the way from the current pose whose goal fits.
  const at01 = (t) => overridesOf(u0.map((v, i) => v + (x[i] - v) * t));
  const start = goalFromForward({ ...args, overrides: at01(0) });
  if (!start || start.goalClamped) return { values: {}, error };
  let a = 0, b = 1, best = start;
  for (let n = 0; n < 24; n++) {
    const mid = (a + b) / 2;
    const t = goalFromForward({ ...args, overrides: at01(mid) });
    if (t && !t.goalClamped) { a = mid; best = t; } else b = mid;
  }
  return { values: best.values, error };
}

/**
 * What turning one joint to `value` (joint degrees, already in its range) writes:
 * `{ values, clamped }`, or null when the limb cannot be read. `clamped` is true when the
 * joint could not go all the way to `value`: a parameter's schema range, a ball's cone,
 * or (goal mode) a goal parameter's range.
 *
 * Angles mode: the slot's parameter, value / scale, clamped to its schema range.
 *
 * Goal mode (`ring.handleId` the goal handle): every seed parameter at the turned pose —
 * forward kinematics from the posed limb (its `ikForward`), the other joints as posed —
 * and the goal parameters at the posed `at` frame: position its origin, aim pitch/yaw/roll
 * (anglesFromAim, from the handle's `toward`, nearest the current aim parameters) its +Y
 * and, with three aim parameters, +Z. The next derive's goal solve then starts at its
 * answer, so the limb stays where the turn put it. A goal value the schema would clip
 * (the tool below its lowest Z) cannot be written as the pose has it, and the solve would
 * pull the limb away, spreading the turn over the other joints: the joint stops instead
 * at the last value whose goal fits (bisected from the current pose), and reports clamped.
 */
export function jointRingValues({ part, params, ring, slot, value }) {
  const s = ring.slots[slot];
  if (!s || !isNum(value)) return null;
  const ranges = rangesOf(part);
  if (ring.mode !== "goal") {
    const raw = value / s.scale;
    const written = clamp(raw, ranges.get(s.param));
    let clamped = !same(written, raw);
    if (s.component) {
      // a ball: bend and spread share one cone (couple scales the swing down)
      const posed = posedLimb(part, params, ring.limb);
      try {
        const i = posed.ikInfo().joints.findIndex((j) => j.name === ring.joint);
        const F = posed.ikForward({ [ring.joint]: { [s.component]: written * s.scale } });
        if (!same(valueAt(F.values, i, s.component), written * s.scale)) clamped = true;
      } catch { /* no posed limb: no cone to read */ }
    }
    return { values: { [s.param]: written }, clamped };
  }
  const handle = part.handles?.[ring.handleId];
  const posed = posedLimb(part, params, handle?.on);
  if (!posed || typeof posed.ikForward !== "function") return null;
  let info;
  try { info = posed.ikInfo(); } catch { return null; }
  const args = { part, params, handle, posed, info, ring, s, ranges };
  const turn = goalTurn({ ...args, value });
  if (!turn) return null;
  if (!turn.goalClamped) return { values: turn.values, clamped: !same(turn.coupled, value) };
  // Stop at the last value whose goal fits, between the current pose and `value`.
  const i = info.joints.findIndex((j) => j.name === ring.joint);
  let lo = valueAt(posed.values, i, s.component);
  if (!isNum(lo)) return null;
  const start = goalTurn({ ...args, value: lo });
  if (!start || start.goalClamped) return { values: {}, clamped: true }; // already outside: hold still
  let hi = value, best = start;
  for (let k = 0; k < 24; k++) {
    const mid = (lo + hi) / 2;
    const t = goalTurn({ ...args, value: mid });
    if (t && !t.goalClamped) { lo = mid; best = t; } else hi = mid;
  }
  return { values: best.values, clamped: true };
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
