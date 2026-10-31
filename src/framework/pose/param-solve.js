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
import { anglesFromAim } from "../solve/aim.js";

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
 * FAILED. It stops early once the residual is at most `tol` (default TOL_MM).
 */
export function solveAngles({ part, params, handle, grab, target, holds = [], iterations = 8, allHandles = [handle], tol = TOL_MM }) {
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
  const { x, error } = solveDLS({ x0: u0, lo, hi, residuals, iterations, h: H, lambda, tol });
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
    if (h.mode === "goal" && Array.isArray(h.seed) && h.seed.length) {
      const info = infoOf(h.limb);
      if (!info) continue;
      let k = 0;
      for (const j of info.joints) {
        if (j.follower) continue;
        if (j.type === "ball") {
          const slots = {};
          BALL_SLOTS.forEach((ring, c) => { if (typeof h.seed[k + c] === "string") slots[ring] = { param: h.seed[k + c], scale: 1 }; });
          k += 3;
          add(h.limb, j, handleId, "goal", slots);
        } else {
          if (typeof h.seed[k] === "string") add(h.limb, j, handleId, "goal", { [hingeSlot(j)]: { param: h.seed[k], scale: 1 } });
          k += 1;
        }
      }
    } else if (h.mode === "angles" && h.joints && typeof h.joints === "object" && !Array.isArray(h.joints)) {
      for (const [key, entry] of Object.entries(h.joints)) {
        const { limb, joint } = parseJointKey(key);
        const limbKey = limb ?? h.limb;
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

/** One goal-mode turn: the values it writes, and whether a goal parameter's schema range clipped the turned pose. */
function goalTurn({ part, params, handle, posed, info, ring, s, value, ranges }) {
  let F;
  try {
    F = posed.ikForward({ [ring.joint]: s.component ? { [s.component]: value } : value }, typeof handle.at === "string" ? handle.at : "tip");
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
  const i = info.joints.findIndex((j) => j.name === ring.joint);
  const coupled = valueAt(F.values, i, s.component);
  return { values: { ...goal, ...seed }, goalClamped, coupled };
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
  const posed = posedLimb(part, params, handle?.limb);
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
