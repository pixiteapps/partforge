// Pure rotation converters for the kinematics domain and part authors: deg/rad, Euler <-> frame-style steps,
// applying steps to a Solid, and a matrix -> single axis-angle step.
// Steps are frame-style ({ axis, deg }, each about the CURRENT axes), so a list of
// steps composes as M = R(step1)·R(step2)·… — the same as a frame's `rotate`.
import { IDENTITY, compose, rotation, axisVector } from "./xform.js";
import { hypot3 } from "./js-math.js";
import { SpecError } from "./errors.js";

export const deg = (radians) => (radians * 180) / Math.PI;
export const rad = (degrees) => (degrees * Math.PI) / 180;

const ORDERS = ["XYZ", "XZY", "YXZ", "YZX", "ZXY", "ZYX"];
const EVEN = new Set(["XYZ", "YZX", "ZXY"]);
const AX = { X: 0, Y: 1, Z: 2 };

function checkOrder(order) {
  if (!ORDERS.includes(order)) throw new SpecError(`euler: order is required (one of ${ORDERS.join(", ")})`);
}
function checkFrame(frame) {
  if (frame !== "intrinsic" && frame !== "extrinsic") throw new SpecError('euler: frame is required ("intrinsic" or "extrinsic")');
}
function checkUnits(units) {
  if (units !== "deg" && units !== "rad") throw new SpecError('euler: units must be "deg" or "rad"');
}

/**
 * Euler angles as frame-style steps. `angles[i]` is the turn about axis `order[i]` (scipy/Blender
 * convention). Intrinsic applies them in `order` about the rotating axes; extrinsic about the
 * fixed axes, i.e. the reversed step list.
 */
export function euler({ order, angles, frame, units = "deg" } = {}) {
  checkOrder(order);
  checkFrame(frame);
  checkUnits(units);
  if (!Array.isArray(angles) || angles.length !== 3 || !angles.every((a) => typeof a === "number" && Number.isFinite(a))) {
    throw new SpecError("euler: angles must be three finite numbers");
  }
  const steps = [...order].map((L, i) => ({ axis: L.toLowerCase(), deg: units === "rad" ? deg(angles[i]) : angles[i] }));
  return frame === "extrinsic" ? steps.reverse() : steps;
}

/** Inverse of `euler`: angles in `order` positions (angles[i] about order[i]) for the rotation `steps` compose to. */
export function toEuler(steps, { order, frame, units = "deg" } = {}) {
  checkOrder(order);
  checkFrame(frame);
  checkUnits(units);
  const M = stepsMatrix(steps);
  // M = R_i(a)·R_j(b)·R_k(c) for the intrinsic order (i, j, k); extrinsic is the reverse.
  const eff = frame === "intrinsic" ? order : [...order].reverse().join("");
  const i = AX[eff[0]], j = AX[eff[1]], k = AX[eff[2]];
  const s = EVEN.has(eff) ? 1 : -1;
  const m = (r, c) => M[3 * r + c];
  const sb = Math.max(-1, Math.min(1, s * m(i, k)));
  const b = Math.asin(sb);
  let a, c;
  if (Math.abs(sb) < 1 - 1e-12) {
    a = Math.atan2(-s * m(j, k), m(k, k));
    c = Math.atan2(-s * m(i, j), m(i, i));
  } else {
    a = Math.atan2(s * m(k, j), m(j, j));
    c = 0;
  }
  const out = [0, 0, 0];
  out[i] = a; out[j] = b; out[k] = c;
  return [...order].map((L) => (units === "rad" ? out[AX[L]] : deg(out[AX[L]])) + 0);
}

/** The composed rotation of frame-style steps (3×4, zero translation). */
export function stepsMatrix(steps) {
  let M = IDENTITY;
  for (const s of steps) M = compose(M, rotation(s.axis ?? "z", s.deg ?? 0));
  return M;
}

/**
 * Apply frame-style steps to anything with `rotate(deg, center, axis)`. Rotations about
 * fixed axes compose in reverse, so the LAST step is applied first.
 */
export function applyRotation(x, steps, center = [0, 0, 0]) {
  for (let n = steps.length - 1; n >= 0; n--) {
    const s = steps[n];
    x = x.rotate(s.deg ?? 0, center, axisVector(s.axis ?? "z"));
  }
  return x;
}

/** The rotation part of a 3×4 as one { axis, deg } step, or null for the identity. */
export function axisAngle(M) {
  const r00 = M[0], r01 = M[1], r02 = M[2], r10 = M[3], r11 = M[4], r12 = M[5], r20 = M[6], r21 = M[7], r22 = M[8];
  const tr = r00 + r11 + r22;
  let w, x, y, z;
  // Shepperd: branch on the largest of trace, r00, r11, r22 so the divisor stays large.
  if (tr >= r00 && tr >= r11 && tr >= r22) {
    const S = Math.sqrt(Math.max(0, 1 + tr)) * 2;
    w = S / 4; x = (r21 - r12) / S; y = (r02 - r20) / S; z = (r10 - r01) / S;
  } else if (r00 >= r11 && r00 >= r22) {
    const S = Math.sqrt(Math.max(0, 1 + r00 - r11 - r22)) * 2;
    w = (r21 - r12) / S; x = S / 4; y = (r01 + r10) / S; z = (r02 + r20) / S;
  } else if (r11 >= r22) {
    const S = Math.sqrt(Math.max(0, 1 + r11 - r00 - r22)) * 2;
    w = (r02 - r20) / S; x = (r01 + r10) / S; y = S / 4; z = (r12 + r21) / S;
  } else {
    const S = Math.sqrt(Math.max(0, 1 + r22 - r00 - r11)) * 2;
    w = (r10 - r01) / S; x = (r02 + r20) / S; y = (r12 + r21) / S; z = S / 4;
  }
  if (w < 0) { w = -w; x = -x; y = -y; z = -z; }
  const v = hypot3(x, y, z);
  const angle = deg(2 * Math.atan2(v, w));
  if (angle < 1e-12) return null;
  return { axis: [x / v, y / v, z / v], deg: angle };
}
