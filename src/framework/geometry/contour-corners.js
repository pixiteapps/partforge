// Paper-free corner/tangent math for the contour IR, split out of contour-ops.js so the
// oracle's shape-probe.js (and anything else that only needs a shape's corners/tangents, not
// its booleans/transforms) doesn't pull in paper-core through contour-ops.js's own
// paper-bridge.js import. Imports only profile.js, shape2d-regions.js and arc-math.js — never
// paper-bridge.js or contour-ops.js, which is what keeps this leaf paper-free.
import { isPathContour, tessellateContour, pointsToContour, closeContourGap } from "./profile.js";
import { ringArea } from "./shape2d-regions.js";
import { arcCenterAndSweep } from "./arc-math.js";

export const WINDING_SEGS = 64;   // tessellation LOD for orientation/containment sampling

export const isPointList = (x) => Array.isArray(x) && x.length > 0 && Array.isArray(x[0]);
// pointsToContour always closes explicitly; a raw {start,segments} contour (hand-authored
// via pathProfile, or handed back from a Shape2D's own stored regions) might not —
// closeContourGap is a no-op when it's already closed, so every ring liftProfile hands to
// contour-ops' corner/transform/query functions is guaranteed explicitly closed.
export const liftContour = (c) => (isPointList(c) ? pointsToContour(c) : closeContourGap(c));

export function liftProfile(input) {
  if (input && input._shape2d) return { kind: "regions", regions: input.toContours() };
  if (isPointList(input)) return { kind: "points", regions: [{ outer: pointsToContour(input), holes: [] }] };
  if (isPathContour(input)) return { kind: "contour", regions: [{ outer: closeContourGap(input), holes: [] }] };
  if (Array.isArray(input) && input.every((r) => r && r.outer))
    return { kind: "regions", regions: input.map((r) => ({ outer: liftContour(r.outer), holes: (r.holes ?? []).map(liftContour) })) };
  if (input && input.outer)
    return { kind: "region", regions: [{ outer: liftContour(input.outer), holes: (input.holes ?? []).map(liftContour) }] };
  throw new Error("contour-ops: input must be [[x,y],…], a {start,segments} contour, {outer,holes}, or a region array");
}

export const contourIsCCW = (c) => ringArea(tessellateContour(c, WINDING_SEGS)) >= 0;

// ── Corner model ────────────────────────────────────────────────────────────
// profileCorners() walks a contour's joints and reports each non-smooth one: the interior
// angle, whether it's convex (material-relative — see below), and the segment kinds either
// side of it. jointTangents() is the shared per-vertex tangent computation, reused by Task 6.

export const SMOOTH_JOINT_DEG = 1;

// Unit tangent of segment `s` (from `from`) at its start (dir=+1) or end (dir=-1 → arrival direction).
// Exported for contour-winding.js's _chain: junction ordering at a curved pinch point needs
// the exact endpoint tangent, not an approximation (via/c1/c2 are NOT control points that
// happen to sit near the tangent — via in particular is a THROUGH point near mid-sweep, so
// from->via is systematically biased by about sweep/4). This recovers it exactly for arcs
// (perpendicular to the radius at the recovered center, oriented by the sweep's sign) and
// cubics (including the degenerate c1===from case, where the true tangent comes from c2).
export function segTangent(from, s, atStart) {
  const norm = ([x, y]) => { const L = Math.hypot(x, y) || 1; return [x / L, y / L]; };
  if (s.c1) {
    if (atStart) {
      const d = [s.c1[0] - from[0], s.c1[1] - from[1]];
      return norm(Math.hypot(d[0], d[1]) > 1e-9 ? d : [s.c2[0] - from[0], s.c2[1] - from[1]]);
    }
    const d = [s.to[0] - s.c2[0], s.to[1] - s.c2[1]];
    return norm(Math.hypot(d[0], d[1]) > 1e-9 ? d : [s.to[0] - s.c1[0], s.to[1] - s.c1[1]]);
  }
  if (s.via) {
    // tangent ⊥ radius, oriented along the sweep (recover center like arcToCubicSegments)
    const c = arcCenterAndSweep(from, s.via, s.to);          // {center:[x,y], dA} or null
    if (!c) return norm([s.to[0] - from[0], s.to[1] - from[1]]);
    const p = atStart ? from : s.to;
    const r = [p[0] - c.center[0], p[1] - c.center[1]];
    const t = c.dA >= 0 ? [-r[1], r[0]] : [r[1], -r[0]];
    return norm(t);
  }
  return norm([s.to[0] - from[0], s.to[1] - from[1]]);
}

export function jointTangents(contour) {  // per vertex i: tangent arriving at and leaving vertex i
  const n = contour.segments.length;
  const pts = [contour.start, ...contour.segments.map((s) => s.to)];
  return contour.segments.map((_, i) => {
    const prevSeg = contour.segments[(i - 1 + n) % n];
    const prevFrom = pts[(i - 1 + n) % n];
    return {
      point: pts[i],
      inTan: segTangent(prevFrom, prevSeg, false),
      outTan: segTangent(pts[i], contour.segments[i], true),
    };
  });
}

export const segType = (s) => (s.c1 ? "cubic" : s.via ? "arc" : "line");

export function contourCorners(contour) {
  const ccw = contourIsCCW(contour);
  const n = contour.segments.length;
  const out = [];
  jointTangents(contour).forEach(({ point, inTan, outTan }, i) => {
    const cross = inTan[0] * outTan[1] - inTan[1] * outTan[0];
    const dot = Math.min(1, Math.max(-1, inTan[0] * outTan[0] + inTan[1] * outTan[1]));
    const turnDeg = (Math.atan2(Math.abs(cross), dot) * 180) / Math.PI;
    if (turnDeg < SMOOTH_JOINT_DEG) return;
    const leftTurn = cross > 0;
    out.push({
      index: i, point: [point[0], point[1]],
      interiorAngleDeg: ccw === leftTurn ? 180 - turnDeg : 180 + turnDeg,
      convex: leftTurn === ccw,
      segTypes: [segType(contour.segments[(i - 1 + n) % n]), segType(contour.segments[i])],
    });
  });
  return out;
}

// Two numbers on every corner, and they are NOT interchangeable. `index` is the joint's
// vertex number within its own contour (what buildCornerOpRing, simplify and the lofts
// key on); `position` is the corner's place in THIS returned list — the one
// `{corners: {indices}}` selects by. They diverge as soon as a contour has a smooth
// joint (a collinear midpoint, a G1 arc-line join), and on region input `index`
// restarts per ring while `position` runs on through the flattened order.
const withPositions = (corners) => corners.map((c, position) => ({ ...c, position }));

export function profileCorners(input) {
  const { kind, regions } = liftProfile(input);
  if (kind === "points" || kind === "contour") return withPositions(contourCorners(regions[0].outer));
  const out = [];
  regions.forEach((rg, regionIndex) => {
    for (const c of contourCorners(rg.outer)) out.push({ regionIndex, ring: "outer", ...c });
    rg.holes.forEach((h, hi) => { for (const c of contourCorners(h)) out.push({ regionIndex, ring: { hole: hi }, ...c }); });
  });
  return withPositions(out);
}

export function cubicAt(p0, c1, c2, p1, t) {
  const u = 1 - t;
  return [0, 1].map((k) => u * u * u * p0[k] + 3 * u * u * t * c1[k] + 3 * u * t * t * c2[k] + t * t * t * p1[k]);
}
export function cubicDeriv(p0, c1, c2, p1, t) {
  const u = 1 - t;
  return [0, 1].map((k) => 3 * u * u * (c1[k] - p0[k]) + 6 * u * t * (c2[k] - c1[k]) + 3 * t * t * (p1[k] - c2[k]));
}
