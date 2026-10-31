// The aim-angle convention: pitch, yaw and roll in degrees turned onto a rest direction.
// One source for both sides of it: the kinematics domain's aimFromAngles (what a part's
// aim parameters mean) and Pose mode's rotate rings (which axis each parameter turns
// about). Core, so the domain imports it and the viewer never imports the domain.
//
// Pure and three-free, DOM-free, node:-free.
import { hypot3 } from "../geometry/js-math.js";

const DEG = 180 / Math.PI;
const Z = [0, 0, 1];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => { const l = hypot3(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };

/** Rodrigues: v turned by deg about the unit axis k. */
function turn(v, k, deg) {
  const t = deg / DEG, c = Math.cos(t), s = Math.sin(t), kv = cross(k, v), kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
}

/**
 * Turn `toward` (a non-zero [x, y, z], not checked) by the angles. Zero is `toward`; yaw
 * turns about part +Z; pitch then turns about the yawed horizontal axis at right angles to
 * the aim (aim × up), positive lifting the aim toward `up`; roll turns `up` about the aim.
 * `up` starts as part +Z taken at right angles to `toward`, or +Y when `toward` is vertical.
 *
 * Returns `{ aim, up, axes }`: `up` is rolled when `roll` is given, else the pitched up;
 * `axes` is `[pitch, yaw, roll]`, the unit axis each angle turns the final aim and up
 * about (a small change of that angle is a turn about it). The axes come from the angles,
 * never from the turned aim, so they stay right at pitch ±90, where the aim is vertical;
 * there yaw and roll turn about the same axis, the usual gimbal lock.
 */
export function aimTurn(toward, { pitch = 0, yaw = 0, roll } = {}) {
  let aim = unit(toward);
  const vertical = hypot3(aim[0], aim[1], 0) <= 1e-9;
  let up = vertical ? [0, 1, 0] : [0, 0, 1];
  const d = dot(up, aim);
  up = unit([up[0] - d * aim[0], up[1] - d * aim[1], up[2] - d * aim[2]]);
  aim = turn(aim, Z, yaw); up = turn(up, Z, yaw);
  const axis = unit(cross(aim, up));
  aim = turn(aim, axis, pitch); up = turn(up, axis, pitch);
  if (roll != null) up = turn(up, aim, roll);
  return { aim, up, axes: [axis, [...Z], [...aim]] };
}

/** An angle wrapped into (-180, 180]. */
const wrap180 = (deg) => { const w = deg - 360 * Math.floor((deg + 180) / 360); return w === -180 ? 180 : w + 0; };

/**
 * The inverse of aimTurn: the pitch, yaw and roll (degrees) that turn `toward` onto the unit
 * `aim` and, when `up` is given, `up` onto `up` (taken at right angles to `aim`). Without
 * `up`, roll is undefined.
 *
 * Choices, where the angles are not unique:
 * - Pitch has two solutions (over the top, with the yaw turned 180). The one inside
 *   `pitchRange` wins, then the one nearer `near.pitch` (default 0).
 * - With the aim vertical (|aim · Z| > 1 - 1e-12 for a non-vertical `toward`) yaw and roll turn
 *   about the same axis — the gimbal lock aimTurn's axes describe: the yaw is kept at
 *   `near.yaw` (default 0) and the roll takes the rest.
 * - Yaw and roll are wrapped into (-180, 180].
 */
export function anglesFromAim(toward, { aim, up = null }, { near = {}, pitchRange = null } = {}) {
  const a0 = unit(toward);
  const vertical = hypot3(a0[0], a0[1], 0) <= 1e-9;
  let u0 = vertical ? [0, 1, 0] : [0, 0, 1];
  const d0 = dot(u0, a0);
  u0 = unit([u0[0] - d0 * a0[0], u0[1] - d0 * a0[1], u0[2] - d0 * a0[2]]);
  const want = unit(aim);
  // After yaw (about Z, which keeps z) and pitch (in the aim-up plane):
  // aim = Rz(yaw) (cos p a0 + sin p u0), so its z is cos p a0z + sin p u0z.
  const A = a0[2], B = u0[2], h = Math.hypot(A, B);
  const base = Math.atan2(B, A);
  const c = Math.acos(Math.max(-1, Math.min(1, want[2] / (h || 1))));
  const nearPitch = Number.isFinite(near.pitch) ? near.pitch : 0;
  const cands = [wrap180((base + c) * DEG), wrap180((base - c) * DEG)];
  const inRange = (p) => !pitchRange || (p >= pitchRange[0] - 1e-9 && p <= pitchRange[1] + 1e-9);
  const dist = (p) => Math.abs(wrap180(p - nearPitch));
  cands.sort((p, q) => (inRange(q) - inRange(p)) || (dist(p) - dist(q)));
  const pitch = cands[0];
  const t = pitch / DEG;
  const v = [Math.cos(t) * a0[0] + Math.sin(t) * u0[0], Math.cos(t) * a0[1] + Math.sin(t) * u0[1], 0];
  const vh = Math.hypot(v[0], v[1]), wh = Math.hypot(want[0], want[1]);
  const yaw = vh > 1e-9 && wh > 1e-9
    ? wrap180(Math.atan2(v[0] * want[1] - v[1] * want[0], v[0] * want[0] + v[1] * want[1]) * DEG)
    : (Number.isFinite(near.yaw) ? near.yaw : 0);
  if (!up) return { pitch, yaw };
  const turned = aimTurn(toward, { pitch, yaw });
  const ax = turned.aim;
  const d = dot(up, ax);
  const upN = unit([up[0] - d * ax[0], up[1] - d * ax[1], up[2] - d * ax[2]]);
  const roll = wrap180(Math.atan2(dot(ax, cross(turned.up, upN)), dot(turned.up, upN)) * DEG);
  return { pitch, yaw, roll };
}
