// A point's angle about an axis, in one fixed convention: the rotary drag's target
// (pose drag kinds) and the solver's residual (param-solve.js) both read it, so they
// must agree on where 0 is. Pure and deterministic.

/**
 * A fixed in-plane basis for an axis direction: `u` is the world axis least parallel to
 * it (X, then Y, then Z on a tie) with the direction's share taken out, and `v` is
 * n × u, so u, v, n are right-handed and an angle grows counter-clockwise about n.
 */
export function axisBasis(direction) {
  const len = Math.hypot(direction[0], direction[1], direction[2]);
  const n = [direction[0] / len, direction[1] / len, direction[2] / len];
  let k = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(n[i]) < Math.abs(n[k])) k = i;
  const e = [0, 0, 0];
  e[k] = 1;
  const dot = n[k];
  const w = [e[0] - n[0] * dot, e[1] - n[1] * dot, e[2] - n[2] * dot];
  const wl = Math.hypot(w[0], w[1], w[2]);
  const u = [w[0] / wl, w[1] / wl, w[2] / wl];
  const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  return { u, v };
}

/** The angle (degrees, in (-180, 180]) of `point` about `axis` ({ origin, direction }), from axisBasis's u. */
export function angleAbout(point, axis) {
  const { u, v } = axisBasis(axis.direction);
  const o = axis.origin;
  const r = [point[0] - o[0], point[1] - o[1], point[2] - o[2]];
  const a = (Math.atan2(r[0] * v[0] + r[1] * v[1] + r[2] * v[2], r[0] * u[0] + r[1] * u[1] + r[2] * u[2]) * 180) / Math.PI;
  return a === -180 ? 180 : a;
}

/** A difference of angles (degrees) wrapped into (-180, 180]. */
export function wrapTo180(a) {
  const r = (((a + 180) % 360) + 360) % 360 - 180;
  return r === -180 ? 180 : r;
}
