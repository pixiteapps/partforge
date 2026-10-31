// Goals for a limb: damped least squares in joint space, posing any joint or the tip toward a
// position, an aim and an up. Pure and deterministic: fixed iteration count, no clock.
import { compose } from "../../geometry/xform.js";
import { hypot3 } from "../../geometry/js-math.js";
import { SpecError } from "../../geometry/errors.js";
import { solveDLS } from "../../solve/dls.js";
import { couple } from "./tree.js";
import { forwardLocal } from "./solve.js";

/** DLS iterations per solve, warm-started from the pose's raw values. */
const ITERATIONS = 64;
/** Direction residuals are unit-vector differences × this: 1° ≈ 1.75 mm of position error. */
const AIM_SCALE = 100;
/** A goal is reached within these: position residual (mm) and aim residual (degrees). */
const REACHED_MM = 0.01;
const REACHED_DEG = 0.1;
/** Rounding slack on the too-far test (mm): a target exactly at full stretch is not too far. */
const DIST_EPS = 1e-9;
const DEG = 180 / Math.PI;
const GOAL_KEYS = new Set(["at", "position", "aim", "up", "weight"]);

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => { const l = hypot3(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
/** The angle between two unit vectors, degrees (atan2 of |a × b| and a · b: exact near 0). */
const angleDeg = (a, b) => { const c = cross(a, b); return Math.atan2(hypot3(c[0], c[1], c[2]), dot(a, b)) * DEG; };

/**
 * Validate a pose's `goals` and `pins` into `{ goals, pinned }`. Each goal becomes
 * `{ at, frame, index, position, aim, up, weight }`: `at` as given, `frame` its frame name,
 * `index` the joint index (the tip is `joints.length`), `aim` and `up` unit vectors or null —
 * an `up` given with an `aim` is taken at right angles to it. `at` is a joint name, its frame
 * name, or "tip". `pinned` is the set of pinned joint indices; pinning a follower is allowed
 * and changes nothing (it never was a DOF).
 */
export function goalInputs(tree, goals, pins, fail) {
  const { joints, name } = tree;
  if (!Array.isArray(goals)) fail("goals", "must be an array of { at, position?, aim?, up?, weight? }");
  const indexOf = (s) => {
    if (s === "tip" || s === `${name}.tip`) return joints.length;
    return joints.findIndex((j) => j.name === s || j.frame === s);
  };
  const out = goals.map((g, i) => {
    const path = `goals[${i}]`;
    if (g == null || typeof g !== "object" || Array.isArray(g)) fail(path, "must be { at, position?, aim?, up?, weight? }");
    for (const k of Object.keys(g)) if (!GOAL_KEYS.has(k)) fail(`${path}.${k}`, `unknown goal option "${k}"`);
    const index = typeof g.at === "string" ? indexOf(g.at) : -1;
    if (index < 0) fail(`${path}.at`, `unknown joint ${JSON.stringify(g.at)}`);
    if (g.position == null && g.aim == null && g.up == null) fail(path, "needs position, aim or up");
    if (g.position != null && !isVec3(g.position)) fail(`${path}.position`, "must be [x, y, z]");
    for (const k of ["aim", "up"]) {
      if (g[k] != null && !(isVec3(g[k]) && hypot3(...g[k]) > 0)) fail(`${path}.${k}`, "must be a non-zero [x, y, z]");
    }
    const weight = g.weight ?? 1;
    if (!isNum(weight) || weight <= 0) fail(`${path}.weight`, "must be a finite number > 0");
    const aim = g.aim != null ? unit(g.aim) : null;
    let up = g.up != null ? unit(g.up) : null;
    if (up && aim) {
      const d = dot(up, aim), p = [up[0] - d * aim[0], up[1] - d * aim[1], up[2] - d * aim[2]];
      if (!(hypot3(p[0], p[1], p[2]) > 1e-6)) fail(`${path}.up`, "must not be parallel to aim");
      up = unit(p);
    }
    const frame = index === joints.length ? `${name}.tip` : joints[index].frame;
    return { at: g.at, frame, index, position: g.position ? [...g.position] : null, aim, up, weight };
  });
  const pinned = new Set();
  if (pins != null) {
    if (!Array.isArray(pins)) fail("pins", "must be an array of joint names");
    pins.forEach((p, i) => {
      const j = joints.findIndex((jt) => jt.name === p || jt.frame === p);
      if (j < 0) fail(`pins[${i}]`, `unknown joint ${JSON.stringify(p)}`);
      pinned.add(j);
    });
  }
  return { goals: out, pinned };
}

/**
 * The solve's degrees of freedom: one per driven, unpinned hinge (its range as bounds) and three
 * per unpinned ball — bend and spread within ±cone (couple then clamps the swing to the cone),
 * twist unbounded. Followers are never DOFs: `couple` expands them from their leaders.
 */
function dofsOf(tree, pinned) {
  const dofs = [];
  tree.joints.forEach((j, i) => {
    if (j.follow || pinned.has(i)) return;
    if (j.type === "ball") {
      dofs.push({ i, key: "bend", lo: -j.cone, hi: j.cone });
      dofs.push({ i, key: "spread", lo: -j.cone, hi: j.cone });
      dofs.push({ i, key: "twist", lo: -Infinity, hi: Infinity });
    } else dofs.push({ i, key: null, lo: j.range[0], hi: j.range[1] });
  });
  return dofs;
}

/**
 * One goal's misses in a posed world: `residual` (mm, 0 for a goal with no position),
 * `aimDeg` (the larger of the aim and up misses, degrees; undefined with neither) and `err`,
 * the unweighted norm of its residual rows — the measure "better met alone" compares.
 */
function missOf(goal, W) {
  let residual = 0, aimDeg, sq = 0;
  if (goal.position) {
    const d = [W[9] - goal.position[0], W[10] - goal.position[1], W[11] - goal.position[2]];
    residual = hypot3(d[0], d[1], d[2]);
    sq += residual * residual;
  }
  const dir = (v, want) => {
    const deg = angleDeg(v, want);
    aimDeg = Math.max(aimDeg ?? 0, deg);
    const e = hypot3(v[0] - want[0], v[1] - want[1], v[2] - want[2]) * AIM_SCALE;
    sq += e * e;
  };
  if (goal.aim) dir([W[1], W[4], W[7]], goal.aim);
  if (goal.up) dir([-W[2], -W[5], -W[8]], goal.up);
  return { residual, aimDeg, err: Math.sqrt(sq) };
}

/**
 * Pose the limb toward `goals` (validated by `goalInputs`; positions and directions in part
 * coordinates, never reflected). `parentWorld` is the parent frame's world transform; `raw`
 * the pose's driven values, the warm start and the value of every joint the solve does not
 * move; `pinned` the pinned joint indices; `spread`/`twist` the pose-level angles, kept as given.
 *
 * Damped least squares (`solveDLS`, ITERATIONS steps) over `dofsOf`. Residual rows per goal,
 * each × its weight: a position adds 3 (tip − target, mm); an aim adds 3, (frame +Y − aim) ×
 * AIM_SCALE; an up adds 3 the same way on the frame's −Z (the side `bendToward` names).
 *
 * Status, per goal: `reached` when its position residual is ≤ REACHED_MM and its aim residual
 * ≤ REACHED_DEG; else `too-far` when its position lies beyond the sum of segment lengths from
 * the first moving joint (a joint that is a DOF or follows one) to its frame, measured from
 * that joint; else `conflict` when there are two or more goals and it alone is better met
 * (its `err` lower by more than REACHED_MM) solved on its own from the same start; else
 * `out-of-range`.
 *
 * `clamped` is `couple`'s for the final raw values: solved values lie in their ranges, so it
 * marks a pinned (or unsolved) value outside its range, a follower driven past its own, and a
 * ball pushed beyond its cone. Returns `{ values, clamped, goals: [{ at, residual, aimResidual?, status }] }`.
 */
export function solveGoals(tree, parentWorld, goals, raw, pinned, { spread = 0, twist = 0 } = {}) {
  const { joints } = tree;
  const n = joints.length;
  const dofs = dofsOf(tree, pinned);
  const x0 = Float64Array.from(dofs, (d) => (d.key ? raw[d.i][d.key] : raw[d.i]));
  const lo = Float64Array.from(dofs, (d) => d.lo);
  const hi = Float64Array.from(dofs, (d) => d.hi);

  const rawFor = (x) => {
    const r = raw.slice();
    dofs.forEach((d, k) => {
      if (d.key == null) r[d.i] = x[k];
      else { if (r[d.i] === raw[d.i]) r[d.i] = { ...raw[d.i] }; r[d.i][d.key] = x[k]; }
    });
    return r;
  };
  const worldAt = (x) => {
    const F = forwardLocal(tree, couple(tree, rawFor(x)).values, { spread, twist });
    return (frame) => compose(parentWorld, F(frame));
  };
  const residualsFor = (set) => {
    const m = set.reduce((s, g) => s + (g.position ? 3 : 0) + (g.aim ? 3 : 0) + (g.up ? 3 : 0), 0);
    return (x) => {
      const W = worldAt(x);
      const out = new Float64Array(m);
      let o = 0;
      for (const g of set) {
        const M = W(g.frame), w = g.weight;
        if (g.position) for (let c = 0; c < 3; c++) out[o++] = (M[9 + c] - g.position[c]) * w;
        if (g.aim) for (let c = 0; c < 3; c++) out[o++] = (M[1 + 3 * c] - g.aim[c]) * AIM_SCALE * w;
        if (g.up) for (let c = 0; c < 3; c++) out[o++] = (-M[2 + 3 * c] - g.up[c]) * AIM_SCALE * w;
      }
      return out;
    };
  };
  const solve = (set) => (dofs.length === 0 || set.length === 0
    ? Float64Array.from(x0)
    : solveDLS({ x0, lo, hi, residuals: residualsFor(set), iterations: ITERATIONS }).x);

  const x = solve(goals);
  const W = worldAt(x);
  const final = couple(tree, rawFor(x));

  // The first moving joint and the segment lengths from it: the reach the too-far test reads.
  const moving = new Array(n).fill(false);
  for (const d of dofs) moving[d.i] = true;
  joints.forEach((j, i) => { if (j.follow && moving[j.follow.index]) moving[i] = true; });
  const first = moving.indexOf(true);
  const segment = (k) => {
    const o = joints[k + 1]?.offset ?? [0, 0, 0];
    return hypot3(o[0], joints[k].length + o[1], o[2]);
  };
  const tooFar = (g) => {
    if (!g.position || first < 0 || first >= g.index) return false;
    let len = 0;
    for (let k = first; k < g.index; k++) len += segment(k);
    const B = W(joints[first].frame);
    return hypot3(g.position[0] - B[9], g.position[1] - B[10], g.position[2] - B[11]) > len + DIST_EPS;
  };

  const report = goals.map((g) => {
    const miss = missOf(g, W(g.frame));
    let status;
    if (miss.residual <= REACHED_MM && !(miss.aimDeg > REACHED_DEG)) status = "reached";
    else if (tooFar(g)) status = "too-far";
    else if (goals.length >= 2 && missOf(g, worldAt(solve([g]))(g.frame)).err < miss.err - REACHED_MM) status = "conflict";
    else status = "out-of-range";
    const entry = { at: g.at, residual: miss.residual };
    if (miss.aimDeg !== undefined) entry.aimResidual = miss.aimDeg;
    entry.status = status;
    return entry;
  });
  return { values: final.values, clamped: final.clamped, goals: report };
}

/**
 * Pitch, yaw and roll in degrees → `{ aim, up? }` unit vectors, the convention a part's aim
 * parameters and the viewer's rotate rings share. Zero is `toward`; yaw turns about part +Z;
 * pitch then turns about the yawed horizontal axis at right angles to the aim, positive lifting
 * the aim toward `up`; `roll`, when given, turns `up` about the aim and `up` is returned. `up`
 * starts as part +Z taken at right angles to `toward`, or as +Y when `toward` is vertical.
 */
export function aimFromAngles(opts) {
  const fail = (msg) => { throw new SpecError(`aimFromAngles: ${msg}`); };
  if (opts == null || typeof opts !== "object") fail("needs { toward, pitch?, yaw?, roll? }");
  for (const k of Object.keys(opts)) if (!["toward", "pitch", "yaw", "roll"].includes(k)) fail(`unknown option "${k}"`);
  const { toward, pitch = 0, yaw = 0, roll } = opts;
  if (!isVec3(toward) || !(hypot3(...toward) > 0)) fail("toward must be a non-zero [x, y, z]");
  for (const [k, v] of [["pitch", pitch], ["yaw", yaw], ["roll", roll ?? 0]]) if (!isNum(v)) fail(`${k} must be a finite number`);

  let aim = unit(toward);
  const vertical = hypot3(aim[0], aim[1], 0) <= 1e-9;
  let up = vertical ? [0, 1, 0] : [0, 0, 1];
  const d = dot(up, aim);
  up = unit([up[0] - d * aim[0], up[1] - d * aim[1], up[2] - d * aim[2]]);
  // Rodrigues: v turned by deg about the unit axis k.
  const turn = (v, k, deg) => {
    const t = deg / DEG, c = Math.cos(t), s = Math.sin(t), kv = cross(k, v), kd = dot(k, v) * (1 - c);
    return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
  };
  const Z = [0, 0, 1];
  aim = turn(aim, Z, yaw); up = turn(up, Z, yaw);
  const axis = unit(cross(aim, up));
  aim = turn(aim, axis, pitch); up = turn(up, axis, pitch);
  if (roll == null) return { aim };
  return { aim, up: turn(up, aim, roll) };
}
