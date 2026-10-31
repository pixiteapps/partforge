// limb(name, def): forward kinematics for one jointed chain, emitting plain
// core-shaped frames. Structure once, pose as often as needed.
import { buildTree, jointSteps, failer, couple, farEnd, nearZero, restValue, ballValue } from "./tree.js";
import { buildFrames, buildReport, buildAdapters, r3 } from "./outputs.js";
import { solveReach, solveGrip } from "./solve.js";
import { goalInputs, solveGoals } from "./goals.js";
import { distanceFor } from "./shapes.js";
import { IDENTITY, resolveFrames } from "../../geometry/xform.js";
import { SpecError } from "../../geometry/errors.js";

const POSE_KEYS = new Set(["bend", "curl", "spread", "twist", "reach", "grip", "goals", "pins"]);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);
const GRIP_KEYS = new Set(["around", "clearance", "r"]);

/**
 * Validate a pose's grip options: `{ dist, radii, clearance }`. `dist(x, y, z)` is `around`
 * itself when it is a distance function, else shapes.js's closed form for the node (validated
 * here, once — a `frame` anywhere in it is refused: shapes are in part coordinates). Either
 * way a throw becomes a SpecError naming grip.around (the original as `cause`), and a
 * non-finite value fails with the point it came from.
 */
function gripInputs(tree, grip, fail) {
  if (typeof grip !== "object" || Array.isArray(grip)) fail("grip", "must be { around, clearance?, r? }");
  for (const k of Object.keys(grip)) if (!GRIP_KEYS.has(k)) fail(`grip.${k}`, `unknown grip option "${k}"`);
  const { around, clearance = 0 } = grip;
  if (typeof around !== "function" && (around == null || typeof around !== "object" || Array.isArray(around))) fail("grip.around", "must be a shape node, e.g. { kind: \"cylinder\", r, h, at, axis }, or a distance function");
  if (!isNum(clearance)) fail("grip.clearance", "must be a finite number");
  const radii = grip.r ?? tree.r;
  if (radii == null) fail("", "grip needs r (radius per joint, then the tip)");
  const n = tree.joints.length + 1;
  if (!Array.isArray(radii) || radii.length !== n) fail("grip.r", `expected ${n} entries (one per joint, then the tip), got ${Array.isArray(radii) ? radii.length : radii}`);
  radii.forEach((v, i) => { if (!isNum(v) || v < 0) fail(`grip.r[${i}]`, "must be a finite number ≥ 0"); });
  const base = typeof around === "function" ? around : distanceFor(around, { fail });
  const prefix = `limb "${tree.name}".grip.around`;
  const dist = (x, y, z) => {
    let v;
    try { v = base(x, y, z); } catch (e) {
      const err = new SpecError(`${prefix}: distance function threw — ${e?.message ?? String(e)}`, { field: "grip.around" });
      err.cause = e;
      throw err;
    }
    if (typeof v !== "number" || !Number.isFinite(v)) {
      fail("grip.around", `distance function returned a non-finite value at [${r3(x)}, ${r3(y)}, ${r3(z)}]`);
    }
    return v;
  };
  return { dist, radii, clearance };
}

/** One driven joint's pose value: a number for a hinge, `{ bend?, spread?, twist? }` for a ball. */
function jointValue(joint, v, field, fail) {
  if (joint.type === "ball") return ballValue(v, field, fail);
  if (!isNum(v)) fail(field, "must be a finite number");
  return v;
}

/** Raw driven-joint values for a pose's bend/curl (followers and clamping come later, in `couple`). */
function rawValues(tree, opts, fail) {
  const { joints } = tree;
  const raw = joints.map(restValue);
  const driven = [];
  joints.forEach((j, i) => { if (!j.follow) driven.push(i); });

  const { bend, curl } = opts;
  if (curl != null) {
    if (!isNum(curl) || curl < 0 || curl > 1) fail("curl", "must be a number from 0 to 1");
    // curl sets the bend joints; only an object bend naming the other joints may join it.
    const ok = bend == null || (typeof bend === "object" && !Array.isArray(bend) &&
      Object.keys(bend).every((k) => joints.find((j) => j.name === k)?.axisKind !== "bend"));
    if (!ok) fail("", "use bend or curl, not both");
    for (const i of driven) {
      if (joints[i].axisKind !== "bend") continue;
      const a0 = nearZero(joints[i].range);
      raw[i] = a0 + curl * (farEnd(joints[i].range) - a0);
    }
  }
  if (Array.isArray(bend)) {
    if (bend.length !== driven.length) fail("bend", `expected ${driven.length} entries (driven joints), got ${bend.length}`);
    bend.forEach((v, n) => { raw[driven[n]] = jointValue(joints[driven[n]], v, `bend[${n}]`, fail); });
  } else if (bend != null) {
    if (typeof bend !== "object") fail("bend", "must be an array of driven-joint values or { joint: value }");
    for (const [k, v] of Object.entries(bend)) {
      const i = joints.findIndex((j) => j.name === k);
      if (i < 0) fail(`bend.${k}`, `unknown joint "${k}"`);
      const f = joints[i].follow;
      if (f) fail(`bend.${k}`, `${k} follows ${joints[f.index].name} and takes no value`);
      raw[i] = jointValue(joints[i], v, `bend.${k}`, fail);
    }
  }

  return raw;
}

/**
 * Every posed limb's place among other frames: `all`, the frames it was posed among plus
 * its own, and `rest`, the same frames with every limb in the chain at rest. A posed limb
 * passed to another limb's `pose` stands in for its whole chain this way, and `rest` is
 * what `place(…, { from: "rest" })` measures from.
 */
const CHAINS = new WeakMap();

/**
 * `pose`'s second argument as `{ frames, rest }`: a `{ name: frame }` object (fixed, so it is
 * its own rest), a posed limb (its whole chain, posed and at rest), or an array of them,
 * later entries winning. null when nothing was passed.
 */
function contextOf(arg, fail) {
  if (arg == null) return null;
  let frames = {}, rest = {};
  for (const x of Array.isArray(arg) ? arg : [arg]) {
    const chain = x != null && typeof x === "object" ? CHAINS.get(x) : undefined;
    if (chain) { frames = { ...frames, ...chain.all }; rest = { ...rest, ...chain.rest }; }
    else if (x != null && typeof x === "object" && !Array.isArray(x)) { frames = { ...frames, ...x }; rest = { ...rest, ...x }; }
    else fail("", "pose frames must be a { name: frame } object, a posed limb, or an array of them");
  }
  return { frames, rest };
}

export function limb(name, def) {
  const tree = buildTree(name, def);
  const fail = failer(name);
  const jointFrames = tree.joints.map((j) => j.frame);
  const tip = `${name}.tip`;

  /** The parent frame's world transform in part coordinates (identity for a limb with no parent). */
  function parentWorld(frames) {
    if (tree.parent == null) return IDENTITY;
    if (!Object.hasOwn(frames, tree.parent)) fail("parent", `unknown frame "${tree.parent}"`);
    return resolveFrames(frames).get(tree.parent).world;
  }

  // The limb with every joint at rest: what a link built in part coordinates was built at.
  const restOwn = buildFrames(tree, jointSteps(tree, tree.joints.map(restValue)));

  function pose(opts = {}, parents) {
    if (opts == null || typeof opts !== "object") fail("", "pose needs an options object");
    for (const k of Object.keys(opts)) if (!POSE_KEYS.has(k)) fail(k, `unknown pose option "${k}"`);
    const context = contextOf(parents, fail);
    const frames = context?.frames ?? null;
    if (opts.reach != null && opts.grip != null) fail("", "use reach or grip, not both");
    if (opts.goals != null && (opts.reach != null || opts.grip != null)) fail("", "use one of reach, grip or goals");
    if (opts.pins != null && opts.goals == null) fail("pins", "pins hold joints for goals — pass goals too");
    for (const k of ["spread", "twist"]) if (opts[k] != null && !isNum(opts[k])) fail(k, "must be a finite number");
    let spread = opts.spread ?? 0;
    const twist = opts.twist ?? 0;
    if (tree.base.rotate && (spread !== 0 || twist !== 0)) fail("", "spread/twist need toward/bendToward, not rotate");

    const raw = rawValues(tree, opts, fail);
    let values, clamped, reach = null, grip = null, goals = null;
    if (opts.reach != null) {
      if (!isVec3(opts.reach)) fail("reach", "must be [x, y, z]");
      if (tree.parent != null && frames == null) fail("", "reach needs the frames declared so far — pass them as pose(…, frames)");
      const solved = solveReach(tree, parentWorld(frames), opts.reach, raw, { spread, twist }, fail);
      ({ values, clamped, spread } = solved);
      reach = { target: opts.reach, residual: solved.residual, status: solved.status };
    } else if (opts.grip != null) {
      const { dist, radii, clearance } = gripInputs(tree, opts.grip, fail);
      if (tree.parent != null && frames == null) fail("", "grip needs the frames declared so far — pass them as pose(…, frames)");
      const solved = solveGrip(tree, parentWorld(frames), raw, dist, radii, clearance, { spread, twist });
      ({ values, clamped } = solved);
      grip = {
        joints: solved.joints.map(({ index, touched, skipped }) => ({ joint: tree.joints[index].name, value: values[index], touched, skipped })),
        touching: solved.touching, gap: solved.gap,
      };
    } else if (opts.goals != null) {
      const inputs = goalInputs(tree, opts.goals, opts.pins, fail);
      if (tree.parent != null && frames == null) fail("", "goals needs the frames declared so far — pass them as pose(…, frames)");
      ({ values, clamped, goals } = solveGoals(tree, parentWorld(frames), inputs.goals, raw, inputs.pinned, { spread, twist }));
    } else ({ values, clamped } = couple(tree, raw));
    const posedFrames = buildFrames(tree, jointSteps(tree, values, { spread, twist }));
    const report = buildReport(tree, values, clamped, posedFrames, frames, fail, reach, grip, goals);
    const restFrames = context == null ? restOwn : { ...context.rest, ...restOwn };
    const adapters = buildAdapters(tree, posedFrames, frames, restFrames, fail, values);
    const posed = { values, frames: posedFrames, joints: [...jointFrames], tip, report, ...adapters };
    CHAINS.set(posed, { all: frames == null ? { ...posedFrames } : { ...frames, ...posedFrames }, rest: restFrames });
    return posed;
  }

  return { name, joints: [...jointFrames], tip, pose };
}
