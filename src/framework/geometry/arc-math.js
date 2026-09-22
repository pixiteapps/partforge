// Pure arc math, paper-free: circumcircle center + signed sweep for the arc through three
// points. Split out of paper-bridge.js so callers that only need this number crunching (the
// oracle's shape-probe.js, contour-ops.js's corner/tangent math) don't pull in paper-core —
// paper-bridge.js still re-exports arcCenterAndSweep so every existing importer of it is
// unaffected.

// Circumcircle center + signed sweep for the arc through (p0, via, to) — the sweep is the
// one passing through `via` (sign-free, winding-free), same recovery as profile.js's
// sampleArc. Returns null for a collinear (degenerate) triple. Shared by arcToCubicSegments
// (paper-bridge.js) and contour-ops.js's jointTangents (arc tangents are ⊥ radius, oriented by dA's sign).
export function arcCenterAndSweep(p0, via, to) {
  const [ax, ay] = p0, [bx, by] = via, [cx, cy] = to;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return null;
  const sa = ax*ax + ay*ay, sb = bx*bx + by*by, sc = cx*cx + cy*cy;
  const ux = (sa * (by - cy) + sb * (cy - ay) + sc * (ay - by)) / d;
  const uy = (sa * (cx - bx) + sb * (ax - cx) + sc * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  const a0 = Math.atan2(ay - uy, ax - ux);
  const av = Math.atan2(by - uy, bx - ux);
  const a1 = Math.atan2(cy - uy, cx - ux);
  const twoPi = 2 * Math.PI;
  const ccw = (x) => { let v = x % twoPi; if (v < 0) v += twoPi; return v; };
  const dCCW = ccw(a1 - a0), vCCW = ccw(av - a0);
  const dA = vCCW <= dCCW ? dCCW : dCCW - twoPi;
  return { center: [ux, uy], r, dA };
}
