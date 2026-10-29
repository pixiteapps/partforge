// Goal solvers for a limb: they find joint values, then hand them to the same forward
// step `pose` uses (jointSteps → buildFrames → resolveFrames). Pure and deterministic:
// fixed iteration counts, no clock.
import { compose, invert, rotation, resolveFrames, xformPoint, xformDir } from "../../geometry/xform.js";
import { hypot3 } from "../../geometry/js-math.js";
import { jointSteps, baseSteps, couple, farEnd, nearZero } from "./tree.js";
import { buildFrames } from "./outputs.js";

const BISECT_STEPS = 60;
const DEG = 180 / Math.PI;
/**
 * Rounding slack on solved angles: a pitch or spread this close to a range end is snapped
 * onto it (no clamp, no out-of-range), and the escape-hatch base's spread this close to 0
 * counts as none. A target posed exactly at a range end must still read "reached": the
 * bisection resolves s only to ~1e-8 where d(s) is flat (near s = 0), about 1e-6° of pitch.
 */
const ANGLE_EPS_DEG = 1e-5;
/** Rounding slack on the distance tests (mm): a target exactly at d(0) or d(1) is reachable. */
const DIST_EPS = 1e-9;
/** `v` snapped onto [lo, hi] when within ANGLE_EPS_DEG of it; otherwise unchanged. */
const snap = (v, lo, hi) => (v < lo && v >= lo - ANGLE_EPS_DEG ? lo : v > hi && v <= hi + ANGLE_EPS_DEG ? hi : v);

/**
 * The limb's forward kinematics relative to its parent frame: exactly the frames `pose`
 * emits, resolved with the base's parent dropped. Returns frame name → 3×4.
 */
export function forwardLocal(tree, values, { spread = 0, twist = 0 } = {}) {
  const frames = buildFrames(tree, jointSteps(tree, values, { spread, twist }));
  const first = tree.joints[0].frame;
  const { parent: _parent, ...base } = frames[first];
  const W = resolveFrames({ ...frames, [first]: base });
  return (name) => W.get(name).world;
}

const origin = (M) => [M[9], M[10], M[11]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const pointIn = (M, p) => { const o = [0, 0, 0]; xformPoint(o, invert(M), p[0], p[1], p[2]); return o; };

/**
 * The aim joints (Ruling 10): the first driven bend joint (the pitch) and the first driven
 * spread joint before it, if any. Every segment before the pitch must have length 0, and
 * no joint may follow an aim joint — its value would move with the aim.
 */
function aimJoints(tree, fail) {
  const { joints } = tree;
  const pitch = joints.findIndex((j) => !j.follow && j.axisKind === "bend");
  if (pitch < 0) fail("", "reach needs a driven bend joint to aim with");
  for (let i = 0; i < pitch; i++) if (joints[i].length !== 0) fail("", "reach needs the limb's first bend joint at its base");
  const spreadJoint = joints.findIndex((j, i) => i < pitch && !j.follow && j.axisKind === "spread");
  const aims = new Set([pitch, spreadJoint]);
  joints.forEach((j, i) => {
    if (j.follow && aims.has(j.follow.index)) {
      fail(`joints[${i}].follow`, `reach sets "${joints[j.follow.index].name}" to aim the limb, so "${j.name}" cannot follow it — follow a later joint`);
    }
  });
  const distal = [];
  joints.forEach((j, i) => { if (i > pitch && !j.follow && j.axisKind === "bend") distal.push(i); });
  return { pitch, spreadJoint, distal };
}

/**
 * Place the limb's tip on `target` (part coordinates; never reflected — Ruling 4).
 * `parentWorld` is the parent frame's world transform; `raw` the pose's driven values
 * (the joints reach does not solve keep them); `spread`/`twist` the pose-level angles.
 *
 * Distance: the distal driven bend joints move together from the in-range value nearest 0
 * (s = 0) to the closing end (s = 1), followers following, and a 60-step bisection matches the pitch-joint-to-tip distance. Aim: the pitch about X keeps
 * the tip's component along the spread axis equal to the target's, then the spread about
 * that axis swings it on. The spread axis is P's Z seen from the pitch frame (n), so pose
 * twist or zero-length joints between spread and pitch are solved through, not ignored;
 * with none, n = +Z and this is the brief's v_z = w_z construction exactly.
 * Statuses: too-far / too-close (Ruling 5) win over out-of-range.
 */
export function solveReach(tree, parentWorld, target, raw, { spread = 0, twist = 0 } = {}, fail) {
  const { joints } = tree;
  const mirrored = tree.mirrorAxis != null;
  const { pitch, spreadJoint, distal } = aimJoints(tree, fail);
  const poseSpreads = spreadJoint < 0;
  const tipFrame = `${tree.name}.tip`;
  const pitchFrame = joints[pitch].frame;

  // A trial pass: aim joints at 0, distal bend joints at a0 + s·(a1 − a0), followers coupled.
  // a0 is the in-range value nearest 0 and a1 the closing end (range[1], or range[0] for an all-negative range), so s = 0 is as
  // straight as the joint allows and s = 1 its fullest curl — on [-10, 100] that is 0 → 100.
  const spans = distal.map((i) => {
    const a0 = nearZero(joints[i].range);
    return [i, a0, farEnd(joints[i].range) - a0];
  });
  const trialRaw = (s) => {
    const r = raw.slice();
    for (const [i, a0, da] of spans) r[i] = a0 + s * da;
    return r;
  };
  const trialValues = (s) => {
    const { values } = couple(tree, trialRaw(s));
    values[pitch] = 0;
    if (spreadJoint >= 0) values[spreadJoint] = 0;
    return values;
  };
  const trialSpread = poseSpreads ? 0 : spread;
  const trial = (s) => forwardLocal(tree, trialValues(s), { spread: trialSpread, twist });
  const tipAt = (s) => { const F = trial(s); return pointIn(F(pitchFrame), origin(F(tipFrame))); };

  // K: the pitch joint's frame with the aim at 0. P: the frame the spread turns about.
  const F0 = trial(0);
  const K = F0(pitchFrame);
  let P;
  if (poseSpreads) {
    // The base frame's own steps with no spread or twist: the frame the pose spread turns about.
    P = resolveFrames({ base: { at: tree.at, rotate: baseSteps(tree) } }).get("base").world;
  } else P = F0(joints[spreadJoint].frame);
  const n = [0, 0, 0];
  xformDir(n, invert(K), P[2], P[5], P[8]);

  const local = pointIn(parentWorld, target);
  const w = pointIn(K, local);
  const dw = hypot3(w[0], w[1], w[2]);

  // Distance.
  let s, status = null;
  if (dw === 0) { s = 1; status = "too-close"; }
  else if (dw > hypot3(...tipAt(0)) + DIST_EPS) { s = 0; status = "too-far"; }
  else if (dw < hypot3(...tipAt(1)) - DIST_EPS) { s = 1; status = "too-close"; }
  else {
    let lo = 0, hi = 1;
    for (let k = 0; k < BISECT_STEPS; k++) {
      const mid = (lo + hi) / 2;
      if (hypot3(...tipAt(mid)) > dw) lo = mid;
      else hi = mid;
    }
    s = (lo + hi) / 2;
  }

  // The final forward pass: the same frames `pose` emits, and the residual it leaves.
  const finish = (r, outSpread, outOfRange) => {
    const { values, clamped } = couple(tree, r);
    const W = compose(parentWorld, forwardLocal(tree, values, { spread: outSpread, twist })(tipFrame));
    const tip = origin(W);
    const residual = hypot3(tip[0] - target[0], tip[1] - target[1], tip[2] - target[2]);
    return { values, clamped, spread: outSpread, outOfRange, residual, tip };
  };

  // A target at the base has no direction: the aim keeps its given values.
  if (dw === 0) return result(finish(trialRaw(s), spread, false), status);

  const t = tipAt(s);
  const scale = hypot3(t[0], t[1], t[2]) / dw;
  const ws = [w[0] * scale, w[1] * scale, w[2] * scale]; // the target pulled to the tip's distance

  // Aim, for one branch of the pitch (sign +1 is the brief's v_y = +sqrt).
  const aim = (sign) => {
    const r = trialRaw(s);
    let outSpread = spread, outOfRange = false;
    const m = hypot3(0, n[1], n[2]);
    let want = raw[pitch];
    if (m === 0) outOfRange = true; // the spread axis lies along the pitch axis: the pitch cannot aim
    else {
      const ny = n[1] / m, nz = n[2] / m, a = (dot(n, ws) - n[0] * t[0]) / m;
      let rad = t[1] * t[1] + t[2] * t[2] - a * a;
      if (rad < 0) { rad = 0; outOfRange = true; }
      const h = sign * Math.sqrt(rad);
      const vy = a * ny + h * nz, vz = a * nz - h * ny;
      want = -Math.atan2(t[1] * vz - t[2] * vy, t[1] * vy + t[2] * vz) * DEG + 0;
    }
    const [plo, phi] = joints[pitch].range;
    want = snap(want, plo, phi);
    const pitchVal = want < plo ? plo : want > phi ? phi : want;
    if (pitchVal !== want) outOfRange = true;
    r[pitch] = want;

    // Spread: the angle about n taking the tip (at the clamped pitch) to the target.
    const u = [0, 0, 0];
    xformDir(u, rotation("x", -pitchVal), t[0], t[1], t[2]);
    const cx = u[1] * ws[2] - u[2] * ws[1], cy = u[2] * ws[0] - u[0] * ws[2], cz = u[0] * ws[1] - u[1] * ws[0];
    const phiDeg = Math.atan2(dot(n, [cx, cy, cz]), dot(u, ws) - dot(n, u) * dot(n, ws)) * DEG;
    let value = (mirrored ? -phiDeg : phiDeg) + 0;
    if (!poseSpreads) {
      const [slo, shi] = joints[spreadJoint].range;
      value = snap(value, slo, shi);
      if (value < slo || value > shi) outOfRange = true;
      r[spreadJoint] = value;
    } else if (tree.base.rotate) {
      if (Math.abs(value) > ANGLE_EPS_DEG) outOfRange = true; // the escape-hatch base cannot spread
    } else outSpread = value;
    return finish(r, outSpread, outOfRange);
  };

  // Two pitches put the tip at the target's height along the spread axis; the second (the
  // far side of the pole, swung round by the spread) is taken only when the first needs a
  // joint outside its range and the second does not — or, both out, when it lands closer.
  const first = aim(1);
  if (!first.outOfRange) return result(first, status);
  const second = aim(-1);
  return result(!second.outOfRange || second.residual < first.residual ? second : first, status);
}

/** Above this residual (mm) a solve never reads "reached" — the spec's no-silent-miss rule. */
const REACHED_TOL = 0.01;

function result({ values, clamped, spread, outOfRange, residual, tip }, status) {
  // Defensive: the construction should land within REACHED_TOL whenever nothing clamps, but
  // if some case it does not foresee leaves the tip off the target, say so rather than
  // report a miss as "reached".
  status ??= outOfRange || !(residual <= REACHED_TOL) ? "out-of-range" : "reached";
  return { values, clamped, spread, status, residual, tip };
}
