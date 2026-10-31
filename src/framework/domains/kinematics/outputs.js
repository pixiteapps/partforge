// A posed limb's plain-data outputs: its frames and its report.
import { resolveFrames, compose, invert } from "../../geometry/xform.js";
import { hypot3 } from "../../geometry/js-math.js";
import { axisAngle } from "../../geometry/rotations.js";
import { jointSteps, restValue } from "./tree.js";

/** Round to 0.001 with −0 written as 0 (the frame report's convention). */
export const r3 = (v) => { const x = Math.round(v * 1000) / 1000; return x === 0 ? 0 : x; };
/** A joint value rounded for the report: a hinge's number, or a ball's `{ bend, spread, twist }`. */
const roundValue = (v) => (typeof v === "number" ? r3(v) : { bend: r3(v.bend), spread: r3(v.spread), twist: r3(v.twist) });

/** One frame per joint plus `${name}.tip`, as `{ parent?, at, rotate? }`. A joint's `at` is the previous segment's end plus its own `offset`. */
export function buildFrames(tree, steps) {
  const frames = {};
  tree.joints.forEach((j, i) => {
    const f = {};
    if (i === 0) {
      if (tree.parent != null) f.parent = tree.parent;
      f.at = [...tree.at];
    } else {
      f.parent = tree.joints[i - 1].frame;
      const o = j.offset ?? [0, 0, 0];
      f.at = [o[0], tree.joints[i - 1].length + o[1], o[2]];
    }
    const s = steps[j.frame];
    if (s && s.length) f.rotate = s;
    frames[j.frame] = f;
  });
  const last = tree.joints[tree.joints.length - 1];
  frames[`${tree.name}.tip`] = { parent: last.frame, at: [0, last.length, 0] };
  return frames;
}

/**
 * `{ bend, clamped, tip?, reach?, grip?, goals? }`. `tip` is in part coordinates, so it needs the
 * parent's frames (`frames`) when the limb has a parent; it is omitted otherwise. `reach` is
 * `{ target, residual, status }` and `grip` is `{ touching, gap, joints: [{ joint, bend,
 * touched, skipped }] }` (the final pose's whole-limb verdict, read first, then one entry per driven
 * bend joint), each present only when the pose asked for one. `goals` is one
 * `{ at, residual, aimResidual?, status }` per goal, `aimResidual` only for a goal with an aim or up.
 */
export function buildReport(tree, values, clamped, posedFrames, frames, fail, reach = null, grip = null, goals = null) {
  const report = { bend: values.map(roundValue), clamped: [...clamped] };
  if (tree.parent == null || frames != null) {
    const all = frames == null ? posedFrames : { ...frames, ...posedFrames };
    if (tree.parent != null && !Object.hasOwn(frames, tree.parent)) fail("parent", `unknown frame "${tree.parent}"`);
    const W = resolveFrames(all).get(`${tree.name}.tip`).world;
    report.tip = [r3(W[9]), r3(W[10]), r3(W[11])];
  }
  if (reach) report.reach = { target: reach.target.map(r3), residual: r3(reach.residual), status: reach.status };
  if (grip) {
    report.grip = {
      touching: grip.touching, gap: r3(grip.gap),
      joints: grip.joints.map(({ joint, value, touched, skipped }) => ({ joint, bend: r3(value), touched, skipped })),
    };
  }
  if (goals) {
    report.goals = goals.map(({ at, residual, aimResidual, status }) =>
      (aimResidual === undefined ? { at, residual: r3(residual), status } : { at, residual: r3(residual), aimResidual: r3(aimResidual), status }));
  }
  return report;
}

const PLACE_FROM = new Set(["joint", "rest"]);

/**
 * The adapters of one posed limb: world and place for solids. `frames` are the parent frames
 * passed to `pose`; `restFrames` every frame of the chain at rest (`place`'s `from: "rest"`).
 */
export function buildAdapters(tree, posedFrames, frames, restFrames, fail, values) {
  const { name, joints } = tree;
  const base = joints[0].frame, tip = `${name}.tip`;
  const known = new Set([...joints.map((j) => j.frame), tip]);

  const frameOf = (op, joint) => {
    const frame = joint === "tip" ? tip : known.has(joint) ? joint : `${name}.${joint}`;
    if (!known.has(frame)) fail("", `${op}: unknown joint ${JSON.stringify(joint)}`);
    if (tree.parent != null && frames == null) fail("", `${op} needs the parent frames — pass them as pose(…, frames)`);
    return frame;
  };
  const resolve = (set, frame) => {
    if (tree.parent != null && !Object.hasOwn(set, tree.parent)) fail("parent", `unknown frame "${tree.parent}"`);
    return resolveFrames(set).get(frame).world;
  };
  const worldOf = (op, joint) => resolve(frames == null ? posedFrames : { ...frames, ...posedFrames }, frameOf(op, joint));

  function world(joint = base) {
    const M = worldOf("world", joint);
    const unit = (j) => { const x = M[j], y = M[3 + j], z = M[6 + j], l = hypot3(x, y, z); return [r3(x / l), r3(y / l), r3(z / l)]; };
    return { origin: [r3(M[9]), r3(M[10]), r3(M[11])], x: unit(0), y: unit(1), z: unit(2) };
  }

  function place(x, joint = base, opts = {}) {
    if (opts == null || typeof opts !== "object" || Array.isArray(opts)) fail("", "place: options must be { from }");
    for (const k of Object.keys(opts)) if (k !== "from") fail("", `place: unknown option "${k}"`);
    const from = opts.from ?? "joint";
    if (!PLACE_FROM.has(from)) fail("", 'place: from must be "joint" or "rest"');
    let M = worldOf("place", joint);
    // from: "rest" — the solid was built in part coordinates with the whole chain at rest, so it
    // moves by the joint's rest-to-posed motion: posed ∘ rest⁻¹.
    if (from === "rest") M = compose(M, invert(resolve(restFrames, frameOf("place", joint))));
    const a = axisAngle(M);
    const rotated = a ? x.rotate(a.deg, [0, 0, 0], a.axis) : x;
    return rotated.translate([M[9], M[10], M[11]]);
  }

  /**
   * The posed limb as plain JSON for the viewer (handles, skeleton, limit arcs): joint records,
   * every joint's and the tip's origin in part coordinates, and each hinge's world rotation axis
   * (the direction a positive value turns about). Throws without the parent frames, like `world`.
   */
  function ikInfo() {
    const points = {}, axes = {};
    const origin = (joint) => world(joint).origin;
    joints.forEach((j, i) => {
      points[j.name] = origin(j.frame);
      if (j.type === "ball") return;
      // The hinge's own step is the last in its frame's list, so its axis is unchanged by it.
      const unit = joints.map((_, k) => (k === i ? 1 : 0));
      const step = jointSteps(tree, unit.map((v, k) => (joints[k].type === "ball" ? restValue(joints[k]) : v)))[j.frame].at(-1);
      const sign = step.deg < 0 ? -1 : 1;
      const W = world(j.frame);
      const a = step.axis.map((c) => c * sign);
      axes[j.name] = [0, 1, 2].map((k) => r3(a[0] * W.x[k] + a[1] * W.y[k] + a[2] * W.z[k]));
    });
    points.tip = origin(tip);
    const info = {
      kind: "partforge.limb", name, tip,
      joints: joints.map((j) => {
        const rec = { name: j.name, frame: j.frame, type: j.type };
        if (j.type === "ball") rec.cone = j.cone; else rec.range = [...j.range];
        rec.follower = j.follow != null;
        return rec;
      }),
      points, values: values.map(roundValue), axes,
    };
    if (tree.r) info.r = [...tree.r];
    return info;
  }

  return { world, place, ikInfo };
}
