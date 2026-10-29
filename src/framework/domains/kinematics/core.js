// limb(name, def): forward kinematics for one jointed chain, emitting plain
// core-shaped frames. Structure once, pose as often as needed.
import { buildTree, jointSteps, failer, couple, farEnd, nearZero } from "./tree.js";
import { buildFrames, buildReport, buildAdapters } from "./outputs.js";
import { solveReach } from "./solve.js";
import { IDENTITY, resolveFrames } from "../../geometry/xform.js";

const POSE_KEYS = new Set(["bend", "curl", "spread", "twist", "reach", "grip"]);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);
const GRIP_KEYS = new Set(["around", "clearance", "r"]);

/** Throw when any node of `around` names a frame (Ruling 4: shapes are in part coordinates). */
function noFrames(node, fail) {
  if (Array.isArray(node)) { for (const c of node) noFrames(c, fail); return; }
  if (node == null || typeof node !== "object") return;
  if (Object.hasOwn(node, "frame")) fail("grip.around", 'shapes are in part coordinates; drop "frame"');
  for (const v of Object.values(node)) noFrames(v, fail);
}

/** Validate a pose's grip options: `{ around, radii, clearance }`. The solve arrives with Task A3. */
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
  if (typeof around !== "function") noFrames(around, fail);
  return { around, radii, clearance };
}

/** Raw driven-joint values for a pose's bend/curl (followers and clamping come later, in `couple`). */
function rawValues(tree, opts, fail) {
  const { joints } = tree;
  const raw = new Array(joints.length).fill(0);
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
    bend.forEach((v, n) => {
      if (!isNum(v)) fail(`bend[${n}]`, "must be a finite number");
      raw[driven[n]] = v;
    });
  } else if (bend != null) {
    if (typeof bend !== "object") fail("bend", "must be an array of driven-joint values or { joint: value }");
    for (const [k, v] of Object.entries(bend)) {
      const i = joints.findIndex((j) => j.name === k);
      if (i < 0) fail(`bend.${k}`, `unknown joint "${k}"`);
      const f = joints[i].follow;
      if (f) fail(`bend.${k}`, `${k} follows ${joints[f.index].name} and takes no value`);
      if (!isNum(v)) fail(`bend.${k}`, "must be a finite number");
      raw[i] = v;
    }
  }

  return raw;
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

  function pose(opts = {}, frames) {
    if (opts == null || typeof opts !== "object") fail("", "pose needs an options object");
    for (const k of Object.keys(opts)) if (!POSE_KEYS.has(k)) fail(k, `unknown pose option "${k}"`);
    if (frames != null && typeof frames !== "object") fail("", "pose frames must be a { name: frame } object");
    if (opts.reach != null && opts.grip != null) fail("", "use reach or grip, not both");
    for (const k of ["spread", "twist"]) if (opts[k] != null && !isNum(opts[k])) fail(k, "must be a finite number");
    let spread = opts.spread ?? 0;
    const twist = opts.twist ?? 0;
    if (tree.base.rotate && (spread !== 0 || twist !== 0)) fail("", "spread/twist need toward/bendToward, not rotate");

    const raw = rawValues(tree, opts, fail);
    let values, clamped, reach = null;
    if (opts.reach != null) {
      if (!isVec3(opts.reach)) fail("reach", "must be [x, y, z]");
      if (tree.parent != null && frames == null) fail("", "reach needs the frames declared so far — pass them as pose(…, frames)");
      const solved = solveReach(tree, parentWorld(frames), opts.reach, raw, { spread, twist }, fail);
      ({ values, clamped, spread } = solved);
      reach = { target: opts.reach, residual: solved.residual, status: solved.status };
    } else if (opts.grip != null) {
      gripInputs(tree, opts.grip, fail);
      fail("grip", "not implemented");
    } else ({ values, clamped } = couple(tree, raw));
    const posedFrames = buildFrames(tree, jointSteps(tree, values, { spread, twist }));
    const report = buildReport(tree, values, clamped, posedFrames, frames, fail, reach);
    const adapters = buildAdapters(tree, posedFrames, frames, fail);
    return { values, frames: posedFrames, joints: [...jointFrames], tip, report, ...adapters };
  }

  return { name, joints: [...jointFrames], tip, pose };
}
