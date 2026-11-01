// Pose mode's pure geometry: where a dragged handle lands, which handle the
// pointer is over, and the arc a hinge may sweep. No three.js, no DOM — the
// drag session and the scene both lean on it, and tests drive it directly.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * The point a pointer ray drags a handle to: its hit on the plane through
 * `planePoint`, clamped to `maxDist` from it. A ray nearly parallel to the plane
 * (|dir . n| < 0.05, or a plane behind the eye) would shoot the point off to
 * infinity, so it falls back to the ray's closest point to `planePoint` — still
 * continuous with the plane hit as the ray tilts, and always finite.
 */
export function dragPlanePoint(rayOrigin, rayDir, planePoint, planeNormal, maxDist) {
  const d = unit(rayDir);
  const n = unit(planeNormal);
  const denom = dot(d, n);
  let t = null;
  if (Math.abs(denom) >= 0.05) {
    const hit = dot(sub(planePoint, rayOrigin), n) / denom;
    if (hit >= 0) t = hit;
  }
  if (t === null) t = Math.max(0, dot(sub(planePoint, rayOrigin), d));
  const p = [rayOrigin[0] + d[0] * t, rayOrigin[1] + d[1] * t, rayOrigin[2] + d[2] * t];
  const off = sub(p, planePoint);
  const l = len(off);
  if (l <= maxDist) return p;
  const s = maxDist / l;
  return [planePoint[0] + off[0] * s, planePoint[1] + off[1] * s, planePoint[2] + off[2] * s];
}

/**
 * How square to the view the limb may point before its drag plane gives up containing
 * it: past |view . along| = 0.95 (about 18° off the line of sight) a plane holding the
 * limb would be nearly edge-on, and a small cursor move would throw the point far.
 */
export const ALONG_VIEW_LIMIT = 0.95;

/**
 * The normal of a handle's drag plane: the plane through the grabbed point that
 * CONTAINS `along` (the limb's direction there — its base joint to the grabbed point)
 * and faces the camera as squarely as it can, so pulling the cursor along the limb's
 * on-screen line pulls the point along the limb itself, out or in, whatever the view.
 * That normal is the view direction less its component along the limb. Seen from the
 * side it IS the view direction (the camera-facing plane); with the limb pointing within
 * about 18° of the line of sight (|view . along| > ALONG_VIEW_LIMIT), or no direction to
 * read (the base joint grabbed), it falls back to the camera-facing plane.
 */
export function dragPlaneNormal(forward, along) {
  const f = unit(forward);
  const l = len(along);
  if (!(l > 1e-9)) return f;
  const d = [along[0] / l, along[1] / l, along[2] / l];
  const c = dot(f, d);
  if (Math.abs(c) > ALONG_VIEW_LIMIT) return f;
  return unit([f[0] - c * d[0], f[1] - c * d[1], f[2] - c * d[2]]);
}

/** The id of the screen point nearest (px, py) within `radius` CSS px, else null. */
export function hitHandle(screenPts, px, py, radius = 12) {
  let best = null;
  let bestD = radius * radius;
  for (const p of screenPts) {
    const d = (p.x - px) ** 2 + (p.y - py) ** 2;
    if (d <= bestD) { bestD = d; best = p.id; }
  }
  return best;
}

/**
 * Points of a hinge's allowed sweep: a circle of `radius` about `axis` through
 * `origin`, from `lo` to `hi` DEGREES measured from `refDir` (projected off the
 * axis) in the right-handed sense about it — the sense a positive joint value turns.
 * Returns `segments + 1` points.
 */
export function limitArc(origin, axis, refDir, [lo, hi], radius, segments = 32) {
  const a = unit(axis);
  const along = dot(refDir, a);
  let u = [refDir[0] - a[0] * along, refDir[1] - a[1] * along, refDir[2] - a[2] * along];
  if (len(u) < 1e-9) u = Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]);
  u = unit(u);
  const v = cross(a, u);
  const out = [];
  for (let i = 0; i <= segments; i++) {
    const th = ((lo + ((hi - lo) * i) / segments) * Math.PI) / 180;
    const c = Math.cos(th) * radius, s = Math.sin(th) * radius;
    out.push([origin[0] + u[0] * c + v[0] * s, origin[1] + u[1] * c + v[1] * s, origin[2] + u[2] * c + v[2] * s]);
  }
  return out;
}
