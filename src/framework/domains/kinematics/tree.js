// The limb's structure: validated joints, the base aim and mirror, and the
// per-frame rotate steps for a set of joint values. Pure and deterministic.
//
// Frame convention (spec "Words for orientation"): each segment lies along its
// frame's +Y; local Z is the part of −bendToward at right angles to toward; X = Y × Z;
// a bend of θ is a rotation of −θ about local X.
import { hypot3 } from "../../geometry/js-math.js";
import { SpecError } from "../../geometry/errors.js";
import { axisAngle } from "../../geometry/rotations.js";
import { compose, rotation, axisVector, IDENTITY } from "../../geometry/xform.js";

const AXIS_KINDS = { bend: [1, 0, 0], spread: [0, 0, 1], twist: [0, 1, 0] };
const MIRRORS = { YZ: 0, XZ: 1, XY: 2 };
const DEFAULT_RANGE = [-10, 100];
const PARALLEL_EPS = 1e-6;
const JOINT_KEYS = new Set(["name", "axis", "length", "range", "follow", "type", "offset", "cone"]);
const BALL_KEYS = new Set(["bend", "spread", "twist"]);
const BALL_REST = Object.freeze({ bend: 0, spread: 0, twist: 0 });
const DEF_KEYS = new Set(["parent", "at", "toward", "bendToward", "rotate", "joints", "lengths", "r", "mirror"]);

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);

/** An error-throwing helper bound to one limb: fail("lengths", "…") → `limb "x".lengths: …`. */
export function failer(name) {
  return (field, msg) => {
    throw new SpecError(field ? `limb "${name}".${field}: ${msg}` : `limb "${name}": ${msg}`);
  };
}

/** Validate a limb definition and resolve it into its joint tree. */
export function buildTree(name, def) {
  if (typeof name !== "string" || name === "") throw new SpecError("limb: name must be a non-empty string");
  const fail = failer(name);
  if (def == null || typeof def !== "object") fail("", "needs a definition object");
  for (const k of Object.keys(def)) if (!DEF_KEYS.has(k)) fail(k, `unknown option "${k}"`);

  if (def.parent != null && (typeof def.parent !== "string" || def.parent === "")) fail("parent", "must be a frame name");
  const at = def.at ?? [0, 0, 0];
  if (!isVec3(at)) fail("at", "must be [x, y, z]");

  let mirrorAxis = null;
  if (def.mirror != null) {
    if (!Object.hasOwn(MIRRORS, def.mirror)) fail("mirror", 'must be "XY", "XZ" or "YZ"');
    mirrorAxis = MIRRORS[def.mirror];
  }
  const reflect = (v) => (mirrorAxis == null ? [...v] : v.map((c, i) => (i === mirrorAxis ? -c + 0 : c)));

  // Base orientation: toward/bendToward, or the rotate escape hatch.
  const base = { aim: null, aimStep: null, rotate: null };
  const hasAim = def.toward != null || def.bendToward != null;
  if (def.rotate != null) {
    if (hasAim) fail("rotate", "use rotate or toward/bendToward, not both");
    if (mirrorAxis != null) fail("", "mirror needs toward/bendToward, not rotate");
    const steps = Array.isArray(def.rotate) ? def.rotate : [def.rotate];
    steps.forEach((s, i) => {
      if (s == null || typeof s !== "object") fail(`rotate[${i}]`, "must be { axis, deg }");
      if (s.deg != null && !isNum(s.deg)) fail(`rotate[${i}].deg`, "must be a finite number");
    });
    base.rotate = steps.map((s) => ({ ...s }));
  } else {
    if (!isVec3(def.toward) || hypot3(...def.toward) === 0) fail("toward", "must be a non-zero [x, y, z]");
    if (!isVec3(def.bendToward) || hypot3(...def.bendToward) === 0) fail("bendToward", "must be a non-zero [x, y, z]");
    const t = reflect(def.toward), b = reflect(def.bendToward);
    const tl = hypot3(t[0], t[1], t[2]);
    const Y = [t[0] / tl, t[1] / tl, t[2] / tl];
    const d = b[0] * Y[0] + b[1] * Y[1] + b[2] * Y[2];
    const bp = [b[0] - d * Y[0], b[1] - d * Y[1], b[2] - d * Y[2]];
    const bpl = hypot3(bp[0], bp[1], bp[2]);
    if (!(bpl >= PARALLEL_EPS * hypot3(b[0], b[1], b[2]))) fail("bendToward", "must not be parallel to toward");
    const Z = [-bp[0] / bpl, -bp[1] / bpl, -bp[2] / bpl];
    const X = [Y[1] * Z[2] - Y[2] * Z[1], Y[2] * Z[0] - Y[0] * Z[2], Y[0] * Z[1] - Y[1] * Z[0]];
    // Columns X, Y, Z; layout [r00 r01 r02 r10 …].
    base.aim = Float64Array.of(X[0], Y[0], Z[0], X[1], Y[1], Z[1], X[2], Y[2], Z[2], 0, 0, 0);
    base.aimStep = axisAngle(base.aim);
  }

  // Joints.
  if (!Array.isArray(def.joints) || def.joints.length === 0) fail("joints", "must be a non-empty array");
  const n = def.joints.length;
  if (def.lengths != null) {
    if (!Array.isArray(def.lengths)) fail("lengths", `must be an array of ${n} lengths`);
    if (def.lengths.length !== n) fail("lengths", `expected ${n} entries, got ${def.lengths.length}`);
  }
  if (def.r != null) {
    if (!Array.isArray(def.r)) fail("r", `must be an array of ${n + 1} radii`);
    if (def.r.length !== n + 1) fail("r", `expected ${n + 1} entries (one per joint, then the tip), got ${def.r.length}`);
    def.r.forEach((v, i) => { if (!isNum(v) || v < 0) fail(`r[${i}]`, "must be a finite number ≥ 0"); });
  }

  const index = new Map();
  const balls = new Set();
  const joints = def.joints.map((entry, i) => {
    const path = `joints[${i}]`;
    const j = typeof entry === "string" ? { name: entry } : entry;
    if (j == null || typeof j !== "object" || Array.isArray(j)) fail(path, "must be a name or { name, … }");
    for (const k of Object.keys(j)) if (!JOINT_KEYS.has(k)) fail(`${path}.${k}`, `unknown option "${k}"`);
    if (typeof j.name !== "string" || j.name === "") fail(`${path}.name`, "must be a non-empty string");
    if (j.name === "tip") fail(`${path}.name`, '"tip" is the limb\'s end frame; pick another name');
    if (index.has(j.name)) fail(`${path}.name`, `duplicate joint "${j.name}"`);

    const type = j.type ?? "hinge";
    if (type !== "hinge" && type !== "ball") fail(`${path}.type`, 'must be "hinge" or "ball"');

    let axis = null, axisKind, range = null, cone = null;
    if (type === "ball") {
      // A ball turns about any axis through its centre: no axis, and a cone, not a range.
      if (j.axis != null) fail(`${path}.axis`, "a ball joint has no axis (it turns about any axis)");
      if (j.range != null) fail(`${path}.range`, "a ball joint takes cone (its largest swing, in degrees), not range");
      if (j.follow != null) fail(`${path}.follow`, "a ball joint cannot follow another joint");
      cone = j.cone ?? 180;
      if (!isNum(cone) || cone <= 0 || cone > 180) fail(`${path}.cone`, "must be a number of degrees > 0 and ≤ 180");
      axisKind = "ball";
    } else {
      if (j.cone != null) fail(`${path}.cone`, 'only a ball joint takes cone — add type: "ball"');
      const a = j.axis ?? "bend";
      if (typeof a === "string" && Object.hasOwn(AXIS_KINDS, a)) { axis = [...AXIS_KINDS[a]]; axisKind = a; }
      else if (isVec3(a) && hypot3(a[0], a[1], a[2]) > 0) {
        const l = hypot3(a[0], a[1], a[2]);
        axis = [a[0] / l, a[1] / l, a[2] / l]; axisKind = "vector";
      } else fail(`${path}.axis`, 'must be "bend", "spread", "twist" or a non-zero [x, y, z]');

      range = j.range ?? DEFAULT_RANGE;
      if (!Array.isArray(range) || range.length !== 2 || !isNum(range[0]) || !isNum(range[1]) || range[0] > range[1]) {
        fail(`${path}.range`, "must be [min, max] with min ≤ max");
      }
      range = [range[0], range[1]];
    }

    // offset: where this joint sits, in the previous joint's frame, relative to the end of the
    // previous segment ([0, previous length, 0]). Mirrored, its local x flips (the frames are
    // rebuilt right-handed, so local X is the reflection of −X).
    let offset = null;
    if (j.offset != null) {
      if (i === 0) fail(`${path}.offset`, "the base joint has no previous joint — place it with the limb's at");
      if (!isVec3(j.offset)) fail(`${path}.offset`, "must be [x, y, z]");
      offset = mirrorAxis == null ? [...j.offset] : [-j.offset[0] + 0, j.offset[1], j.offset[2]];
    }

    let length = j.length;
    const listed = def.lengths?.[i];
    if (length != null && listed != null && length !== listed) fail(`${path}.length`, `${length} conflicts with lengths[${i}] = ${listed}`);
    length ??= listed;
    if (length == null) fail(`${path}.length`, "missing — give the joint a length, or pass lengths");
    if (!isNum(length) || length < 0) fail(`${path}.length`, "must be a finite number ≥ 0");

    let follow = null;
    if (j.follow != null) {
      const f = j.follow;
      if (typeof f !== "object") fail(`${path}.follow`, "must be { joint, ratio?, offset? }");
      if (!index.has(f.joint)) fail(`${path}.follow.joint`, `unknown or later joint ${JSON.stringify(f.joint)}`);
      if (balls.has(f.joint)) fail(`${path}.follow.joint`, `${f.joint} is a ball joint; a joint can follow only a hinge`);
      const ratio = f.ratio ?? 1, offset = f.offset ?? 0;
      if (!isNum(ratio)) fail(`${path}.follow.ratio`, "must be a finite number");
      if (!isNum(offset)) fail(`${path}.follow.offset`, "must be a finite number");
      follow = { index: index.get(f.joint), ratio, offset };
    }

    index.set(j.name, i);
    if (type === "ball") balls.add(j.name);
    return { name: j.name, frame: `${name}.${j.name}`, axis, axisKind, range, cone, follow, length, offset, type };
  });

  return { name, parent: def.parent ?? null, at: reflect(at), base, mirrorAxis, joints, r: def.r ? [...def.r] : null };
}

/**
 * One joint's rotate step for `value` (degrees), or null when the value is 0.
 * Mirrored: a vector axis [ax, ay, az] by θ becomes [−ax, ay, az] by −θ, which
 * leaves "bend" unchanged and flips "spread" and "twist".
 */
function jointStep(joint, value, mirrored) {
  if (joint.type === "ball") return ballSteps(value, mirrored);
  if (value === 0) return [];
  return [mirrorStep(joint.axis, joint.axisKind === "bend" ? -value : value, mirrored)];
}

function mirrorStep([ax, ay, az], deg, mirrored) {
  if (!mirrored) return { axis: [ax, ay, az], deg: deg + 0 };
  return { axis: [-ax + 0, ay, az], deg: -deg + 0 };
}

/**
 * A ball's steps for `{ bend, spread, twist }`: ONE swing — the segment tilts by
 * √(bend² + spread²) degrees about the axis (−bend, 0, spread) in the joint's frame, so a bend
 * alone tilts exactly as a hinge bend does and a spread alone exactly as a spread joint —
 * then the twist about the tilted segment. One swing has no order to get wrong, and its
 * angle is what a cone limits.
 */
function ballSteps({ bend, spread, twist }, mirrored) {
  const steps = [];
  const swing = Math.hypot(bend, spread);
  if (swing !== 0) steps.push(mirrorStep([-bend / swing + 0, 0, spread / swing + 0], swing, mirrored));
  if (twist !== 0) steps.push(mirrorStep([0, 1, 0], twist, mirrored));
  return steps;
}

/**
 * `{ bend, spread, twist }` for a rotation given as rotate steps. Swing–twist decomposition
 * about the segment's +Y: the swing takes +Y to where the steps take it, by the shortest
 * turn; the twist is what is left, about the swung +Y. A swing of 180° has no shortest
 * turn, so it is taken as a bend (about local X).
 */
function ballFromRotate(rotate, field, fail) {
  const steps = Array.isArray(rotate) ? rotate : [rotate];
  let R = IDENTITY;
  steps.forEach((st, i) => {
    const at = Array.isArray(rotate) ? `${field}[${i}]` : field;
    if (st == null || typeof st !== "object" || Array.isArray(st)) fail(at, "must be { axis, deg }");
    for (const k of Object.keys(st)) if (k !== "axis" && k !== "deg") fail(`${at}.${k}`, `unknown option "${k}"`);
    if (st.deg != null && !isNum(st.deg)) fail(`${at}.deg`, "must be a finite number");
    try { axisVector(st.axis ?? "z"); } catch { fail(`${at}.axis`, 'must be "x", "y", "z" or a non-zero [x, y, z]'); }
    R = compose(R, rotation(st.axis ?? "z", st.deg ?? 0));
  });
  // R's columns are the turned frame's axes; its +Y column is where the segment points.
  const [yx, yy, yz] = [R[1], R[4], R[7]];
  const swing = (Math.acos(Math.max(-1, Math.min(1, yy))) * 180) / Math.PI;
  const side = Math.hypot(yx, yz);
  // Unit swing axis ŷ × y' = (yz, 0, −yx) / |…|; at 180° (side ≈ 0) take local X.
  const [ax, az] = side > 1e-12 ? [yz / side, -yx / side] : [1, 0];
  const S = swing === 0 ? IDENTITY : rotation([ax, 0, az], swing);
  // T = S⁻¹ R is a turn about Y alone: [[c, 0, s], [0, 1, 0], [−s, 0, c]].
  const T = compose(Float64Array.of(S[0], S[3], S[6], S[1], S[4], S[7], S[2], S[5], S[8], 0, 0, 0), R);
  const twist = (Math.atan2(T[2], T[0]) * 180) / Math.PI;
  return { bend: -ax * swing + 0, spread: az * swing + 0, twist: twist + 0 };
}

/** A ball value clamped to its cone (bend and spread scaled down together). */
function clampBall(v, cone) {
  const swing = Math.hypot(v.bend, v.spread);
  if (swing <= cone) return { value: { bend: v.bend + 0, spread: v.spread + 0, twist: v.twist + 0 }, clamped: false };
  const k = cone / swing;
  return { value: { bend: v.bend * k + 0, spread: v.spread * k + 0, twist: v.twist + 0 }, clamped: true };
}

/** A joint's rest value: 0 for a hinge, no swing and no twist for a ball. */
export const restValue = (joint) => (joint.type === "ball" ? { ...BALL_REST } : 0);

/**
 * Validate one ball value given to pose: `{ bend?, spread?, twist? }`, absent keys 0, or
 * `{ rotate }` — frame-style steps in the joint's frame, each about the CURRENT axes —
 * turned into the one swing and twist that end in the same orientation.
 */
export function ballValue(v, field, fail) {
  if (v == null || typeof v !== "object" || Array.isArray(v)) fail(field, "a ball joint takes { bend?, spread?, twist? } or { rotate }");
  if (Object.hasOwn(v, "rotate")) {
    for (const k of Object.keys(v)) if (k !== "rotate") fail(`${field}.${k}`, "use rotate or bend/spread/twist, not both");
    return ballFromRotate(v.rotate, `${field}.rotate`, fail);
  }
  for (const k of Object.keys(v)) if (!BALL_KEYS.has(k)) fail(`${field}.${k}`, `unknown ball option "${k}"`);
  const out = { ...BALL_REST };
  for (const k of BALL_KEYS) {
    if (v[k] == null) continue;
    if (!isNum(v[k])) fail(`${field}.${k}`, "must be a finite number");
    out[k] = v[k];
  }
  return out;
}

/**
 * The base frame's steps before its first joint's own: the escape-hatch `rotate`,
 * or the aim, then the pose spread about z, then the pose twist about y (mirror-flipped),
 * zero steps omitted. Shared by `jointSteps` and the reach solver's spread frame.
 */
export function baseSteps(tree, { spread = 0, twist = 0 } = {}) {
  if (tree.base.rotate) return tree.base.rotate.map((s) => ({ ...s }));
  const mirrored = tree.mirrorAxis != null;
  const steps = [];
  const a = tree.base.aimStep;
  if (a) steps.push({ axis: [...a.axis], deg: a.deg });
  const sp = mirrored ? -spread : spread, tw = mirrored ? -twist : twist;
  if (sp !== 0) steps.push({ axis: "z", deg: sp + 0 });
  if (tw !== 0) steps.push({ axis: "y", deg: tw + 0 });
  return steps;
}

/** Every joint frame's rotate steps for these joint values (the base frame first). */
export function jointSteps(tree, values, { spread = 0, twist = 0 } = {}) {
  const mirrored = tree.mirrorAxis != null;
  const out = {};
  tree.joints.forEach((j, i) => {
    const steps = [];
    if (i === 0) steps.push(...baseSteps(tree, { spread, twist }));
    steps.push(...jointStep(j, values[i], mirrored));
    out[j.frame] = steps;
  });
  return out;
}

/**
 * Apply couplings and limits to raw joint values: a follower takes its leader's CLAMPED
 * value × ratio + offset, then every hinge value is clamped to its own range and every ball
 * value to its cone.
 */
export function couple(tree, raw) {
  const { joints } = tree;
  const values = new Array(joints.length), clamped = new Array(joints.length);
  joints.forEach((j, i) => {
    if (j.type === "ball") {
      ({ value: values[i], clamped: clamped[i] } = clampBall(raw[i], j.cone));
      return;
    }
    const want = j.follow ? j.follow.ratio * values[j.follow.index] + j.follow.offset : raw[i];
    const [lo, hi] = j.range;
    const v = want < lo ? lo : want > hi ? hi : want;
    values[i] = v + 0;
    clamped[i] = v !== want;
  });
  return { values, clamped };
}

/** The in-range value nearest 0: a joint's straightest pose. */
export const nearZero = ([lo, hi]) => (lo > 0 ? lo : hi < 0 ? hi : 0);
/** A joint's closing end: range[1], or range[0] when the whole range is negative. */
export const farEnd = ([lo, hi]) => (hi < 0 ? lo : hi);
