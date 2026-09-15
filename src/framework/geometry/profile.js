// Backend-shared 2-D region normalization + tessellation for extrude()/prism(). A contour
// is EITHER a bare points array (legacy, all straight edges) OR a canonical path contour
// { start:[x,y], segments:[{to}|{to,via}|{to,c1,c2}] } carrying true circular arcs ({to,via},
// from roundedProfile) and/or cubic Béziers ({to,c1,c2}, from pathProfile). normalizeProfile
// validates the polymorphic { outer, holes } envelope (bare array = outer only), preserving
// each contour's shape; tessellateProfile turns arcs/cubics into point rings for the Manifold
// (mesh) path at the mesh LOD. The OCCT path consumes the same contour directly (contourDrawing
// → threePointsArcTo / cubicBezierCurveTo) for true CIRCLE / B-spline B-rep edges. Legacy
// point-array contours take the exact former path byte-for-byte — no cache-busting.

// An ArcContour is a non-array object carrying arcs symbolically.
export function isArcContour(c) {
  return !!c && typeof c === "object" && !Array.isArray(c) && (c.arc === true || Array.isArray(c.segments));
}

// Curves generalize arcs; the symbolic-form predicate is the same. Prefer this name.
export const isPathContour = isArcContour;

function validateContour(c, role) {
  if (isArcContour(c)) {
    if (!Array.isArray(c.start) || c.start.length < 2)
      throw new Error(`extrude: ${role} arc contour needs a start [x,y]`);
    if (!Array.isArray(c.segments) || c.segments.length < 1)
      throw new Error(`extrude: ${role} arc contour needs ≥1 segment`);
    for (const s of c.segments) {
      const hasCubic = s.c1 != null || s.c2 != null;
      if (hasCubic) {
        if (s.via != null)
          throw new Error(`extrude: ${role} segment cannot mix arc (via) and cubic (c1/c2)`);
        const ok = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
        if (!ok(s.c1) || !ok(s.c2))
          throw new Error(`extrude: ${role} cubic segment needs c1 and c2 as finite [x,y]`);
      }
    }
    return;
  }
  if (!Array.isArray(c) || c.length < 3) throw new Error(`extrude: ${role} needs ≥3 points`);
}

export function normalizeProfile(profile) {
  let outer, holes;
  if (Array.isArray(profile) || isArcContour(profile)) { outer = profile; holes = []; }
  else if (profile && typeof profile === "object") { outer = profile.outer; holes = profile.holes ?? []; }
  else throw new Error("extrude: profile must be [[x,y],…], an arc contour, or { outer, holes? }");
  // Preserve the historical, test-pinned wording for the legacy point-array path.
  if (isArcContour(outer)) validateContour(outer, "outer contour");
  else if (!Array.isArray(outer) || outer.length < 3) throw new Error("extrude: outer contour needs ≥3 points");
  if (!Array.isArray(holes)) throw new Error("extrude: holes must be an array of contours");
  for (const hole of holes) {
    if (isArcContour(hole)) validateContour(hole, "hole arc contour");
    else if (!Array.isArray(hole) || hole.length < 3) throw new Error("extrude: each hole needs ≥3 points");
  }
  return { outer, holes };
}

// Solve the circle through (p0, via, p1) and the CCW-normalized sweep from p0 to p1
// that passes through `via`. Returns null for a collinear triple (callers emit a
// straight segment). Shared by sampleArc and loft-rings' fixed-count arc sampler.
export function arcGeometry(p0, via, p1) {
  const [ax, ay] = p0, [bx, by] = via, [cx0, cy0] = p1;
  const d = 2 * (ax * (by - cy0) + bx * (cy0 - ay) + cx0 * (ay - by));
  if (Math.abs(d) < 1e-12) return null;
  const sa = ax * ax + ay * ay, sb = bx * bx + by * by, sc = cx0 * cx0 + cy0 * cy0;
  const cx = (sa * (by - cy0) + sb * (cy0 - ay) + sc * (ay - by)) / d;
  const cy = (sa * (cx0 - bx) + sb * (ax - cx0) + sc * (bx - ax)) / d;
  const r = Math.hypot(ax - cx, ay - cy);
  const a0 = Math.atan2(ay - cy, ax - cx);
  const av = Math.atan2(by - cy, bx - cx);
  const a1 = Math.atan2(cy0 - cy, cx0 - cx);
  const twoPi = 2 * Math.PI;
  const ccw = (x) => { let v = x % twoPi; if (v < 0) v += twoPi; return v; };
  const dCCW = ccw(a1 - a0), vCCW = ccw(av - a0);
  return { cx, cy, r, a0, dA: vCCW <= dCCW ? dCCW : dCCW - twoPi };
}

// Sample the circular arc through (p0, via, p1) — the three-point form roundedProfile
// emits — into a point list p1…pN (EXCLUDING the start p0, which the ring already holds;
// the last point is exactly p1). The circle is recovered from the circumcircle of the
// three points; the sweep direction is the one whose arc actually passes through `via`
// (sign-free, winding-free). Facet count scales with the sweep's fraction of the kernel's
// full-circle resolution `segs`, matching the piePolygon/circleProfile convention, so an
// arc and a circleProfile of equal radius facet identically. `segs` is either that count
// or a function of the arc's radius returning one — the mesh backend's print tier sizes
// circles by chord tolerance (circle-segs.js) and hands the samplers the rule rather
// than a number. A degenerate (collinear) triple falls back to a single straight segment
// to p1 — the same "plain line" the OCCT side gets when roundedProfile emits no `via`.
export function sampleArc(p0, via, p1, segs) {
  const g = arcGeometry(p0, via, p1);
  if (!g) return [[p1[0], p1[1]]];                        // collinear → straight line
  const n = typeof segs === "function" ? segs(g.r) : segs;
  const steps = Math.max(2, Math.ceil((n * Math.abs(g.dA)) / (2 * Math.PI)));
  const out = [];
  for (let s = 1; s <= steps; s++) {
    const ang = g.a0 + g.dA * (s / steps);
    out.push([g.cx + g.r * Math.cos(ang), g.cy + g.r * Math.sin(ang)]);
  }
  out[out.length - 1] = [p1[0], p1[1]];                   // pin the exact endpoint
  return out;
}

// Flatten the cubic Bézier (p0,c1,c2,p1) into points p1…pN — EXCLUDING the start
// p0 (the ring already holds it), last point pinned exactly to p1. Adaptive: split
// at t=½ (de Casteljau) until the control polygon's total unsigned turn is ≤ 2π/segs
// — the exact generalization of sampleArc's "a point every 2π/segs of sweep", so a
// cubic tracing a circular arc facets like the arc primitive at the same segs. Summing
// |turn| at BOTH interior control points also catches S-curves a pure endpoint-tangent
// test would miss. Depth cap guarantees termination. Pure in (args, segs).
//
// `segs` may be a function of radius (see sampleArc). A cubic has no single radius, so
// the budget is decided per sub-curve from the radius it traces, recovered from its
// chord c and turn t as the circle on which a chord c subtends t: r = c / (2·sin(t/2)).
// That is EXACT for a circular arc. For any other cubic the control polygon's turn t
// overstates the curve's, so r errs small and the count errs LOW — a slightly coarser
// budget, not a finer one. The bias is bounded by the ratio of polygon turn to curve
// turn, which the recursion drives to 1 as the pieces shrink, and at the turns that
// pass (≤ 2π/116) it is under 0.02 % of the count. A cubic tracing a circle of radius
// r therefore facets like the arc primitive of radius r under the same rule.
export function sampleBezier(p0, c1, c2, p1, segs) {
  const segsAt = typeof segs === "function" ? segs : null;
  const flatTurn = segsAt ? null : (2 * Math.PI) / Math.max(3, segs);
  const maxTurnFor = (a, d, t) => {
    if (!segsAt) return flatTurn;
    const chord = Math.hypot(d[0] - a[0], d[1] - a[1]);
    const half = Math.sin(t / 2);                    // t ≤ 2π here: two turns of ≤ π each
    const r = half > 1e-9 ? chord / (2 * half) : Infinity; // straight (t ≈ 0): the cap, and t ≤ budget anyway
    return (2 * Math.PI) / Math.max(3, segsAt(r));
  };
  const out = [];
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const turn = (u, v) => {
    const du = Math.hypot(u[0], u[1]), dv = Math.hypot(v[0], v[1]);
    if (du < 1e-12 || dv < 1e-12) return 0;
    let c = (u[0] * v[0] + u[1] * v[1]) / (du * dv);
    if (c > 1) c = 1; else if (c < -1) c = -1;
    return Math.acos(c);
  };
  const recurse = (a, b, c, d, depth) => {
    const ab = [b[0] - a[0], b[1] - a[1]];
    const bc = [c[0] - b[0], c[1] - b[1]];
    const cd = [d[0] - c[0], d[1] - c[1]];
    const t = turn(ab, bc) + turn(bc, cd);
    if (depth >= 12 || t <= maxTurnFor(a, d, t)) { out.push([d[0], d[1]]); return; }
    const p01 = mid(a, b), p12 = mid(b, c), p23 = mid(c, d);
    const p012 = mid(p01, p12), p123 = mid(p12, p23), m = mid(p012, p123);
    recurse(a, p01, p012, m, depth + 1);
    recurse(m, p123, p23, d, depth + 1);
  };
  recurse(p0, c1, c2, p1, 0);
  if (out.length === 0) out.push([p1[0], p1[1]]);
  out[out.length - 1] = [p1[0], p1[1]];   // pin the exact endpoint
  // Emit-if-moved: near a cusp (a degenerate loop-back cubic — e.g. the winding
  // resolver's splice debris, start === end with controls ~0.01 mm out) the curve's
  // SPEED collapses, so depth-capped parameter-uniform splits cluster spatially and
  // the raw list carries runs of samples nanometers apart (measured min gap 2e-9 mm).
  // Those land in tessellated rings as coincident points and poison every consumer
  // (sliver wall facets, mesh edge chains, ring dedup). Keep a sample only once it has
  // moved SAMPLE_EPS from the last kept one; the exact endpoint stays pinned — it
  // replaces a final sample that stopped short of it, so the one pair flanking the pin
  // may be tighter than SAMPLE_EPS, and that is the only pair allowed to be. 1e-6 mm is
  // a nanometer: far below any legitimate facet spacing (a 1 µm-radius arc at segs 96
  // still spaces ~6e-5), so no real curve loses a sample.
  const SAMPLE_EPS = 1e-6;
  const kept = [];
  let last = p0;
  for (const p of out) {
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < SAMPLE_EPS) continue;
    kept.push(p);
    last = p;
  }
  if (kept.length && Math.hypot(kept[kept.length - 1][0] - p1[0], kept[kept.length - 1][1] - p1[1]) < SAMPLE_EPS)
    kept[kept.length - 1] = [p1[0], p1[1]];
  else kept.push([p1[0], p1[1]]);
  return kept;
}

// Tessellate a single contour into a CCW point ring. A legacy array is returned unchanged
// (identical to the former path); a path contour is walked start→segment→segment, lines
// pushing their `to`, arcs and cubics pushing their sampled points (sampleArc/sampleBezier).
export function tessellateContour(contour, segs) {
  if (Array.isArray(contour)) return contour;   // legacy point list: caller's data, bit-exact
  const ring = [[contour.start[0], contour.start[1]]];
  let prev = contour.start;
  for (const seg of contour.segments) {
    if (seg.c1) for (const p of sampleBezier(prev, seg.c1, seg.c2, seg.to, segs)) ring.push(p);
    else if (seg.via) for (const p of sampleArc(prev, seg.via, seg.to, segs)) ring.push(p);
    else ring.push([seg.to[0], seg.to[1]]);
    prev = seg.to;
  }
  // Coincident consecutive points never survive tessellation: a zero-length line segment
  // (or a sampler edge case) would otherwise land verbatim in the ring and hand every
  // consumer (extrude walls, mesh edge chains, silhouette masks) a degenerate edge. The
  // very last point is kept unconditionally — it replaces a duplicate predecessor rather
  // than being dropped — so the explicit-closure convention (final point lands exactly on
  // `start`) survives the sweep.
  const TESS_EPS = 1e-9;
  const out = [ring[0]];
  for (let i = 1; i < ring.length; i++) {
    const p = ring[i], last = out[out.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < TESS_EPS) {
      if (i === ring.length - 1) out[out.length - 1] = p;   // keep the exact closure point
      continue;
    }
    out.push(p);
  }
  // A path contour always tessellates to ≥2 points (start + arrival), even when the whole
  // contour is degenerate — consumers walk poly EDGES (contour-winding's pieceSamples) and
  // a single-point poly has none to walk.
  if (out.length < 2) return [ring[0], ring[ring.length - 1]];
  return out;
}

// Normalize + tessellate a whole region to { outer:[[x,y],…], holes:[[[x,y],…],…] } of
// point rings, ready for CrossSection.ofPolygons on the Manifold path.
export function tessellateProfile(profile, segs) {
  const { outer, holes } = normalizeProfile(profile);
  return { outer: tessellateContour(outer, segs), holes: holes.map((hl) => tessellateContour(hl, segs)) };
}

// Build a straight-edged path contour from a bare point list — the canonical lift for
// legacy [[x,y],…] inputs into the { start, segments } IR. Lives here (not contour-ops.js)
// so paper-bridge.js can reach it without importing contour-ops (contour-ops already
// imports paper-bridge; this module is a pure leaf both can share without a cycle).
export function pointsToContour(points) {
  return { start: [points[0][0], points[0][1]],
    segments: [...points.slice(1).map((p) => ({ to: [p[0], p[1]] })), { to: [points[0][0], points[0][1]] }] };
}

// Ensure a contour's ring is EXPLICITLY closed: the last segment's `to` must coincide
// with `start`. Several contour producers leave that closing edge only implicit —
// paper.js's own Path#closePath() (see toContour() in paper-bridge.js, which drops a
// straight closing edge as redundant) and any hand-authored `pathProfile(...).close()`
// that never revisits its own start — relying on a downstream consumer (tessellation,
// an SVG "Z") to re-synthesize the missing edge. `contourCorners`/`buildCornerOpRing`
// (contour-ops.js) don't re-synthesize anything: they read `contour.segments` directly
// and assume `segments[n-1]` really is the edge arriving back at `start` (corner 0's
// "previous segment", and the wraparound neighbor for every other corner's modular
// indexing). When that assumption is false, corner 0 gets paired with the wrong
// segment entirely — if that segment is curved, the fillet/chamfer tangency solve
// fails outright (`could not fit ... max ≈ 0`); if it's a line, the corner's position
// and radius are silently miscomputed instead. Call this wherever a contour is about
// to be stored (Shape2D regions) or handed to any contour-ops function; a no-op when
// the ring is already closed, so it's safe to call unconditionally.
export function closeContourGap(contour) {
  const segs = contour.segments;
  if (!segs || segs.length === 0) return contour;
  const [sx, sy] = contour.start;
  const [lx, ly] = segs[segs.length - 1].to;
  if (Math.hypot(lx - sx, ly - sy) <= 1e-9) return contour;
  return { start: contour.start, segments: [...segs, { to: [sx, sy] }] };
}

// Reverse a contour's traversal direction: walks segments back-to-front, swapping each
// cubic's control points (c1 ↔ c2) and keeping `via` (an arc's through-point is
// direction-independent). Lives here alongside pointsToContour for the same reason —
// paper-bridge.js's booleanRegions needs it to normalize emitted winding without
// importing contour-ops.js.
export function reverseContour(contour) {
  const pts = [contour.start, ...contour.segments.map((s) => s.to)];
  const segments = [];
  for (let i = contour.segments.length - 1; i >= 0; i--) {
    const s = contour.segments[i];
    const m = { to: [pts[i][0], pts[i][1]] };
    if (s.via) m.via = [s.via[0], s.via[1]];
    if (s.c1) { m.c1 = [s.c2[0], s.c2[1]]; m.c2 = [s.c1[0], s.c1[1]]; }
    segments.push(m);
  }
  return { start: [pts[pts.length - 1][0], pts[pts.length - 1][1]], segments };
}
