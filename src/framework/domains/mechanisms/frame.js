// The shared maths of the mechanism helpers: input checks, a member's local frame, the
// one rotate + translate that places a solid in it, and plain-JSON points. Pure: no
// geometry is built, and a solid is only ever turned and moved through its own
// `rotate(deg, center, axis)` and `translate(v)`, so a view that places it stays a
// pose the viewer can apply by matrix (no rebuild while a drive angle changes).
import { SpecError } from "../../geometry/errors.js";
import { axisAngle } from "../../geometry/rotations.js";

export const rad = (deg) => (deg * Math.PI) / 180;
export const deg = (r) => (r * 180) / Math.PI;

/** A thrower whose messages all start with the helper's name. */
export const failer = (op) => (field, msg) => { throw new SpecError(`${op}: ${field ? `${field}: ` : ""}${msg}`, { field }); };

const isVec = (v) => Array.isArray(v) && v.length === 3 && v.every((c) => Number.isFinite(c));

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const add = (a, b, s = 1) => [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2]];

/** A finite [x, y, z] (copied), or a throw naming the field. */
export function vec3(fail, field, v) {
  if (!isVec(v)) fail(field, `must be [x, y, z] numbers, got ${JSON.stringify(v)}`);
  return [v[0], v[1], v[2]];
}

/** A unit vector, or a throw for a zero-length one. */
export function unit(fail, field, v) {
  const a = vec3(fail, field, v);
  const l = Math.hypot(a[0], a[1], a[2]);
  if (!(l > 1e-12)) fail(field, "must not be zero length");
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** A finite number (> 0 when `positive`). */
export function num(fail, field, v, { positive = false } = {}) {
  if (!Number.isFinite(v) || (positive && !(v > 0))) fail(field, `must be a ${positive ? "positive " : ""}number, got ${JSON.stringify(v)}`);
  return v;
}

/** A member's name: a non-empty string with no ".", since a point is "<name>.<point>". */
export function memberName(fail, field, v, seen) {
  if (typeof v !== "string" || !v || v.includes(".")) fail(field, `must be a non-empty name with no ".", got ${JSON.stringify(v)}`);
  if (seen?.has(v)) fail(field, `duplicate name "${v}"`);
  seen?.add(v);
  return v;
}

/**
 * A member's local frame as three unit columns { x, y, z }, z along `axis`. With no
 * `xHint`, x is part +X carried by the smallest turn that takes +Z onto the axis (so a
 * member on +Z has part axes); with one, x is the hint with its share of the axis
 * taken out.
 */
export function frameFor(fail, field, axis, xHint = null) {
  const z = axis;
  let x;
  if (xHint) {
    const w = add(xHint, z, -dot(xHint, z));
    const l = Math.hypot(w[0], w[1], w[2]);
    if (!(l > 1e-9)) fail(field, "must not be parallel to the axis");
    x = [w[0] / l, w[1] / l, w[2] / l];
  } else if (z[2] > 1 - 1e-12) {
    x = [1, 0, 0];
  } else if (z[2] < -1 + 1e-12) {
    x = [1, 0, 0]; // half a turn about X
  } else {
    // Rodrigues: +Z onto z about k = Z × z, applied to +X.
    const s = Math.hypot(z[0], z[1]), c = z[2];
    const k = [-z[1] / s, z[0] / s, 0];
    const e = [1, 0, 0];
    const kx = cross(k, e), kd = dot(k, e);
    x = [e[0] * c + kx[0] * s + k[0] * kd * (1 - c), e[1] * c + kx[1] * s + k[1] * kd * (1 - c), e[2] * c + kx[2] * s + k[2] * kd * (1 - c)];
  }
  return { x, y: cross(z, x), z };
}

/** The point at `radius` from `center` along the frame's x turned `angleDeg` about its z. */
export function onCircle(center, frame, radius, angleDeg) {
  const a = rad(angleDeg), c = Math.cos(a) * radius, s = Math.sin(a) * radius;
  return [0, 1, 2].map((i) => center[i] + c * frame.x[i] + s * frame.y[i]);
}

/**
 * A solid built in the member's local frame (its axis along +Z through the origin, its
 * 0 direction along +X), turned `angleDeg` about that axis, set in `frame` and moved to
 * `at`: one rotate (skipped when it is the identity) and one translate.
 */
export function placeIn(solid, frame, angleDeg, at) {
  const a = rad(angleDeg), c = Math.cos(a), s = Math.sin(a);
  // columns of F · Rz(a): x' = c x + s y, y' = -s x + c y, z' = z
  const X = [0, 1, 2].map((i) => c * frame.x[i] + s * frame.y[i]);
  const Y = [0, 1, 2].map((i) => -s * frame.x[i] + c * frame.y[i]);
  const Z = frame.z;
  const turn = axisAngle([X[0], Y[0], Z[0], X[1], Y[1], Z[1], X[2], Y[2], Z[2], 0, 0, 0]);
  const turned = turn ? solid.rotate(turn.deg, [0, 0, 0], turn.axis) : solid;
  return turned.translate([at[0], at[1], at[2]]);
}

/** A copy of a vector with -0 written as 0, so it survives a JSON round trip unchanged. */
export const json3 = (v) => [v[0] + 0, v[1] + 0, v[2] + 0];
