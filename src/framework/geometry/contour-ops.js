import { isPathContour, tessellateContour, pointsToContour, reverseContour, closeContourGap } from "./profile.js";
import { ringArea, pointInRing } from "./shape2d-regions.js";
import { arcToCubicSegments, arcCenterAndSweep, paperScope, toPaperPath, toContour, toOpenContour } from "./paper-bridge.js";

// Re-exported so existing importers (test/contour-ops-lift.test.js and others) keep
// working unchanged — the definitions live in profile.js (the contour-IR home) so
// paper-bridge.js can use them without importing this module (which already imports
// paper-bridge.js; importing back would cycle).
export { pointsToContour, reverseContour };

const WINDING_SEGS = 64;   // tessellation LOD for orientation/containment sampling

const isPointList = (x) => Array.isArray(x) && x.length > 0 && Array.isArray(x[0]);
// pointsToContour always closes explicitly; a raw {start,segments} contour (hand-authored
// via pathProfile, or handed back from a Shape2D's own stored regions) might not —
// closeContourGap is a no-op when it's already closed, so every ring liftProfile hands to
// contour-ops' corner/transform/query functions is guaranteed explicitly closed.
const liftContour = (c) => (isPointList(c) ? pointsToContour(c) : closeContourGap(c));

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

export function restoreProfile(kind, regions) {
  if (kind === "regions") return regions;
  if (kind === "region") return regions[0];
  const outer = regions[0].outer;
  if (kind === "contour") return outer;
  // "points": only restorable if every segment stayed a straight line
  if (outer.segments.every((s) => !s.c1 && !s.via)) {
    const pts = [outer.start, ...outer.segments.map((s) => s.to)];
    const [fx, fy] = pts[0], [lx, ly] = pts[pts.length - 1];
    if (Math.hypot(lx - fx, ly - fy) < 1e-9) pts.pop();   // drop the closing duplicate
    return pts;
  }
  return outer;   // curves were introduced — upgrade to a contour
}

export const contourIsCCW = (c) => ringArea(tessellateContour(c, WINDING_SEGS)) >= 0;

export function ensureRegionWinding(region) {
  return {
    outer: contourIsCCW(region.outer) ? region.outer : reverseContour(region.outer),
    holes: region.holes.map((h) => (contourIsCCW(h) ? reverseContour(h) : h)),
  };
}

// Affine transform core: M = [a, b, c, d, tx, ty], p' = [a·x + c·y + tx, b·x + d·y + ty]
const apply = (M, [x, y]) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
const isSimilarity = (M) => {
  const [a, b, c, d] = M;
  return Math.abs(a * a + b * b - (c * c + d * d)) < 1e-9 && Math.abs(a * c + b * d) < 1e-9;
};

function transformContour(contour, M) {
  const similar = isSimilarity(M);
  const segments = [];
  let prev = contour.start;
  for (const s of contour.segments) {
    if (s.via && !similar) {           // arc under a non-similarity map → cubics first
      for (const piece of arcToCubicSegments(prev, s.via, s.to)) segments.push(piece);
    } else segments.push(s);
    prev = s.to;
  }
  return { start: apply(M, contour.start), segments: segments.map((s) => {
    const m = { to: apply(M, s.to) };
    if (s.via) m.via = apply(M, s.via);
    if (s.c1) { m.c1 = apply(M, s.c1); m.c2 = apply(M, s.c2); }
    return m;
  }) };
}

function transformProfile(input, M) {
  const { kind, regions } = liftProfile(input);
  const flips = M[0] * M[3] - M[1] * M[2] < 0;
  let out = regions.map((rg) => ({ outer: transformContour(rg.outer, M), holes: rg.holes.map((h) => transformContour(h, M)) }));
  if (flips) {
    out = (kind === "region" || kind === "regions")
      ? out.map(ensureRegionWinding)
      // bare inputs: restore the ORIGINAL orientation sense of each ring
      : out.map((rg, i) => ({
          outer: contourIsCCW(rg.outer) === contourIsCCW(regions[i].outer) ? rg.outer : reverseContour(rg.outer),
          holes: rg.holes,
        }));
  }
  return restoreProfile(kind, out);
}

export const translateProfile = (input, [dx, dy]) => transformProfile(input, [1, 0, 0, 1, dx, dy]);
export function rotateProfile(input, deg, center = [0, 0]) {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t), [cx, cy] = center;
  return transformProfile(input, [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy]);
}
export function scaleProfile(input, s, center = [0, 0]) {
  const [sx, sy] = Array.isArray(s) ? s : [s, s];
  if (!(sx !== 0 && sy !== 0) || !Number.isFinite(sx) || !Number.isFinite(sy))
    throw new Error("scaleProfile: scale factors must be finite and non-zero");
  const [cx, cy] = center;
  return transformProfile(input, [sx, 0, 0, sy, cx - sx * cx, cy - sy * cy]);
}
export function mirrorProfile(input, axis) {
  if (axis === "x") return transformProfile(input, [1, 0, 0, -1, 0, 0]);
  if (axis === "y") return transformProfile(input, [-1, 0, 0, 1, 0, 0]);
  const { point: [px, py], dir: [ux0, uy0] } = axis;
  const L = Math.hypot(ux0, uy0);
  if (!(L > 0)) throw new Error('mirrorProfile: axis must be "x", "y", or {point, dir} with a non-zero dir');
  const ux = ux0 / L, uy = uy0 / L;
  const a = ux * ux - uy * uy, b = 2 * ux * uy;        // reflection across line through point along dir
  return transformProfile(input, [a, b, b, -a, px - a * px - b * py, py - b * px + a * py]);
}

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

const segType = (s) => (s.c1 ? "cubic" : s.via ? "arc" : "line");

function contourCorners(contour) {
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

// ── Fillet / chamfer ─────────────────────────────────────────────────────────
// Resolve opts.corners against a flat corner list (contourCorners()'s order, or
// profileCorners()'s flattened order for region/regions input — {indices} always
// indexes this array POSITIONALLY, matching profileCorners' documented contract).
// r/dist may be an array paired positionally with {indices}; every other selector
// broadcasts the scalar to every match. Throws when nothing matches.
//
// {indices} REJECTS any entry outside 0…corners.length-1 rather than dropping it.
// It used to filter silently, and the author who wrote `.map((c) => c.index)` —
// a vertex number, not a position — then filleted the wrong corners with no error
// once the out-of-range ones fell away (partforge-cloud feedback #95: ~15 applies
// chasing an L-bend whose arcs would not come out concentric). A throw that names
// the two fields is the coaching that ends that loop on the first attempt.
//
// {near} takes an optional `within` (mm). WITHOUT it the nearest `count` corners
// are always selected, however far away — "round the four outer corners" applied per
// compartment happily rounds the four corners nearest a small pocket that touches
// none of them. `within` turns a far pick into the same no-match error as any
// other empty selector.
function resolveCornerSelector(corners, param, opts, label) {
  const sel = (opts && opts.corners) ?? "all";
  const isArrayParam = Array.isArray(param);
  if (isArrayParam && !(sel && Array.isArray(sel.indices)))
    throw new Error(`${label}: a per-corner radius array requires a {corners: {indices}} selector`);
  let picked;
  if (sel === "all") picked = corners.map((corner) => ({ corner, param }));
  else if (sel === "convex") picked = corners.filter((c) => c.convex).map((corner) => ({ corner, param }));
  else if (sel === "concave") picked = corners.filter((c) => !c.convex).map((corner) => ({ corner, param }));
  else if (sel && Array.isArray(sel.indices)) {
    const perCorner = isArrayParam ? param : null;
    if (perCorner && perCorner.length !== sel.indices.length)
      throw new Error(`${label}: per-corner radius array has ${perCorner.length} entries but {indices} has ${sel.indices.length}`);
    const n = corners.length;
    picked = sel.indices.map((idx, j) => {
      if (!Number.isInteger(idx))
        throw new Error(`${label}: {indices} entry ${idx} is not an integer — {indices} takes each corner's \`position\` from profileCorners()`);
      if (idx < 0 || idx >= n)
        throw new Error(
          `${label}: {indices} entry ${idx} is out of range — profileCorners() reported ${n} corner${n === 1 ? "" : "s"} (positions 0…${Math.max(0, n - 1)}). ` +
          "{indices} takes each corner's `position` (its place in that list), not its `index` (its vertex number within the contour)",
        );
      return { corner: corners[idx], param: perCorner ? perCorner[j] : param };
    });
  } else if (sel && Array.isArray(sel.near)) {
    const [nx, ny] = sel.near;
    const count = sel.count ?? 1;
    const within = sel.within;
    if (within !== undefined && !(Number.isFinite(within) && within > 0))
      throw new Error(`${label}: {near} within must be a positive number of mm (got ${within})`);
    const distSq = (c) => (c.point[0] - nx) ** 2 + (c.point[1] - ny) ** 2;
    const candidates = within === undefined ? corners.slice() : corners.filter((c) => distSq(c) <= within * within);
    if (candidates.length === 0)
      throw new Error(`${label}: no corner within ${within}mm of (${nx}, ${ny}) — the nearest is ${Math.sqrt(Math.min(...corners.map(distSq))).toFixed(3)}mm away`);
    picked = candidates.sort((a, b) => distSq(a) - distSq(b)).slice(0, count).map((corner) => ({ corner, param }));
  } else picked = [];
  if (picked.length === 0) throw new Error(`${label}: no corner matched selector ${JSON.stringify(sel)}`);
  return picked;
}

const roundNice = (x) => Math.round(x * 1e6) / 1e6;

// ── Curve-adjacent corners (Task 7) ─────────────────────────────────────────
// Line-line corners keep buildCornerOpRing's exact closed-form path below.
// A corner with at least one curved (cubic/arc) neighbor goes through this
// numeric machinery instead: a 2-D evaluator per segment (`at(t)`/`tan(t)`),
// a damped-Newton tangency solver for fillet, and an arc-length solver (via
// paper.js) for chamfer. Both trim their curved neighbor exactly via
// de Casteljau splitting (cubic) or angle interpolation (arc).

const normalize2 = ([x, y]) => { const L = Math.hypot(x, y) || 1; return [x / L, y / L]; };
const rot90 = ([x, y]) => [-y, x];
const addScaled = (p, v, s) => [p[0] + v[0] * s, p[1] + v[1] * s];

export function cubicAt(p0, c1, c2, p1, t) {
  const u = 1 - t;
  return [0, 1].map((k) => u * u * u * p0[k] + 3 * u * u * t * c1[k] + 3 * u * t * t * c2[k] + t * t * t * p1[k]);
}
function cubicDeriv(p0, c1, c2, p1, t) {
  const u = 1 - t;
  return [0, 1].map((k) => 3 * u * u * (c1[k] - p0[k]) + 6 * u * t * (c2[k] - c1[k]) + 3 * t * t * (p1[k] - c2[k]));
}
// Exact de Casteljau split of cubic (p0,c1,c2,p1) at t → two exact cubic pieces.
export function splitCubic(p0, c1, c2, p1, t) {
  const lerp = (a, b) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const p01 = lerp(p0, c1), p12 = lerp(c1, c2), p23 = lerp(c2, p1);
  const p012 = lerp(p01, p12), p123 = lerp(p12, p23);
  const p0123 = lerp(p012, p123);
  return [{ p0, c1: p01, c2: p012, p1: p0123 }, { p0: p0123, c1: p123, c2: p23, p1 }];
}

// Evaluable curve E = {at(t), tan(t)} for a segment `seg` running from `from`
// (t=0) to seg.to (t=1). Mirrors segTangent's arc-tangent recovery exactly.
function curveEvaluator(from, seg) {
  if (seg.c1) {
    const p0 = from, c1 = seg.c1, c2 = seg.c2, p1 = seg.to;
    return { at: (t) => cubicAt(p0, c1, c2, p1, t), tan: (t) => normalize2(cubicDeriv(p0, c1, c2, p1, t)) };
  }
  if (seg.via) {
    const c = arcCenterAndSweep(from, seg.via, seg.to);
    if (c) {
      const a0 = Math.atan2(from[1] - c.center[1], from[0] - c.center[0]);
      return {
        at: (t) => { const a = a0 + c.dA * t; return [c.center[0] + c.r * Math.cos(a), c.center[1] + c.r * Math.sin(a)]; },
        tan: (t) => { const a = a0 + c.dA * t, rx = Math.cos(a), ry = Math.sin(a); return c.dA >= 0 ? [-ry, rx] : [ry, -rx]; },
      };
    }   // collinear (degenerate) triple → fall through to line below
  }
  const p0 = from, p1 = seg.to, d = normalize2([p1[0] - p0[0], p1[1] - p0[1]]);
  return { at: (t) => [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t], tan: () => d };
}

// Trim segment `seg` (running `from` → seg.to) to the sub-range [tStart,tEnd]
// of its own parameterization, returning {from, seg} for the kept portion.
// Cubic: two exact de Casteljau splits. Arc: angle interpolation, `via`
// recomputed at the kept sweep's angular midpoint. Line: trivial endpoints.
export function trimSegment(from, seg, tStart, tEnd) {
  if (seg.c1) {
    let cur = { p0: from, c1: seg.c1, c2: seg.c2, p1: seg.to };
    if (tStart > 1e-12) { cur = splitCubic(cur.p0, cur.c1, cur.c2, cur.p1, tStart)[1]; }
    const localEnd = tStart > 1e-12 ? (tEnd - tStart) / (1 - tStart) : tEnd;
    if (localEnd < 1 - 1e-12) cur = splitCubic(cur.p0, cur.c1, cur.c2, cur.p1, localEnd)[0];
    return { from: cur.p0, seg: { to: cur.p1, c1: cur.c1, c2: cur.c2 } };
  }
  if (seg.via) {
    const c = arcCenterAndSweep(from, seg.via, seg.to);
    if (c) {
      const a0 = Math.atan2(from[1] - c.center[1], from[0] - c.center[0]);
      const pointAt = (a) => [c.center[0] + c.r * Math.cos(a), c.center[1] + c.r * Math.sin(a)];
      const aS = a0 + c.dA * tStart, aE = a0 + c.dA * tEnd;
      return { from: pointAt(aS), seg: { to: pointAt(aE), via: pointAt((aS + aE) / 2) } };
    }
  }
  const p0 = from, p1 = seg.to;
  const at = (t) => [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
  return { from: at(tStart), seg: { to: at(tEnd) } };
}

const T_LO = 1e-6, T_HI = 1 - 1e-6;
const clampT = (v) => Math.min(T_HI, Math.max(T_LO, v));
const pinnedT = (t) => t[0] <= T_LO + 1e-12 || t[0] >= T_HI - 1e-12 || t[1] <= T_LO + 1e-12 || t[1] >= T_HI - 1e-12;

// Damped Newton on F: R² → R² (numeric Jacobian, h=1e-6), 40 iterations, step
// clamp 0.25, halving while |F| doesn't decrease (max 8 halvings). Returns
// {t, pinned} on convergence (|F| < 1e-9·max(1,r)) or null.
function newton2D(F, t0, r) {
  const h = 1e-6, tol = 1e-9 * Math.max(1, r);
  let t = [clampT(t0[0]), clampT(t0[1])];
  let Fv = F(t), normF = Math.hypot(Fv[0], Fv[1]);
  for (let iter = 0; iter < 40; iter++) {
    if (normF < tol) return { t, pinned: pinnedT(t) };
    const Fx = F([t[0] + h, t[1]]), Fy = F([t[0], t[1] + h]);
    const J00 = (Fx[0] - Fv[0]) / h, J10 = (Fx[1] - Fv[1]) / h;
    const J01 = (Fy[0] - Fv[0]) / h, J11 = (Fy[1] - Fv[1]) / h;
    const det = J00 * J11 - J01 * J10;
    if (Math.abs(det) < 1e-300) break;
    // Cramer's rule: [J00 J01; J10 J11]·delta = -Fv
    let delta = [(-Fv[0] * J11 + Fv[1] * J01) / det, (J00 * -Fv[1] - J10 * -Fv[0]) / det];
    delta = delta.map((d) => Math.max(-0.25, Math.min(0.25, d)));
    let tNew = [clampT(t[0] + delta[0]), clampT(t[1] + delta[1])];
    let FvNew = F(tNew), normNew = Math.hypot(FvNew[0], FvNew[1]);
    for (let halvings = 0; normNew >= normF && halvings < 8; halvings++) {
      delta = [delta[0] / 2, delta[1] / 2];
      tNew = [clampT(t[0] + delta[0]), clampT(t[1] + delta[1])];
      FvNew = F(tNew); normNew = Math.hypot(FvNew[0], FvNew[1]);
    }
    t = tNew; Fv = FvNew; normF = normNew;
  }
  return normF < tol ? { t, pinned: pinnedT(t) } : null;
}

// Solve for tangency points (tA on incoming curve A, tB on outgoing curve B)
// of a radius-r circle tangent to both, per the brief's F(tA,tB) = C_A − C_B.
// Tries all 4 inward-normal sign combos at the seed, keeping the one that
// minimizes |F| there (the combo landing on the corner's bisector side).
function solveFilletTangency(A, B, r) {
  const seed = [1 - 1e-3, 1e-3];
  const Ffor = (sA, sB) => (t) => {
    const CA = addScaled(A.at(t[0]), rot90(A.tan(t[0])), sA * r);
    const CB = addScaled(B.at(t[1]), rot90(B.tan(t[1])), sB * r);
    return [CA[0] - CB[0], CA[1] - CB[1]];
  };
  let best = null, bestNorm = Infinity;
  for (const sA of [1, -1]) for (const sB of [1, -1]) {
    const F = Ffor(sA, sB), f0 = F(seed), n = Math.hypot(f0[0], f0[1]);
    if (n < bestNorm) { bestNorm = n; best = { sA, sB, F }; }
  }
  const solved = newton2D(best.F, seed, r);
  if (!solved || solved.pinned) return null;
  const [tA, tB] = solved.t;
  const TA = A.at(tA), C = addScaled(TA, rot90(A.tan(tA)), best.sA * r);
  return { tA, tB, TA, TB: B.at(tB), C };
}

function bisectMaxRFillet(A, B, r) {
  let lo = 0, hi = r;
  for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (solveFilletTangency(A, B, mid)) lo = mid; else hi = mid; }
  return lo;
}

// Arc length of segment `seg` (from `from`); cubic arc length via a scratch
// open paper path (paper's numeric integration), line/arc in closed form.
function curveLength(from, seg) {
  if (seg.via) { const c = arcCenterAndSweep(from, seg.via, seg.to); return c ? Math.abs(c.dA) * c.r : Math.hypot(seg.to[0] - from[0], seg.to[1] - from[1]); }
  if (seg.c1) return toPaperPath(paperScope(), { start: from, segments: [seg] }, null, { open: true }).length;
  return Math.hypot(seg.to[0] - from[0], seg.to[1] - from[1]);
}
// t-parameter at arc-length `dist` along segment `seg` (from `from`, t=0).
function paramAtArcLength(from, seg, dist) {
  if (seg.via) { const c = arcCenterAndSweep(from, seg.via, seg.to); return c ? dist / (Math.abs(c.dA) * c.r) : dist / Math.hypot(seg.to[0] - from[0], seg.to[1] - from[1]); }
  if (seg.c1) return toPaperPath(paperScope(), { start: from, segments: [seg] }, null, { open: true }).curves[0].getParameterAt(dist);
  return dist / Math.hypot(seg.to[0] - from[0], seg.to[1] - from[1]);
}

// Chamfer's curve solver: no Newton needed — tA/tB are set directly by
// arc-length setbacks of `dist` from the corner, measured along each curve.
function solveChamferArcLength(fromA, segA, fromB, segB, dist) {
  if (!(dist > 0)) return null;
  const totalA = curveLength(fromA, segA), totalB = curveLength(fromB, segB);
  if (dist > totalA - 1e-9 || dist > totalB - 1e-9) return null;
  const tA = paramAtArcLength(fromA, segA, totalA - dist);
  const tB = paramAtArcLength(fromB, segB, dist);
  if (!(tA > T_LO && tA < T_HI && tB > T_LO && tB < T_HI)) return null;
  return { tA, tB, TA: curveEvaluator(fromA, segA).at(tA), TB: curveEvaluator(fromB, segB).at(tB) };
}

function bisectMaxDistChamfer(fromA, segA, fromB, segB, dist) {
  let lo = 0, hi = dist;
  for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (solveChamferArcLength(fromA, segA, fromB, segB, mid)) lo = mid; else hi = mid; }
  return lo;
}

// Solve one curve-adjacent corner (at least one of its two neighbors is a
// cubic or arc) and return {tA, tB, TA, TB, connector} — tA/tB in the
// neighbors' own parameterizations, ready for trimSegment(); connector is
// the {to,via?} spliced between the trimmed neighbors.
function solveCurveCorner(pts, contour, n, i, param, isFillet, label, record) {
  const inIdx = (i - 1 + n) % n, fromA = pts[inIdx], segA = contour.segments[inIdx];
  const fromB = pts[i], segB = contour.segments[i];
  const A = curveEvaluator(fromA, segA), B = curveEvaluator(fromB, segB);
  const p1 = pts[i];
  if (isFillet) {
    let solved = solveFilletTangency(A, B, param);
    if (!solved) {
      // Clamp rather than refuse. bisectMaxRFillet returns a radius the solver
      // ACCEPTED (lo only ever moves to a solved midpoint), so re-solving at it
      // succeeds — except when it never found one at all (lo stays 0), which is
      // a corner with no valid fillet at any radius and stays an error.
      const maxR = bisectMaxRFillet(A, B, param);
      solved = maxR > 0 ? solveFilletTangency(A, B, maxR) : null;
      if (!solved)
        throw new Error(`${label}: corner ${i} at (${p1[0]}, ${p1[1]}): could not fit r=${param} against the curved segment; max ≈ ${roundNice(maxR)}`);
      record?.(`${label}: corner ${i} at (${p1[0]}, ${p1[1]}): r=${param} does not fit against the curved segment — clamped to ${roundNice(maxR)}`);
      param = maxR;
    }
    const { tA, tB, TA, TB, C } = solved;
    const a0 = Math.atan2(TA[1] - C[1], TA[0] - C[0]);
    let dA = Math.atan2(TB[1] - C[1], TB[0] - C[0]) - a0;
    while (dA <= -Math.PI) dA += 2 * Math.PI;
    while (dA > Math.PI) dA -= 2 * Math.PI;
    const mid = a0 + dA / 2;
    const M = [C[0] + param * Math.cos(mid), C[1] + param * Math.sin(mid)];
    return { tA, tB, TA, connector: { to: TB, via: M } };
  }
  let solved = solveChamferArcLength(fromA, segA, fromB, segB, param);
  if (!solved) {
    // Same clamp-don't-refuse rule as the fillet branch above.
    const maxDist = bisectMaxDistChamfer(fromA, segA, fromB, segB, param);
    solved = maxDist > 0 ? solveChamferArcLength(fromA, segA, fromB, segB, maxDist) : null;
    if (!solved)
      throw new Error(`${label}: corner ${i} at (${p1[0]}, ${p1[1]}): could not fit dist=${param} against the curved segment; max ≈ ${roundNice(maxDist)}`);
    record?.(`${label}: corner ${i} at (${p1[0]}, ${p1[1]}): dist=${param} does not fit against the curved segment — clamped to ${roundNice(maxDist)}`);
    param = maxDist;
  }
  const { tA, tB, TA, TB } = solved;
  return { tA, tB, TA, connector: { to: TB } };
}

// Fillet/chamfer a single ring given its already-resolved {corner, param} picks.
// Mirrors cornerArc's tangent/center math (polygon.js:107) but WITHOUT its silent
// per-corner clamp — filletProfile/chamferProfile throw instead of clamping, so the
// clamp math is reproduced here unclamped, gated by our own explicit fit checks.
// ONE attempt at a ring, with `paramAt` supplying each selected corner's current
// magnitude. Per-corner over-runs are clamped in place here (each has its own
// computable ceiling); a SHARED-EDGE overlap cannot be, because shrinking one
// corner changes what its neighbour may claim — so those are reported back as
// `overlaps` for buildCornerOpRing's loop to resolve and retry.
function attemptCornerOpRing(contour, picks, isFillet, label, paramAt, clamp, record) {
  const n = contour.segments.length;
  const pts = [contour.start, ...contour.segments.map((s) => s.to)].slice(0, n);
  const plans = new Map();   // vertex index -> {A, B, M, setback} (line-line corners only)
  const curvePlans = new Map();   // vertex index -> {tA, tB, connector} (curve-adjacent corners)
  const selected = new Set(picks.map((p) => p.corner.index));   // this ring's selected vertex indices
  const overlaps = [];

  for (const { corner } of picks) {
    const i = corner.index;
    let param = paramAt(i);
    if (corner.segTypes[0] !== "line" || corner.segTypes[1] !== "line") {
      // Curve-adjacent corner: routed through the numeric tangency solver, never
      // through the line-line closed-form math below (exactness/speed for lines).
      curvePlans.set(i, solveCurveCorner(pts, contour, n, i, param, isFillet, label, record));
      continue;
    }
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
    const v0x = p0[0] - p1[0], v0y = p0[1] - p1[1], v2x = p2[0] - p1[0], v2y = p2[1] - p1[1];
    const l0 = Math.hypot(v0x, v0y), l2 = Math.hypot(v2x, v2y);
    const v0 = [v0x / l0, v0y / l0], v2 = [v2x / l2, v2y / l2];
    const cosA = Math.max(-1, Math.min(1, v0[0] * v2[0] + v0[1] * v2[1]));
    const half = Math.acos(cosA) / 2;                        // angle between the two edges, halved
    let setback = isFillet ? param / Math.tan(half) : param;
    // Per-corner ceiling: never past either edge's own end (hard cap, always full — a
    // tangent point can never pass an edge's own extent regardless of who else is
    // selected), and never past half the LONGER edge's "fair share" (soft cap). The soft
    // cap only halves an edge when its OTHER endpoint is ALSO among this operation's
    // selected corners — an isolated corner with an unselected neighbour gets that edge's
    // full length, since nothing else is claiming it. Exceeding one edge's fair share
    // alone isn't fatal (soft cap uses the more generous of the two); that's exactly what
    // the segment-level overlap check below is for.
    const prevShared = selected.has((i - 1 + n) % n), nextShared = selected.has((i + 1) % n);
    const softL0 = prevShared ? l0 / 2 : l0, softL2 = nextShared ? l2 / 2 : l2;
    const maxSetback = Math.min(l0, l2, Math.max(softL0, softL2));
    if (setback > maxSetback + 1e-9) {
      // Clamp to the ceiling this corner's own edges allow, and go on. The old
      // throw named the very number used here, so nothing is being guessed —
      // the caller is simply spared having to read an error and retry by hand.
      const maxParam = isFillet ? maxSetback * Math.tan(half) : maxSetback;
      const paramTxt = isFillet ? `r=${param}` : `dist=${param}`;
      record?.(`${label}: corner ${i} at (${p1[0]}, ${p1[1]}): ${paramTxt} does not fit — clamped to ${roundNice(maxParam)}`);
      clamp(i, maxParam);
      param = maxParam;
      setback = maxSetback;
    }
    const A = [p1[0] + v0[0] * setback, p1[1] + v0[1] * setback];
    const B = [p1[0] + v2[0] * setback, p1[1] + v2[1] * setback];
    let M;
    if (isFillet) {
      let bx = v0[0] + v2[0], by = v0[1] + v2[1];
      const bl = Math.hypot(bx, by);
      bx /= bl; by /= bl;
      const C = [p1[0] + bx * (param / Math.sin(half)), p1[1] + by * (param / Math.sin(half))];
      const a0 = Math.atan2(A[1] - C[1], A[0] - C[0]);
      let dA = Math.atan2(B[1] - C[1], B[0] - C[0]) - a0;      // short sweep from A to B
      while (dA <= -Math.PI) dA += 2 * Math.PI;
      while (dA > Math.PI) dA -= 2 * Math.PI;
      const mid = a0 + dA / 2;
      M = [C[0] + param * Math.cos(mid), C[1] + param * Math.sin(mid)];
    }
    plans.set(i, { A, B, M, setback });
  }

  for (let k = 0; k < n; k++) {                                // overlap: claims from BOTH ends of segment k,
    const kNext = (k + 1) % n;                                 // from either plans (line-line) or curvePlans
    const startPlan = plans.get(k), endPlan = plans.get(kNext);
    const startCurve = curvePlans.get(k), endCurve = curvePlans.get(kNext);
    if (!(startPlan || startCurve) || !(endPlan || endCurve)) continue;   // only one end claimed → no overlap possible
    const seg = contour.segments[k];
    if (seg.c1 || seg.via) {
      // Curved segment: only curve corners can claim it (line-line requires both
      // neighbors to be "line", so a curved seg is never in `plans`). Overlap ⇔
      // the kept t-span [startCurve.tB, endCurve.tA] collapses or reverses.
      // A curve segment's claims are t-parameters, which are not linear in the
      // magnitude, so there is no exact scale factor to solve for — report the
      // pair and let the loop back both off geometrically until they fit.
      if (endCurve.tA - startCurve.tB <= 1e-9) overlaps.push({ k, kNext, factor: null });
    } else {
      // Line segment: a curve-corner claim on it is a t-parameter (curvePlans.tB
      // measures forward from this segment's start; curvePlans.tA forward from its
      // start too, so the far-end claim is the remainder (1−tA)) — convert both to
      // the same setback-distance units buildCornerOpRing's line-line plans use.
      const segLen = Math.hypot(pts[kNext][0] - pts[k][0], pts[kNext][1] - pts[k][1]);
      const startClaim = startPlan ? startPlan.setback : startCurve.tB * segLen;
      const endClaim = endPlan ? endPlan.setback : (1 - endCurve.tA) * segLen;
      // On a straight segment the claim IS the setback, linear in the magnitude,
      // so the exact scale that makes the pair fit is solvable in one step.
      if (startClaim + endClaim > segLen + 1e-9)
        overlaps.push({ k, kNext, factor: segLen / (startClaim + endClaim) });
    }
  }

  const segments = [];
  let start = null;
  for (let i = 0; i < n; i++) {
    const startPlan = plans.get(i), endPlan = plans.get((i + 1) % n);
    const startCurve = curvePlans.get(i), endCurve = curvePlans.get((i + 1) % n);
    const seg = contour.segments[i];
    if ((seg.c1 || seg.via) && (startCurve || endCurve)) {
      // Segment itself is curved and trimmed by a curve-corner solve on one or
      // both ends: exact de Casteljau split (cubic) / angle interpolation (arc).
      const tStart = startCurve ? startCurve.tB : 0, tEnd = endCurve ? endCurve.tA : 1;
      segments.push(trimSegment(pts[i], seg, tStart, tEnd).seg);
    } else {
      const effEnd = endPlan ? endPlan.A : endCurve ? endCurve.TA : pts[(i + 1) % n];
      segments.push(startPlan || endPlan || startCurve || endCurve ? { to: effEnd } : seg);
    }
    if (i === 0) start = startPlan ? startPlan.B : startCurve ? startCurve.connector.to : pts[0];
    if (endPlan) segments.push(isFillet ? { to: endPlan.B, via: endPlan.M } : { to: endPlan.B });
    if (endCurve) segments.push(endCurve.connector);
  }
  return { ring: { start, segments }, overlaps };
}

// How many times the loop below may back off overlapping corner pairs. Each pass
// only ever REDUCES magnitudes and a straight-segment pair is solved exactly in
// one step, so real inputs settle in one or two; the bound exists so a
// pathological ring cannot spin, and reaching it is a genuine failure that
// throws rather than emitting a ring built from magnitudes still known to
// overlap.
const MAX_OVERLAP_PASSES = 8;

// Fillet/chamfer one ring, CLAMPING every magnitude that does not fit rather
// than refusing the whole profile. Two ceilings apply: a per-corner one, applied
// in place by the attempt above, and a shared-edge one between two corners
// claiming the same segment, resolved here because backing one corner off
// changes what its neighbour may take.
function buildCornerOpRing(contour, picks, isFillet, label, record) {
  const params = new Map(picks.map((p) => [p.corner.index, p.param]));
  const requested = new Map(params);
  for (let pass = 0; ; pass++) {
    const last = pass === MAX_OVERLAP_PASSES;
    const passClamps = new Map();   // corner -> per-corner ceiling this pass applied
    const messages = [];
    const { ring, overlaps } = attemptCornerOpRing(
      contour, picks, isFillet, label,
      (i) => params.get(i),
      (i, v) => passClamps.set(i, v),
      (msg) => messages.push(msg),
    );
    if (overlaps.length === 0) {
      // Report only now, from the pass that actually produced the ring: an
      // earlier pass's clamp is routinely superseded by a later, smaller one,
      // and emitting both would describe magnitudes the result never used.
      for (const msg of messages) record?.(msg);
      // A magnitude reduced by the overlap loop rather than by a per-corner
      // ceiling has no message of its own — the attempt never saw it as a
      // clamp, it was simply handed a smaller number. Report those here, so a
      // shared-edge shrink is as visible as a per-corner one.
      for (const { corner } of picks) {
        const i = corner.index, was = requested.get(i), now = params.get(i);
        if (now < was - 1e-9 && !passClamps.has(i))
          record?.(`${label}: corner ${i}: ${isFillet ? "r" : "dist"}=${was} overruns the edge it shares with a neighbouring corner — clamped to ${roundNice(now)}`);
      }
      return ring;
    }
    if (last)
      throw new Error(`${label}: corners ${overlaps[0].k} and ${overlaps[0].kNext} overlap on segment ${overlaps[0].k} (reduce r)`);
    for (const { k, kNext, factor } of overlaps) {
      // A hair under the exact fit so the next pass's `> segLen + 1e-9` test
      // clears rather than landing back on the boundary; a null factor (curved
      // segment, no closed-form scale) backs off geometrically instead.
      const f = factor === null ? 0.8 : factor * 0.999;
      for (const i of [k, kNext]) if (params.has(i)) params.set(i, params.get(i) * f);
    }
  }
}


function applyCornerOp(input, param, opts, label, isFillet, record) {
  const { kind, regions } = liftProfile(input);
  if (kind === "points" || kind === "contour") {
    const picks = resolveCornerSelector(contourCorners(regions[0].outer), param, opts, label);
    const outer = buildCornerOpRing(regions[0].outer, picks, isFillet, label, record);
    // Always surface a {start,segments} contour, even for a "points" input and an
    // all-line chamfer result: restoreProfile's points-downgrade is for shape-preserving
    // transforms, but a corner op changes the vertex count — it must not collapse back.
    return restoreProfile(kind === "points" ? "contour" : kind, [{ outer, holes: [] }]);
  }
  // region/regions: selector resolves against the flattened profileCorners() order;
  // picks are then grouped back by ring so each ring rebuilds independently.
  const newRegions = regions.map((rg) => ({ outer: rg.outer, holes: rg.holes.slice() }));
  const flat = [];
  newRegions.forEach((rg, ri) => {
    for (const c of contourCorners(rg.outer)) flat.push({ ...c, ringRef: { ri, key: "outer" } });
    rg.holes.forEach((h, hi) => { for (const c of contourCorners(h)) flat.push({ ...c, ringRef: { ri, key: "hole", hi } }); });
  });
  const picks = resolveCornerSelector(flat, param, opts, label);
  const byRing = new Map();
  for (const p of picks) {
    const r = p.corner.ringRef;
    const key = r.key === "outer" ? `${r.ri}:outer` : `${r.ri}:hole:${r.hi}`;
    if (!byRing.has(key)) byRing.set(key, { ringRef: r, picks: [] });
    byRing.get(key).picks.push(p);
  }
  for (const { ringRef, picks: ringPicks } of byRing.values()) {
    const rg = newRegions[ringRef.ri];
    const contour = ringRef.key === "outer" ? rg.outer : rg.holes[ringRef.hi];
    const rebuilt = buildCornerOpRing(contour, ringPicks, isFillet, label, record);
    if (ringRef.key === "outer") rg.outer = rebuilt; else rg.holes[ringRef.hi] = rebuilt;
  }
  return restoreProfile(kind, newRegions);
}

// `record` receives one message per magnitude CLAMPED to what the geometry can
// take (see buildCornerOpRing). Defaulted to console.warn so a direct call still
// says something; Shape2D threads its kernel's recorder in, which is what puts a
// clamp on the build result where a caller — or the cloud agent — can act on it.
export function filletProfile(input, r, opts, record = defaultRecord) {
  return applyCornerOp(input, r, opts, "filletProfile", true, record);
}

export function chamferProfile(input, dist, opts, record = defaultRecord) {
  return applyCornerOp(input, dist, opts, "chamferProfile", false, record);
}

const defaultRecord = (msg) => console.warn(`partforge: ${msg}`);

// ── simplifyProfile (Task 9) ─────────────────────────────────────────────────
// Corner-preserving decimation/refit: split each contour at its corners (contourCorners,
// SMOOTH_JOINT_DEG), then reduce each run independently, and reassemble. Corner points are
// always bit-exact preserved — a run's endpoints are the corners bounding it.
//
// A run is only cheaply "line-only" when EVERY point in it is exactly collinear with its
// neighbors (the walk below drops every interior vertex) — that's the common polygon case
// (extra waypoints along an otherwise-straight edge) and stays bit-exact, no paper involved.
// A line-typed run that does NOT fully collapse (an over-segmented, smoothly-curving
// polyline — every joint below SMOOTH_JOINT_DEG so none of it split off into its own
// corner, but never exactly straight either) falls through to the same paper refit as a
// run that already contains a real arc/cubic segment. Arcs come back as cubics after paper's
// fit (paper has no arc primitive) — a "points"/"contour" input that gains cubics upgrades
// to a contour on restore (restoreProfile's existing curves-introduced check, same mechanism
// applyCornerOp relies on for corner ops).
function mergeCollinearRun(points) {
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const p0 = out[out.length - 1], p1 = points[i], p2 = points[i + 1];
    const v1 = [p1[0] - p0[0], p1[1] - p0[1]], v2 = [p2[0] - p1[0], p2[1] - p1[1]];
    const cross = v1[0] * v2[1] - v1[1] * v2[0];
    const mag1 = Math.hypot(v1[0], v1[1]), mag2 = Math.hypot(v2[0], v2[1]);
    if (Math.abs(cross) < 1e-9 * mag1 * mag2) continue;   // exactly collinear — drop p1
    out.push(p1);
  }
  out.push(points[points.length - 1]);
  return out;
}

// paper's Path#simplify() fits only through the path's EXISTING anchor points (paper's
// PathFitter reads path._segments directly, never samples along existing curves) — handed a
// sparse, already-curved path (e.g. one authored arc segment) it fits a curve through just
// the two endpoints, which degenerates toward their straight chord. flatten() first samples
// the true curve into a dense polyline so simplify() has real shape to fit against; its own
// tolerance is a small fraction of the caller's so flattening error never dominates the fit.
function flattenThenSimplify(path, tolerance) {
  path.flatten(Math.max(tolerance / 20, 1e-6));
  path.simplify(tolerance);
}

// Refit an open run (from `from` through `segs`, the run's OWN segments — real arcs/cubics
// preserved, never flattened to their endpoints) via paper's simplify; pin the exact corner
// coordinate back onto the last anchor (paper may nudge endpoints during the fit) and return
// the run's replacement segments.
function refitRunViaPaper(scope, from, segs, tolerance) {
  const sub = { start: from, segments: segs };
  const path = toPaperPath(scope, sub, null, { open: true });
  flattenThenSimplify(path, tolerance);
  const out = toOpenContour(path);
  const lastTo = segs[segs.length - 1].to;
  out.segments[out.segments.length - 1].to = [lastTo[0], lastTo[1]];
  return out.segments;
}

// One corner-to-corner run: `from`/segs describe it (segs[i] runs pts[i]->pts[i+1], pts[0]
// === from). Pure-line runs get an exact collinear-merge attempt first; only a run that
// doesn't fully collapse to its two endpoints (i.e. it isn't really straight) falls through
// to paper. A run with any real curve segment (arc/cubic) always goes straight to paper,
// with its original curve data intact (never flattened to a chord first).
function simplifyRun(scope, from, segs, tolerance) {
  const allLines = segs.every((s) => !s.c1 && !s.via);
  if (allLines) {
    const pts = [from, ...segs.map((s) => s.to)];
    const merged = mergeCollinearRun(pts);
    if (merged.length === 2) return [{ to: [merged[1][0], merged[1][1]] }];   // exactly straight
    return refitRunViaPaper(scope, from, merged.slice(1).map((p) => ({ to: p })), tolerance);
  }
  return refitRunViaPaper(scope, from, segs, tolerance);
}

// Sweep segments whose ENTIRE extent (endpoint and every control point) stays within the
// caller's tolerance of their own start — degenerate loop-backs and dust segments. These
// are exactly the artifacts an upstream offset/boolean can leave behind (the winding
// resolver's splice debris: zero-chord cubics with controls ~0.01-0.03 mm out), and
// without this pass they DEFEAT simplify: contourCorners reads the loop's joints as real
// corners, and the corner-preserving contract then pins the debris bit-exact, so
// `.simplify(0.03)` used to return a 0.02 mm loop untouched. Dropping a segment moves the
// path by at most its chord (≤ tolerance) — precisely the change the caller authorized.
// Everything larger than the tolerance is geometry, not debris, and passes through.
function sweepDegenerateSegments(contour, tolerance) {
  const segments = [];
  let from = contour.start;
  for (const seg of contour.segments) {
    const controls = [seg.via, seg.c1, seg.c2].filter(Boolean);
    const extent = Math.max(
      Math.hypot(seg.to[0] - from[0], seg.to[1] - from[1]),
      ...controls.map((p) => Math.hypot(p[0] - from[0], p[1] - from[1])),
    );
    if (extent <= tolerance) continue;              // debris: path continues from `from`
    segments.push(seg);
    from = seg.to;
  }
  if (segments.length < 2) return contour;          // a ring of dust is not ours to delete
  return closeContourGap({ start: [contour.start[0], contour.start[1]], segments });
}

function simplifyContour(scope, rawContour, tolerance) {
  const contour = sweepDegenerateSegments(rawContour, tolerance);
  const corners = contourCorners(contour);
  if (corners.length === 0) {
    // Cornerless (smooth closed loop): simplify as ONE closed path — toPaperPath's default
    // (open: false) already closes it (path.closed = true) so paper fits smoothly across
    // the seam instead of treating the start point as a free open endpoint.
    const path = toPaperPath(scope, contour);
    flattenThenSimplify(path, tolerance);
    return closeContourGap(toContour(path));
  }
  const n = contour.segments.length;
  const startIdx = corners[0].index;
  const pts0 = [contour.start, ...contour.segments.map((s) => s.to)];   // length n+1, pts0[n] === contour.start
  const segs = [...contour.segments.slice(startIdx), ...contour.segments.slice(0, startIdx)];
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(pts0[(startIdx + i) % n]);      // rotated to start at the first corner
  const rotatedCornerIdx = corners.map((c) => (c.index - startIdx + n) % n);   // ascending, [0] === 0

  const segments = [];
  for (let j = 0; j < rotatedCornerIdx.length; j++) {
    const r0 = rotatedCornerIdx[j];
    const r1 = j + 1 < rotatedCornerIdx.length ? rotatedCornerIdx[j + 1] : n;
    segments.push(...simplifyRun(scope, pts[r0], segs.slice(r0, r1), tolerance));
  }
  return { start: [pts[0][0], pts[0][1]], segments };
}

export function simplifyProfile(input, tolerance) {
  const { kind, regions } = liftProfile(input);
  const scope = paperScope();
  try {
    const out = regions.map((rg) => ({
      outer: simplifyContour(scope, rg.outer, tolerance),
      holes: rg.holes.map((h) => simplifyContour(scope, h, tolerance)),
    }));
    return restoreProfile(kind, out);
  } finally {
    scope.project.clear();
  }
}

// ── Queries (Task 8) ─────────────────────────────────────────────────────────
// Arc-length queries (length/pointAt/tangentAt) only make sense on a single open/closed
// contour, not a multi-ring region — liftProfile's "points"/"contour" kinds are the two
// bare-contour shapes; everything else (region/regions) is rejected with a pointer to the
// per-ring accessors. All three route through paper.js for exact curve arc-length.
function singleContour(input, fnName) {
  const { kind, regions } = liftProfile(input);
  if (kind !== "points" && kind !== "contour")
    throw new Error(`${fnName}: pass a single contour (use region.outer / region.holes[i])`);
  return regions[0].outer;
}

function lengthToParam(path, opts, fnName) {
  if (opts && Number.isFinite(opts.t)) return opts.t * path.length;
  if (opts && Number.isFinite(opts.length)) return Math.min(path.length, Math.max(0, opts.length));
  throw new Error(`${fnName}: pass a finite {t} or {length}`);
}

export function profileLength(input) {
  const contour = singleContour(input, "profileLength");
  const scope = paperScope();
  try {
    return toPaperPath(scope, contour).length;
  } finally {
    scope.project.clear();
  }
}

export function profilePointAt(input, opts) {
  const contour = singleContour(input, "profilePointAt");
  const scope = paperScope();
  try {
    const path = toPaperPath(scope, contour);
    const len = lengthToParam(path, opts, "profilePointAt");
    const pt = path.getPointAt(len);
    return [pt.x, pt.y];
  } finally {
    scope.project.clear();
  }
}

export function profileTangentAt(input, opts) {
  const contour = singleContour(input, "profileTangentAt");
  const scope = paperScope();
  try {
    const path = toPaperPath(scope, contour);
    const len = lengthToParam(path, opts, "profileTangentAt");
    const tan = path.getTangentAt(len);
    return [tan.x, tan.y];
  } finally {
    scope.project.clear();
  }
}

export function profileNearestPoint(input, [x, y]) {
  const { regions } = liftProfile(input);
  const scope = paperScope();
  try {
    let best = null;
    let contourIndex = 0;
    for (const rg of regions) {
      for (const contour of [rg.outer, ...rg.holes]) {
        const segMap = [];
        const path = toPaperPath(scope, contour, segMap);
        const loc = path.getNearestLocation(new scope.Point(x, y));
        if (!best || loc.distance < best.distance) {
          best = {
            point: [loc.point.x, loc.point.y],
            distance: loc.distance,
            contourIndex,
            segmentIndex: segMap[loc.index],
            t: loc.time,
          };
        }
        contourIndex++;
      }
    }
    return best;
  } finally {
    scope.project.clear();
  }
}

export function profileBounds(input) {
  const { regions } = liftProfile(input);
  const scope = paperScope();
  try {
    let min = null, max = null;
    for (const rg of regions) {
      for (const contour of [rg.outer, ...rg.holes]) {
        const b = toPaperPath(scope, contour).bounds;
        const lo = [b.left, b.top], hi = [b.right, b.bottom];
        min = min ? [Math.min(min[0], lo[0]), Math.min(min[1], lo[1])] : lo;
        max = max ? [Math.max(max[0], hi[0]), Math.max(max[1], hi[1])] : hi;
      }
    }
    return { min, max };
  } finally {
    scope.project.clear();
  }
}

export function profileArea(input) {
  const { regions } = liftProfile(input);
  const scope = paperScope();
  try {
    let area = 0;
    for (const rg of regions) {
      area += Math.abs(toPaperPath(scope, rg.outer).area);
      for (const h of rg.holes) area -= Math.abs(toPaperPath(scope, h).area);
    }
    return area;
  } finally {
    scope.project.clear();
  }
}

export function profileContains(input, [x, y]) {
  const { regions } = liftProfile(input);
  const scope = paperScope();
  try {
    const point = new scope.Point(x, y);
    return regions.some((rg) => {
      const children = [rg.outer, ...rg.holes].map((c) => toPaperPath(scope, c));
      const compound = new scope.CompoundPath({ children, insert: false, fillRule: "evenodd" });
      return compound.contains(point);
    });
  } finally {
    scope.project.clear();
  }
}

// ── validateProfile (Task 10) ─────────────────────────────────────────────────
// Geometric sanity checks against a profile's SAMPLED (piecewise-linear) approximation.
// Never throws on geometric badness — only liftProfile's own "can't make sense of this
// input" throw propagates. contourIndex uses the same flattened outer-then-holes-per-region
// numbering as profileNearestPoint.

const VALIDATE_SEGS = 8;             // uniform-parameter samples per curved segment
const DEGENERATE_EPS = 1e-9;         // chord+control-net length / |ringArea| floor

const ptDist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Per segment: line -> [to]; cubic/arc -> VALIDATE_SEGS uniform-parameter points (t =
// i/VALIDATE_SEGS, i=1..VALIDATE_SEGS), last pinned exactly to `to`. A collinear (degenerate)
// arc triple has no center — falls back to a single point, same as a line. Every sample keeps
// its source segmentIndex.
function sampleForValidation(contour) {
  const out = [];
  let from = contour.start;
  contour.segments.forEach((seg, si) => {
    if (seg.c1) {
      for (let i = 1; i <= VALIDATE_SEGS; i++) out.push({ p: cubicAt(from, seg.c1, seg.c2, seg.to, i / VALIDATE_SEGS), segmentIndex: si });
      out[out.length - 1].p = [seg.to[0], seg.to[1]];
    } else if (seg.via) {
      const c = arcCenterAndSweep(from, seg.via, seg.to);
      if (c) {
        const a0 = Math.atan2(from[1] - c.center[1], from[0] - c.center[0]);
        for (let i = 1; i <= VALIDATE_SEGS; i++) {
          const a = a0 + c.dA * (i / VALIDATE_SEGS);
          out.push({ p: [c.center[0] + c.r * Math.cos(a), c.center[1] + c.r * Math.sin(a)], segmentIndex: si });
        }
        out[out.length - 1].p = [seg.to[0], seg.to[1]];
      } else out.push({ p: [seg.to[0], seg.to[1]], segmentIndex: si });
    } else out.push({ p: [seg.to[0], seg.to[1]], segmentIndex: si });
    from = seg.to;
  });
  return out;
}

// chord + control-net length < DEGENERATE_EPS — both the endpoints AND any control/via
// points must collapse together; a curve that loops back near its own start (small chord,
// large control net) is real shape, not degeneracy.
function segmentDegenerate(from, seg) {
  const chord = ptDist(from, seg.to);
  let controlNet = 0;
  if (seg.c1) controlNet = ptDist(from, seg.c1) + ptDist(seg.c1, seg.c2) + ptDist(seg.c2, seg.to);
  else if (seg.via) controlNet = ptDist(from, seg.via) + ptDist(seg.via, seg.to);
  return chord + controlNet < DEGENERATE_EPS;
}

// Two 2-D line segments p1->p2 and p3->p4 → their intersection point, or null. Tiny outward
// epsilon on the [0,1] parameter clamp so touching-at-an-endpoint pairs still register.
function segmentIntersect(p1, p2, p3, p4) {
  const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1];
  const d2x = p4[0] - p3[0], d2y = p4[1] - p3[1];
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-15) return null;   // parallel (collinear overlap not specially handled)
  const ex = p3[0] - p1[0], ey = p3[1] - p1[1];
  const t = (ex * d2y - ey * d2x) / denom;
  const u = (ex * d1y - ey * d1x) / denom;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return [p1[0] + t * d1x, p1[1] + t * d1y];
}

// One contour's cyclic vertex loop, deduplicated: `start` plus every sample, with the
// trailing duplicate-of-`start` point (contours that close via their own last segment,
// the common case) dropped so the wraparound edge lands exactly on the real final segment
// instead of a spurious zero-length "closing" edge — that phantom edge would otherwise
// break index-adjacency between the first and last real edges (they'd no longer be ±1
// apart). `verts` (used for area/containment, where a repeated or missing point is
// immaterial) keeps every sample; `edges` (used for self-intersection) additionally DROPS
// any zero-length edge, wherever it falls — a duplicate consecutive point anywhere in the
// contour (not just at the closing seam) would otherwise widen the index-gap between its
// two genuinely-adjacent neighbors past the ±1 rule, so they'd be tested against each other
// and "cross" at the shared vertex they both already touch. Each surviving edge keeps the
// ORIGINAL segmentIndex that produced its target vertex; an open contour's synthetic
// wraparound edge (start not reached by any real segment) is tagged with the synthetic
// index contour.segments.length, matching profileNearestPoint's convention for paper's own
// synthesized closing curve.
function contourLoop(contour) {
  const samples = sampleForValidation(contour);
  const N = samples.length;
  const V = [[contour.start[0], contour.start[1]], ...samples.map((s) => s.p)];
  const closed = N > 0 && ptDist(V[N], V[0]) < DEGENERATE_EPS;
  const verts = closed ? V.slice(0, N) : V;
  const m = verts.length;
  const rawEdges = [];
  for (let i = 0; i < m; i++) {
    const targetIdx = (i + 1) % m;
    const segmentIndex = targetIdx === 0
      ? (closed ? samples[N - 1].segmentIndex : contour.segments.length)
      : samples[targetIdx - 1].segmentIndex;
    rawEdges.push({ a: verts[i], b: verts[targetIdx], segmentIndex });
  }
  const edges = rawEdges.filter((e) => ptDist(e.a, e.b) >= DEGENERATE_EPS);
  return { verts, samples, edges };
}

// Flattened outer-then-holes-per-region list, contourIndex running across ALL regions —
// same order/numbering profileNearestPoint uses.
function flattenForValidation(regions) {
  const flat = [];
  let contourIndex = 0;
  regions.forEach((rg, regionIndex) => {
    flat.push({ contour: rg.outer, role: "outer", regionIndex, contourIndex: contourIndex++ });
    rg.holes.forEach((h, holeIndex) => flat.push({ contour: h, role: "hole", holeIndex, regionIndex, contourIndex: contourIndex++ }));
  });
  return flat.map((f) => ({ ...f, loop: contourLoop(f.contour) }));
}

// Self-intersection within ONE region: all sampled edges of ALL its contours (outer +
// holes) go into a uniform grid (cell = region bbox max-dim / 64); candidate pairs sharing
// a cell are tested once each (deduped across cells), skipping edges adjacent in the same
// contour (index ±1, wrap-aware — see contourLoop). Cross-contour pairs within the region
// (e.g. outer vs. its own hole) are NOT skipped; cross-REGION pairs are never considered
// here (handled by nesting).
function selfIntersectionInRegion(contours) {
  const edges = [];
  for (const c of contours) {
    const n = c.loop.edges.length;
    c.loop.edges.forEach((e, i) => {
      edges.push({ a: e.a, b: e.b, contourIndex: c.contourIndex, localIndex: i, n, segmentIndex: e.segmentIndex });
    });
  }
  const issues = [], flagged = new Set();
  if (edges.length < 2) return { issues, flagged };

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of edges) for (const p of [e.a, e.b]) {
    minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]);
  }
  const cellSize = Math.max(maxX - minX, maxY - minY) / 64 || 1e-6;
  const grid = new Map();
  edges.forEach((e, idx) => {
    const lox = Math.min(e.a[0], e.b[0]), hix = Math.max(e.a[0], e.b[0]);
    const loy = Math.min(e.a[1], e.b[1]), hiy = Math.max(e.a[1], e.b[1]);
    const cx0 = Math.floor((lox - minX) / cellSize), cx1 = Math.floor((hix - minX) / cellSize);
    const cy0 = Math.floor((loy - minY) / cellSize), cy1 = Math.floor((hiy - minY) / cellSize);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const key = `${cx},${cy}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(idx);
    }
  });

  const tested = new Set();
  for (const cellEdges of grid.values()) {
    for (let a = 0; a < cellEdges.length; a++) {
      for (let b = a + 1; b < cellEdges.length; b++) {
        const i = cellEdges[a], j = cellEdges[b];
        const key = i < j ? `${i}:${j}` : `${j}:${i}`;
        if (tested.has(key)) continue;
        tested.add(key);
        const eI = edges[i], eJ = edges[j];
        if (eI.contourIndex === eJ.contourIndex) {
          const d = (eI.localIndex - eJ.localIndex + eI.n) % eI.n;
          if (d === 1 || d === eI.n - 1) continue;   // adjacent in the same contour
        }
        const pt = segmentIntersect(eI.a, eI.b, eJ.a, eJ.b);
        if (!pt) continue;
        const first = eI.contourIndex <= eJ.contourIndex ? eI : eJ;
        const other = first === eI ? eJ : eI;
        const crossContour = other.contourIndex !== first.contourIndex;
        const crossSuffix = crossContour ? ` (or crosses contour ${other.contourIndex})` : "";
        issues.push({
          type: "self-intersection", contourIndex: first.contourIndex, segmentIndex: first.segmentIndex, point: pt,
          // `crosses` (present ONLY on a contact between two contours of this
          // region — an outer and its own hole, typically a hole drawn flush with
          // the outer wall) separates that case from a contour crossing ITSELF.
          // Both are reported; only the latter inverts the fill, so the build
          // warning in profile-warnings.js reports the ones without this key.
          ...(crossContour ? { crosses: other.contourIndex } : {}),
          message: `contour ${first.contourIndex} self-intersects${crossSuffix} near (${pt[0].toFixed(4)}, ${pt[1].toFixed(4)})`,
        });
        flagged.add(eI.contourIndex); flagged.add(eJ.contourIndex);
      }
    }
  }
  return { issues, flagged };
}

export function validateProfile(input) {
  const { kind, regions } = liftProfile(input);
  const issues = [];
  const flat = flattenForValidation(regions);

  // 1a. Per-segment degenerate (chord + control-net length near zero).
  for (const f of flat) {
    let from = f.contour.start;
    f.contour.segments.forEach((seg, si) => {
      if (segmentDegenerate(from, seg))
        issues.push({ type: "degenerate", contourIndex: f.contourIndex, segmentIndex: si, message: `contour ${f.contourIndex} segment ${si} is degenerate (near-zero length)` });
      from = seg.to;
    });
  }

  // 1a'. Non-finite coordinates (NaN/±Infinity) anywhere in a contour's start/segment
  // points/controls. Every other check below is arithmetic comparisons against NaN, which
  // are always false — so without this sweep a contour with e.g. a NaN corner radius baked
  // into it would silently validate ok:true instead of surfacing the bad geometry.
  for (const f of flat) {
    let from = f.contour.start;
    f.contour.segments.forEach((seg, si) => {
      const pts = [from, seg.to, seg.via, seg.c1, seg.c2].filter(Boolean);
      if (pts.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1])))
        issues.push({ type: "degenerate", contourIndex: f.contourIndex, segmentIndex: si, message: `contour ${f.contourIndex} segment ${si} has non-finite coordinates` });
      from = seg.to;
    });
  }

  // 2. Self-intersection, within-region only.
  const byRegion = new Map();
  for (const f of flat) {
    if (!byRegion.has(f.regionIndex)) byRegion.set(f.regionIndex, []);
    byRegion.get(f.regionIndex).push(f);
  }
  const selfIntersecting = new Set();
  for (const contours of byRegion.values()) {
    const { issues: regionIssues, flagged } = selfIntersectionInRegion(contours);
    issues.push(...regionIssues);
    for (const c of flagged) selfIntersecting.add(c);
  }

  // 1b. Per-contour degenerate area (sampled |ringArea| near zero) — skip contours already
  // flagged self-intersecting: a self-crossing ring's near-zero SIGNED area is a byproduct
  // of the crossing (opposite-winding lobes cancel), not evidence the ring is truly tiny.
  for (const f of flat) {
    if (selfIntersecting.has(f.contourIndex)) continue;
    if (Math.abs(ringArea(f.loop.verts)) < DEGENERATE_EPS)
      issues.push({ type: "degenerate", contourIndex: f.contourIndex, message: `contour ${f.contourIndex} has near-zero area` });
  }

  // 3. Winding — explicit region/regions input only (a bare contour/point list has no
  // declared outer/hole role to check).
  if (kind === "region" || kind === "regions") {
    for (const f of flat) {
      const area = ringArea(f.loop.verts);
      if (f.role === "outer" && area < 0)
        issues.push({ type: "winding", contourIndex: f.contourIndex, message: `contour ${f.contourIndex} (outer) winds clockwise; outers must be CCW` });
      if (f.role === "hole" && area > 0)
        issues.push({ type: "winding", contourIndex: f.contourIndex, message: `contour ${f.contourIndex} (hole) winds counter-clockwise; holes must be CW` });
    }
  }

  // 4a. Nesting: each hole's first sample must land inside its own outer.
  const outerByRegion = new Map();
  for (const f of flat) if (f.role === "outer") outerByRegion.set(f.regionIndex, f);
  for (const f of flat) {
    if (f.role !== "hole") continue;
    const outer = outerByRegion.get(f.regionIndex);
    const testPoint = f.loop.samples.length ? f.loop.samples[0].p : f.contour.start;
    if (!pointInRing(testPoint, outer.loop.verts))
      issues.push({ type: "nesting", contourIndex: f.contourIndex, message: `contour ${f.contourIndex} (hole) lies outside its outer (contour ${outer.contourIndex})` });
  }

  // 4b. Nesting: region pairs — any sampled vertex of one region's outer inside the
  // other's outer (checked both directions: overlap and full containment either way).
  const outers = flat.filter((f) => f.role === "outer");
  for (let a = 0; a < outers.length; a++) {
    for (let b = a + 1; b < outers.length; b++) {
      const A = outers[a], B = outers[b];
      const overlaps = B.loop.verts.some((p) => pointInRing(p, A.loop.verts)) || A.loop.verts.some((p) => pointInRing(p, B.loop.verts));
      if (overlaps)
        issues.push({
          type: "nesting", contourIndex: A.contourIndex,
          message: `regions overlap or nest — merge with union() or make it a hole (contours ${A.contourIndex} and ${B.contourIndex})`,
        });
    }
  }

  return { ok: issues.length === 0, issues };
}
