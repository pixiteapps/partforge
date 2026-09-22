// Lazy, private PaperScope: built on first use (not at module load), so parts that never
// call k.text2d don't pull paper-core's setup onto the geometry worker. Never paper's
// package-global project — another consumer in the same worker may import paper too.
import paper from "paper/dist/paper-core.js";
import { tessellateContour, reverseContour, closeContourGap } from "./profile.js";
import { arcCenterAndSweep } from "./arc-math.js";

const ORIENT_SEGS = 8;   // points/segment for the local orientation sampler below

let _scope = null;
function paperScope() {
  if (!_scope) { _scope = new paper.PaperScope(); _scope.setup(new _scope.Size(1, 1)); }
  return _scope;
}

// arcCenterAndSweep now lives in arc-math.js (paper-free), re-exported here so every
// existing importer of it from this module keeps working unchanged.
export { arcCenterAndSweep } from "./arc-math.js";

// Circular arc through (p0, via, to) → cubic Bézier segments, ≤90° each, endpoints
// exact. Each piece uses the standard k = (4/3)·tan(θ/4) control-point offset.
// Collinear triple → straight segment.
export function arcToCubicSegments(p0, via, to) {
  const cx = to[0], cy = to[1];
  const c = arcCenterAndSweep(p0, via, to);
  if (!c) return [{ to: [cx, cy] }];
  const { center: [ux, uy], r, dA } = c;
  const a0 = Math.atan2(p0[1] - uy, p0[0] - ux);
  // Handle floating-point precision: angles very close to π/2 boundaries
  const pieces = Math.max(1, Math.ceil((Math.abs(dA) - 1e-9) / (Math.PI / 2)));
  const out = [];
  for (let i = 0; i < pieces; i++) {
    const t0 = a0 + dA * (i / pieces), t1 = a0 + dA * ((i + 1) / pieces);
    const dt = t1 - t0, k = (4 / 3) * Math.tan(dt / 4);
    const P = (t) => [ux + r * Math.cos(t), uy + r * Math.sin(t)];
    const s = P(t0), e = P(t1);
    out.push({
      to: e,
      c1: [s[0] - k * r * Math.sin(t0), s[1] + k * r * Math.cos(t0)],
      c2: [e[0] + k * r * Math.sin(t1), e[1] - k * r * Math.cos(t1)],
    });
  }
  out[out.length - 1].to = [cx, cy];   // pin the exact endpoint
  return out;
}

export function toPaperPath(scope, contour, segMap = null, { open = false } = {}) {
  const path = new scope.Path({ insert: false });
  path.moveTo(new scope.Point(contour.start[0], contour.start[1]));
  let prev = contour.start;
  contour.segments.forEach((s, i) => {
    if (s.via) {
      // Expand {to,via} arc into cubic segments, all sharing one segMap entry
      const cubics = arcToCubicSegments(prev, s.via, s.to);
      for (const cubic of cubics) {
        if (cubic.c1) {
          path.cubicCurveTo(
            new scope.Point(cubic.c1[0], cubic.c1[1]),
            new scope.Point(cubic.c2[0], cubic.c2[1]),
            new scope.Point(cubic.to[0], cubic.to[1]));
        } else {
          // Collinear triple: emit straight segment
          path.lineTo(new scope.Point(cubic.to[0], cubic.to[1]));
        }
        if (segMap) segMap.push(i);
      }
      prev = s.to;
    } else if (s.c1) {
      path.cubicCurveTo(
        new scope.Point(s.c1[0], s.c1[1]),
        new scope.Point(s.c2[0], s.c2[1]),
        new scope.Point(s.to[0], s.to[1]));
      if (segMap) segMap.push(i);
      prev = s.to;
    } else {
      path.lineTo(new scope.Point(s.to[0], s.to[1]));
      if (segMap) segMap.push(i);
      prev = s.to;
    }
  });
  if (!open) {
    path.closePath();
    // A contour authored without an explicit closing segment (e.g. pathProfile(...).close())
    // relies on closePath() to synthesize the closing curve — segMap never saw it. Give it
    // the next index after the last authored segment so callers can recognize "the implicit
    // close". When the contour DOES have an explicit closing segment, closePath() joins the
    // coincident start/end segments and curve count already matches segMap — don't push then.
    if (segMap && path.curves.length === segMap.length + 1) segMap.push(contour.segments.length);
  }
  return path;
}

function toContour(path) {
  const segs = path.segments;
  const start = [segs[0].point.x, segs[0].point.y];
  const out = { start, segments: [] };
  for (let i = 0; i < segs.length; i++) {
    const a = segs[i], b = segs[(i + 1) % segs.length];
    const straight = a.handleOut.isZero() && b.handleIn.isZero();
    const closing = i === segs.length - 1;
    if (closing && straight) continue;                 // implicit straight close
    const to = [b.point.x, b.point.y];
    if (straight) out.segments.push({ to });
    else out.segments.push({ to, c1: [a.point.x + a.handleOut.x, a.point.y + a.handleOut.y], c2: [b.point.x + b.handleIn.x, b.point.y + b.handleIn.y] });
  }
  return out;
}

// Open-path counterpart to toContour: every segment is a real curve of the path (no
// wrap-around, no implicit-close skip) — for readback of paths built with {open: true}.
function toOpenContour(path) {
  const segs = path.segments;
  const start = [segs[0].point.x, segs[0].point.y];
  const out = { start, segments: [] };
  for (let i = 0; i < segs.length - 1; i++) {
    const a = segs[i], b = segs[i + 1];
    const straight = a.handleOut.isZero() && b.handleIn.isZero();
    const to = [b.point.x, b.point.y];
    if (straight) out.segments.push({ to });
    else out.segments.push({ to, c1: [a.point.x + a.handleOut.x, a.point.y + a.handleOut.y], c2: [b.point.x + b.handleIn.x, b.point.y + b.handleIn.y] });
  }
  return out;
}

// Group while paths are still Paper geometry. Path.area includes cubic handles and
// interiorPoint is guaranteed to lie inside the curve; never reduce curves to endpoint rings.
function groupPaperPaths(paths) {
  const largest = paths.reduce((a, b) => Math.abs(b.area) > Math.abs(a.area) ? b : a);
  const outerClockwise = largest.clockwise;
  const outers = paths.filter((p) => p.clockwise === outerClockwise)
    .map((path) => ({ path, holes: [] }));
  for (const hole of paths.filter((p) => p.clockwise !== outerClockwise)) {
    const home = outers.filter((o) => o.path.contains(hole.interiorPoint))
      .sort((a, b) => Math.abs(a.path.area) - Math.abs(b.path.area))[0];
    if (!home) throw new Error("curve-fill: resolved hole has no containing outer");
    home.holes.push(hole);
  }
  return outers.map(({ path, holes }) => ({
    outer: toContour(path),
    holes: holes.map(toContour),
  }));
}

// Signed shoelace area of a tessellated ring (CCW positive) — a tiny local sampler so
// this module doesn't need shape2d-regions.js's ringArea for one call site.
function shoelaceArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

// groupPaperPaths (containment-based outer/hole assignment), plus a winding-normalization
// pass so the emitted contours carry the storage invariant (outer CCW, holes CW in
// model y-up space). Paper's own `clockwise` flag is in paper's y-down coordinate frame,
// so it doesn't map onto that invariant directly — decide by area sign of the emitted
// contour instead: tessellate it and check the shoelace sign, reversing when wrong.
// closeContourGap re-closes the ring explicitly: toContour() (used by groupPaperPaths,
// via curve-fill.js too — see its own comment) drops a straight closing edge as
// "implicit," but every Shape2D region stored from here on must be explicitly closed —
// contour-ops.js's corner math reads `segments[n-1]` directly as the edge arriving back
// at `start` and has no other way to know the ring isn't fully spelled out.
function groupPaperPathsOriented(paths) {
  const regions = groupPaperPaths(paths);
  return regions.map(({ outer, holes }) => ({
    outer: closeContourGap(shoelaceArea(tessellateContour(outer, ORIENT_SEGS)) >= 0 ? outer : reverseContour(outer)),
    holes: holes.map((h) => closeContourGap(shoelaceArea(tessellateContour(h, ORIENT_SEGS)) < 0 ? h : reverseContour(h))),
  }));
}

function cloneRegion(rg) {
  return JSON.parse(JSON.stringify(rg));
}

function regionsToCompound(scope, regions) {
  const children = [];
  for (const rg of regions) {
    children.push(toPaperPath(scope, rg.outer));
    for (const h of rg.holes) children.push(toPaperPath(scope, h));
  }
  return new scope.CompoundPath({ children, fillRule: "evenodd" });
}

// Boolean op between two region lists (each in contour IR) via paper.js's planar boolean
// engine. op: "unite" | "subtract" | "intersect" — same semantics as bracket.js's Shape2D
// toolkit. Result regions come back in contour IR with the storage winding invariant
// (outer CCW, holes CW) restored by groupPaperPathsOriented. Empty result → [].
export function booleanRegions(aRegions, bRegions, op) {
  if (!["unite", "subtract", "intersect"].includes(op)) throw new Error(`booleanRegions: unknown op "${op}"`);
  if (aRegions.length === 0) return op === "unite" ? bRegions.map(cloneRegion) : [];
  if (bRegions.length === 0) return op === "intersect" ? [] : aRegions.map(cloneRegion);
  const scope = paperScope();
  try {
    const A = regionsToCompound(scope, aRegions), B = regionsToCompound(scope, bRegions);
    const out = A[op](B, { insert: false });
    const paths = (out.className === "CompoundPath" ? out.children : [out])
      .filter((p) => p.segments && p.segments.length >= 2 && Math.abs(p.area) > 1e-9);
    if (!paths.length) return [];
    return groupPaperPathsOriented(paths);
  } finally {
    scope.project.clear();
  }
}

export { paperScope, toContour, toOpenContour, groupPaperPaths };

// paper reports an intersection as a time on the PAPER CURVE it hit, and that is NOT this
// engine's IR parameter for the segment the curve came from. segMap fixes WHICH segment; this
// fixes WHERE ON IT. Three separate mismatches, only one of them benign:
//
//   * an ARC ({to,via}) is expanded by arcToCubicSegments into up to four ≤90° cubics that all
//     share ONE segMap entry, so `loc.time` is the time within whichever piece was hit —
//     measured 0.404 for a point 70.3% along a 180° arc. That is the damaging one: it is not a
//     small error but a different number entirely, so _splitRings trims the arc at a wildly
//     wrong sweep, and two crossings on one arc can even sort backwards.
//   * a LINE is a zero-handle cubic in paper, whose time satisfies 3t²−2t³ = the linear
//     fraction: measured 0.560 where the IR parameter is 0.590. Benign so far only by luck —
//     _splitRings overwrites a line piece's endpoints with the pooled vertices, and the map is
//     monotonic so ordering survives.
//   * a CUBIC ({to,c1,c2}) is the only kind that round-trips: one paper curve, the same
//     parameterization trimSegment's splitCubic uses.
//
// The parameter is recovered from the intersection POINT rather than by undoing each of those.
// That inverts exactly what trimSegment does — linear in position along a line, linear in
// ANGLE about the arc's centre (trimSegment: aS = a0 + dA·tStart, off the same
// arcCenterAndSweep) — and it is exact to floating point, where reconstructing the arc case
// from the piece index as (j + tp)/k is not: (j + tp)/k is right about the PIECE (the sweep is
// split into equal angular pieces, `t0 = a0 + dA·(i/pieces)` above) but still reads a Bézier
// time as an angular fraction WITHIN that piece, leaving up to 4.5e-3 of parameter error — and
// none of it corrected on a ≤90° arc, where k is 1 and the formula degenerates to `tp`. A ≤90°
// round join is the commonest arc this engine emits.
//
// Recovering from the point is also the more robust reading for an arc: the cubic
// approximation's error is essentially RADIAL, so the point's ANGLE is right even where the
// point itself sits a fraction off the true circle.
function irTime(contour, segIdx, point, paperTime) {
  const n = contour.segments.length;
  // segIdx === n is the closing curve closePath() synthesizes for a contour that never returns
  // to its own start (see toPaperPath's segMap note) — a straight edge back to `start`.
  const seg = segIdx < n ? contour.segments[segIdx] : { to: contour.start };
  const from = segIdx === 0 ? contour.start : contour.segments[(segIdx - 1) % n].to;
  if (seg.c1) return paperTime;
  if (seg.via) {
    const c = arcCenterAndSweep(from, seg.via, seg.to);
    if (c) {                                            // null = collinear triple: a line, below
      const a0 = Math.atan2(from[1] - c.center[1], from[0] - c.center[0]);
      const aP = Math.atan2(point[1] - c.center[1], point[0] - c.center[0]);
      const span = Math.abs(c.dA);
      const twoPi = 2 * Math.PI;
      let d = (c.dA >= 0 ? aP - a0 : a0 - aP) % twoPi;  // angle travelled from the arc's start
      if (d < 0) d += twoPi;
      const t = d / span;
      // A point a rounding step BEFORE the start normalizes to nearly a whole turn rather than
      // to ~0, and one past the end simply exceeds 1. Snap to the nearer end either way instead
      // of handing _splitRings a parameter outside [0,1].
      return t <= 1 ? t : (t - 1 <= twoPi / span - t ? 1 : 0);
    }
  }
  const dx = seg.to[0] - from[0], dy = seg.to[1] - from[1];
  const L2 = dx * dx + dy * dy;
  if (L2 < 1e-18) return paperTime;                     // degenerate segment: nothing to project on
  const t = ((point[0] - from[0]) * dx + (point[1] - from[1]) * dy) / L2;
  return t < 0 ? 0 : (t > 1 ? 1 : t);
}

// Every crossing among a set of contour-IR rings — self-intersections of each ring plus
// pairwise intersections — expressed back in IR terms as { ring, seg, t, point }.
//
// This deliberately borrows the half of paper.js that works. Paper implements fat-line
// Bézier clipping (Sederberg–Nishita) with convex-hull rejection: recursive subdivision
// that returns exact (curve, t) on the original curves. Paper's weakness in this engine
// was never finding intersections — it is the tracing and branch selection afterwards,
// which contour-winding.js replaces. segMap (filled by toPaperPath) maps paper's curve
// index back to our IR segment index.
//
// NB paper's addCurveIntersections bails at 40 recursion levels / 4096 calls and returns
// a PARTIAL set on pathological input. Callers must detect that downstream (an unconsumed
// piece during chaining) rather than trusting completeness here.
export function ringCrossings(rings) {
  if (rings.length === 0) return [];
  const scope = paperScope();
  try {
    const maps = rings.map(() => []);
    const paths = rings.map((c, i) => toPaperPath(scope, c, maps[i]));
    const out = [];
    const push = (ringIdx, loc) => {
      const seg = maps[ringIdx][loc.curve.index];
      if (!Number.isInteger(seg)) return;               // defensive: unmapped curve
      const point = [loc.point.x, loc.point.y];
      out.push({ ring: ringIdx, seg, t: irTime(rings[ringIdx], seg, point, loc.time), point });
    };
    for (let i = 0; i < paths.length; i++) {
      for (const loc of paths[i].getIntersections()) {                 // self
        push(i, loc);
        if (loc.intersection) push(i, loc.intersection);
      }
      for (let j = i + 1; j < paths.length; j++) {
        for (const loc of paths[i].getIntersections(paths[j])) {        // pairwise
          push(i, loc);
          push(j, loc.intersection);
        }
      }
    }
    return out;
  } finally {
    scope.project.clear();
  }
}
