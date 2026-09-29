// The kit's drawing stage: the process-agnostic Drawing IR every cut-file writer reads,
// plus the two contour passes that run before any writer sees a ring. A Drawing is a
// sheet piece in its CANONICAL frame — mm, y up, the laser face seen from above —
// built from the piece's resolved 2-D declaration alone. Nothing here reads a pose or a
// solid (design spec D.1): the 3-D model is a preview of the cut file, never its source.
//
// The Drawing IR (contract §5.5): `layers` in LAYER_ORDER, each `{ id, paths }`, a path
// being `{ start, segments, closed }` whose segments ARE the contour IR (profile.js:
// `{to}` line, `{to, via}` three-point arc, `{to, c1, c2}` cubic) — there is no second
// segment type. `bounds` covers every layer after kerf; `nominal` is the cut layer's
// size before kerf, which the README's scale check prints.
//
// Why two refits. Every Shape2D boolean turns arcs into cubics (paper-bridge.js), so a
// hole cut with cutAll comes back as four cubics, and so does every exact arc a *Profile
// helper drew once a boolean has touched it; recoverArcs (arc-fit.js) turns those back
// into exact arcs. But a point list draws its curves as polygons — circlePolygon is a
// 48-gon (so is circleProfile, until partforge 0.132 makes it exact), the round
// *Polygon helpers' corners and ends are chords, a hand-sampled arc is its samples — and
// a laser traces every facet. refitLineRuns is the conservative second pass for those:
// a run becomes arcs only when at least `minVerts` consecutive vertices sit on one
// circle AND every step turns by at most `maxTurnDeg`, all the same way. A hexagon (60°
// turns) or a star (alternating turns) never qualifies; when the test misses something
// the output is dense, never wrong — and "never wrong" is held in millimetres: no
// authored vertex ends up more than REFIT_MAX_MOVE_MM from the output.
//
// LAZY: reachable only through process/exporters.js's dynamic import (and, from P2b,
// export/bundle.js's). It reaches paper (offsetRegions: contour-offset.js →
// paper-bridge.js — arc-fit.js is now a paper-free leaf, so recoverArcs no longer
// carries this), which is why lint, the oracle and partforge/geometry must never
// import it (test/kit-export-guards.test.js). It runs in the geometry worker, so it
// stays DOM-free and node:-free.
import { recoverArcs } from "../geometry/arc-fit.js";
import { arcCenterAndSweep } from "../geometry/arc-math.js";
import { cubicAt } from "../geometry/contour-ops.js";
import { offsetRegions } from "../geometry/contour-offset.js";
import { closeContourGap } from "../geometry/profile.js";
import { KIT_OPTIONS_ERROR } from "./formats.js";

// The cut order: marks first (the piece is still held by the sheet), holes before the
// outline that frees the piece. Writers emit layers in this order.
export const LAYER_ORDER = Object.freeze(["engrave", "score", "cut-inner", "cut-outer"]);
// engrave is a filled region; the rest are vector lines.
export const LAYER_KIND = Object.freeze({ engrave: "fill", score: "line", "cut-inner": "line", "cut-outer": "line" });

const TAU = 2 * Math.PI;
const CLOSE_EPS = 1e-9;   // mm — the storage invariant's "explicitly closed"
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const wrapPi = (a) => { a %= TAU; if (a > Math.PI) a -= TAU; else if (a <= -Math.PI) a += TAU; return a; };
const wrapTau = (a) => ((a % TAU) + TAU) % TAU;
const isLine = (s) => !s.via && !s.c1;

// Signed turn (radians, CCW positive) from edge a→b to edge b→c; NaN when an edge has no
// length (a duplicate vertex has no direction, so it can never sit inside a run).
function turnAt(a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]];
  if (Math.hypot(u[0], u[1]) < CLOSE_EPS || Math.hypot(v[0], v[1]) < CLOSE_EPS) return NaN;
  return Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]);
}

// The refit's promise, in mm: no authored vertex ends up farther than this from the arcs
// that replace its run. It caps the fit band — a band relative to the radius alone grows
// with it, and the three-point circle of a gently curving stretch can be metres wide —
// and every run is measured against its real output arcs before it is kept.
export const REFIT_MAX_MOVE_MM = 0.005;
// A run's radius may be at most this many times its chord (its diameter, for a run of
// half a turn or more): past that the "arc" is a flat stretch of some other curve, which
// the laser should trace as drawn, not a faceted circle to recover.
const REFIT_MAX_FLATNESS = 50;

// Fit the circle through vertices k..e of Q (via k, the one-third and the two-thirds
// vertex — three distinct points even when the run is a whole ring and Q[e] is Q[k]),
// then require EVERY vertex within tolerance of it, stepping round the centre in the
// run's turning direction. Returns the run's circle and accumulated sweep, or null.
function fitRun(Q, k, e, sign) {
  const m = e - k;
  const c = arcCenterAndSweep(Q[k], Q[k + Math.round(m / 3)], Q[k + Math.round((2 * m) / 3)]);
  if (!c || !(c.r > 0)) return null;
  const run = { center: c.center, r: c.r, tol: Math.min(Math.max(1e-6, 1e-4 * c.r), REFIT_MAX_MOVE_MM), sign, sweep: 0 };
  if (Math.abs(dist(Q[k], run.center) - run.r) > run.tol) return null;
  for (let i = k + 1; i <= e; i++) if (!extendRun(run, Q[i - 1], Q[i])) return null;
  return run;
}

// Does `q` continue `run` from `p` — on the circle, stepping the same way round, the
// whole run staying within one turn? Advances run.sweep when it does.
function extendRun(run, p, q) {
  if (Math.abs(dist(q, run.center) - run.r) > run.tol) return false;
  const ang = (x) => Math.atan2(x[1] - run.center[1], x[0] - run.center[0]);
  const step = wrapPi(ang(q) - ang(p));
  if (Math.sign(step) !== run.sign || Math.abs(run.sweep + step) > TAU + 1e-9) return false;
  run.sweep += step;
  return true;
}

// The arc from `from` to `to` about the run's circle as three-point arcs of at most 180°
// (the three-point form is ambiguous past that), `via` at each piece's angular middle,
// the final `to` pinned to the run's real last vertex.
function arcPieces(from, to, { center, r, sweep }) {
  const a0 = Math.atan2(from[1] - center[1], from[0] - center[0]);
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / Math.PI - 1e-9));
  const at = (t) => [center[0] + r * Math.cos(t), center[1] + r * Math.sin(t)];
  const out = [];
  for (let i = 0; i < n; i++) {
    const s0 = a0 + (sweep * i) / n, s1 = a0 + (sweep * (i + 1)) / n;
    out.push({ to: at(s1), via: at((s0 + s1) / 2) });
  }
  out[n - 1].to = [to[0], to[1]];
  return out;
}

// How far q is from the three-point arc from → via → to: the radial gap when q lies
// inside the sweep, else the distance to the nearer end.
function arcGap(q, from, { via, to }) {
  const g = arcCenterAndSweep(from, via, to);
  if (!g) return Infinity;
  const a0 = Math.atan2(from[1] - g.center[1], from[0] - g.center[0]);
  const along = wrapTau(Math.sign(g.dA) * (Math.atan2(q[1] - g.center[1], q[0] - g.center[0]) - a0));
  if (along <= Math.abs(g.dA) + 1e-12) return Math.abs(dist(q, g.center) - g.r);
  return Math.min(dist(q, from), dist(q, to));
}

// Keep a fitted run k..e only when it is a circle to recover and its arcs are faithful:
// not far flatter than it is long, and every vertex it replaces within
// REFIT_MAX_MOVE_MM of the arcs actually written (whose ends are the run's real,
// slightly off-circle, first and last vertices — so this is measured, not assumed).
function keepRun(Q, k, e, run, pieces) {
  const chord = Math.abs(run.sweep) >= Math.PI ? 2 * run.r : dist(Q[k], Q[e]);
  if (run.r > REFIT_MAX_FLATNESS * chord) return false;
  for (let i = k + 1; i < e; i++) {
    let from = Q[k], gap = Infinity;
    for (const s of pieces) { gap = Math.min(gap, arcGap(Q[i], from, s)); from = s.to; }
    if (!(gap <= REFIT_MAX_MOVE_MM)) return false;
  }
  return true;
}

// Runs of straight segments that trace a circle → three-point arcs. Curves pass through
// untouched and break runs. A closed ring is first re-seated at a "hard break" (a vertex
// no run can pass: a curve meets it, or it turns out of band) so a run that wraps the
// ring's start is seen whole; a ring with no hard break — a faceted circle — is tried as
// one run all the way round. Orientation is preserved. When nothing is refit the input
// contour is returned as-is (same object). Linear in the vertex count.
export function refitLineRuns(contour, { minVerts = 8, maxTurnDeg = 15 } = {}) {
  const segs = contour.segments;
  const n = segs.length;
  if (n < minVerts - 1) return contour;
  const maxTurn = (maxTurnDeg * Math.PI) / 180 + 1e-9;
  const inBand = (t) => Math.abs(t) > 1e-12 && Math.abs(t) <= maxTurn;   // NaN fails both
  const P = [contour.start, ...segs.map((s) => s.to)];
  const closed = dist(P[0], P[n]) <= CLOSE_EPS;

  let off = 0;
  if (closed) {
    for (let i = 0; i < n; i++) {
      const prev = (i + n - 1) % n;
      if (!isLine(segs[prev]) || !isLine(segs[i]) || !inBand(turnAt(P[prev], P[i], P[i + 1]))) { off = i; break; }
    }
  }
  const Q = closed ? [...P.slice(off, n), ...P.slice(0, off), P[off]] : P;
  const S = closed ? [...segs.slice(off), ...segs.slice(0, off)] : segs;

  const out = [];
  let changed = false;
  let k = 0, j = 0, sign = 0;
  while (k < n) {
    // Segments k..j-1 are straight, and every joint between them turns in band, one way.
    // Scanned once per run, not once per vertex: while a joint of the run lies ahead of
    // k (k + 1 < j), the run from k is the same run — same end, same turning sign.
    if (k + 1 >= j) {
      j = k; sign = 0;
      while (j < n && isLine(S[j])) {
        if (j > k) {
          const t = turnAt(Q[j - 1], Q[j], Q[j + 1]);
          if (!inBand(t) || (sign !== 0 && Math.sign(t) !== sign)) break;
          sign = Math.sign(t);
        }
        j++;
      }
    }
    let e = k + minVerts - 1;
    const run = sign !== 0 && e <= j ? fitRun(Q, k, e, sign) : null;
    if (!run) { out.push(S[k]); k++; continue; }
    while (e < j && extendRun(run, Q[e], Q[e + 1])) e++;
    const pieces = arcPieces(Q[k], Q[e], run);
    // A refused run stays as drawn, whole: any run inside it lies on the same circle.
    if (keepRun(Q, k, e, run, pieces)) { out.push(...pieces); changed = true; }
    else for (let i = k; i < e; i++) out.push(S[i]);
    k = e;
  }
  return changed ? { start: [Q[0][0], Q[0][1]], segments: out } : contour;
}

// Both refits, in order: cubic runs → arcs (recoverArcs), then line runs → arcs.
export const refitRing = (ring) => refitLineRuns(recoverArcs(ring));

// Split regions (Shape2D.toContours() form) into outer rings and hole rings, region by
// region — the cut-outer / cut-inner split, and the ring list a region layer draws.
export function ringsOf(regions) {
  return {
    outer: regions.map((rg) => rg.outer),
    holes: regions.flatMap((rg) => rg.holes),
  };
}

// Is point p inside `ring` (either winding)? The winding number, exact for lines and
// arcs — an arc sweeps its chord's angle, plus a whole turn when p lies in the circular
// segment between chord and arc — with cubics flattened. Exact matters: an island can
// sit a fraction of a millimetre inside the hole around it, where any chorded stand-in
// for the hole's arcs would put it outside.
function encloses(ring, p) {
  const turn = (a, b) => {
    const ux = a[0] - p[0], uy = a[1] - p[1], vx = b[0] - p[0], vy = b[1] - p[1];
    return Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  };
  const side = (a, b, q) => (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]);
  let w = 0, from = ring.start;
  for (const s of ring.segments) {
    if (s.c1) {
      let a = from;
      for (let i = 1; i <= 32; i++) { const b = i === 32 ? s.to : cubicAt(from, s.c1, s.c2, s.to, i / 32); w += turn(a, b); a = b; }
    } else {
      w += turn(from, s.to);
      const g = s.via ? arcCenterAndSweep(from, s.via, s.to) : null;
      if (g && dist(p, g.center) < g.r && Math.sign(side(from, s.to, p)) === Math.sign(side(from, s.to, s.via)))
        w += Math.sign(g.dA) * TAU;
    }
    from = s.to;
  }
  return Math.abs(w) > Math.PI;
}

// The cut layer's rings in CUT ORDER: every ring before any ring that encloses it, so no
// outline is cut on a piece that something else has already freed. A ring's depth is how
// many other rings enclose it (rings of a valid profile never cross, so its start point
// answers for all of it); deepest first, region order within a depth. `inner` is every
// enclosed ring — holes, and islands standing in a hole with their own holes — and
// `outer` the top-level outlines, the cuts that free the pieces. A piece of one region
// comes back as its holes then its outline, exactly as ringsOf splits it.
export function cutRings(regions) {
  const rings = regions.flatMap((rg) => [rg.outer, ...rg.holes]);
  let depth;
  if (regions.length === 1) depth = rings.map((_, i) => (i === 0 ? 0 : 1));
  else {
    // a ring can only enclose a point inside its own bounding box
    const box = rings.map((r) => drawingBounds([{ paths: [r] }]));
    const inBox = (i, [x, y]) => x >= box[i].min[0] && x <= box[i].max[0] && y >= box[i].min[1] && y <= box[i].max[1];
    depth = rings.map((r, i) => rings.reduce((n, q, j) => n + (j !== i && inBox(j, r.start) && encloses(q, r.start) ? 1 : 0), 0));
  }
  const order = rings.map((_, i) => i).sort((a, b) => depth[b] - depth[a] || a - b);
  return {
    inner: order.filter((i) => depth[i] > 0).map((i) => rings[i]),
    outer: order.filter((i) => depth[i] === 0).map((i) => rings[i]),
  };
}

// Exact bounding box of every path in `layers` — arcs by their axis extremes inside the
// sweep, cubics by the roots of their derivative — or null when there is no path at all.
export function drawingBounds(layers) {
  let min = null, max = null;
  const add = ([x, y]) => {
    if (!min) { min = [x, y]; max = [x, y]; return; }
    if (x < min[0]) min[0] = x; if (y < min[1]) min[1] = y;
    if (x > max[0]) max[0] = x; if (y > max[1]) max[1] = y;
  };
  for (const layer of layers) for (const path of layer.paths) {
    add(path.start);
    let from = path.start;
    for (const s of path.segments) {
      add(s.to);
      if (s.via) addArcExtremes(add, from, s);
      else if (s.c1) addCubicExtremes(add, from, s);
      from = s.to;
    }
  }
  return min ? { min, max } : null;
}

function addArcExtremes(add, from, s) {
  const g = arcCenterAndSweep(from, s.via, s.to);
  if (!g) return;                                   // collinear: the endpoints bound it
  const a0 = Math.atan2(from[1] - g.center[1], from[0] - g.center[0]);
  for (let q = 0; q < 4; q++) {
    const theta = (q * Math.PI) / 2;
    const along = g.dA >= 0 ? wrapTau(theta - a0) : wrapTau(a0 - theta);
    if (along <= Math.abs(g.dA)) add([g.center[0] + g.r * Math.cos(theta), g.center[1] + g.r * Math.sin(theta)]);
  }
}

function addCubicExtremes(add, from, s) {
  for (const axis of [0, 1]) {
    const a = from[axis], b = s.c1[axis], c = s.c2[axis], d = s.to[axis];
    // B'(t) / 3 = A t² + B t + C
    const A = -a + 3 * b - 3 * c + d, B = 2 * (a - 2 * b + c), C = b - a;
    const roots = [];
    if (Math.abs(A) < 1e-12) { if (Math.abs(B) > 1e-12) roots.push(-C / B); }
    else {
      const disc = B * B - 4 * A * C;
      if (disc >= 0) { const q = Math.sqrt(disc); roots.push((-B + q) / (2 * A), (-B - q) / (2 * A)); }
    }
    for (const t of roots) if (t > 0 && t < 1) add(cubicAt(from, s.c1, s.c2, s.to, t));
  }
}

// The identity P2b's dedupe confirms with: the drawing translated so bounds.min is the
// origin, every number rounded to 1e-4 mm, as JSON. A hash of this only NOMINATES a
// duplicate; string equality of the key confirms it (design spec D.4).
export function canonicalDrawingKey(drawing) {
  const [ox, oy] = drawing.bounds.min;
  const r = (v) => { const x = Math.round(v * 1e4) / 1e4; return x === 0 ? 0 : x; };
  const pt = (p) => [r(p[0] - ox), r(p[1] - oy)];
  const seg = (s) => (s.c1 ? { to: pt(s.to), c1: pt(s.c1), c2: pt(s.c2) } : s.via ? { to: pt(s.to), via: pt(s.via) } : { to: pt(s.to) });
  return JSON.stringify({
    kerf: r(drawing.kerf),
    layers: drawing.layers.map((l) => ({
      id: l.id,
      paths: l.paths.map((p) => ({ closed: p.closed, start: pt(p.start), segments: p.segments.map(seg) })),
    })),
  });
}

const arcCount = (regions) => regions.reduce(
  (n, rg) => n + [rg.outer, ...rg.holes].reduce((m, ring) => m + ring.segments.filter((s) => s.via).length, 0), 0);
const holeCounts = (regions) => regions.map((rg) => rg.holes.length).sort((a, b) => a - b).join(",");

// Offset the CUT regions (already refit) by +kerf/2 with round corners, so outlines grow
// and holes shrink — the storage winding invariant (outer CCW, holes CW) makes one signed
// offset do both (contour-offset.js). Lines and arcs offset exactly, so recovered arcs
// stay arcs; the result is refit again for any cubic the offset produced.
//
// The offset engine silently DROPS a hole narrower than the offset, and merges regions
// that grow into each other, so the before/after topology is compared and any change is
// an options error naming the piece (design spec D.2): region count (fewer → pieces
// joined), per-region hole counts sorted (any change → a slot closed or a mouth sealed),
// arc count (fewer → an arc feature was consumed). `gap`, when known, is the piece's
// narrowest opening (SheetFacts.gap) — the likeliest slot to have closed. kerf 0 returns
// the SAME array: a zero kerf must be byte-identical to no kerf.
export function applyKerf(regions, kerf, { label = "sheet part", gap = null } = {}) {
  if (!(kerf > 0)) return regions;
  const head = `${KIT_OPTIONS_ERROR} kerf ${kerf.toFixed(2)} mm`;
  const intact = `${head} could not keep the outline of "${label}" intact — lower kerf, or set it to 0 and compensate in your laser software`;
  let grown;
  try {
    grown = offsetRegions(regions, kerf / 2, { corners: "round" });
  } catch (err) {
    throw new Error(intact, { cause: err });
  }
  const out = grown.map((rg) => ({ outer: refitRing(closeContourGap(rg.outer)), holes: rg.holes.map((h) => refitRing(closeContourGap(h))) }));
  if (out.length < regions.length) throw new Error(`${head} joins separate pieces of "${label}" — space them apart or lower kerf`);
  if (out.length > regions.length) throw new Error(intact);
  if (holeCounts(out) !== holeCounts(regions)) {
    const slot = Number.isFinite(gap) ? `a ${gap.toFixed(2)} mm slot` : "a slot";
    throw new Error(`${head} closes ${slot} in "${label}" — widen it or lower kerf`);
  }
  if (arcCount(out) < arcCount(regions)) throw new Error(intact);
  return out;
}
