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
