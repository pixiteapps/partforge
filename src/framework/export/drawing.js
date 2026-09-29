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
// hole cut with cutAll comes back as four cubics; recoverArcs (arc-fit.js) turns those
// back into exact arcs. But the helpers authors reach for first draw circles as
// polygons — circleProfile is a 48-gon, roundedRectPolygon's corners and slotPolygon's
// ends are chords — and a laser traces every facet. refitLineRuns is the conservative
// second pass for those: a run becomes arcs only when at least `minVerts` consecutive
// vertices sit on one circle AND every step turns by at most `maxTurnDeg`, all the same
// way. A hexagon (60° turns) or a star (alternating turns) never qualifies; when the
// test misses something the output is dense, never wrong.
//
// LAZY: reachable only through process/exporters.js's dynamic import (and, from P2b,
// export/bundle.js's). It reaches paper (arc-fit.js → paper-bridge.js), which is why
// lint, the oracle and partforge/geometry must never import it (test/kit-export-guards.test.js).
// It runs in the geometry worker, so it stays DOM-free and node:-free.
import { recoverArcs } from "../geometry/arc-fit.js";
import { arcCenterAndSweep } from "../geometry/arc-math.js";

// The cut order: marks first (the piece is still held by the sheet), holes before the
// outline that frees the piece. Writers emit layers in this order.
export const LAYER_ORDER = Object.freeze(["engrave", "score", "cut-inner", "cut-outer"]);
// engrave is a filled region; the rest are vector lines.
export const LAYER_KIND = Object.freeze({ engrave: "fill", score: "line", "cut-inner": "line", "cut-outer": "line" });

const TAU = 2 * Math.PI;
const CLOSE_EPS = 1e-9;   // mm — the storage invariant's "explicitly closed"
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const wrapPi = (a) => { a %= TAU; if (a > Math.PI) a -= TAU; else if (a <= -Math.PI) a += TAU; return a; };
const isLine = (s) => !s.via && !s.c1;

// Signed turn (radians, CCW positive) from edge a→b to edge b→c; NaN when an edge has no
// length (a duplicate vertex has no direction, so it can never sit inside a run).
function turnAt(a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]];
  if (Math.hypot(u[0], u[1]) < CLOSE_EPS || Math.hypot(v[0], v[1]) < CLOSE_EPS) return NaN;
  return Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]);
}

// Fit the circle through vertices k..e of Q (via k, the one-third and the two-thirds
// vertex — three distinct points even when the run is a whole ring and Q[e] is Q[k]),
// then require EVERY vertex within tolerance of it, stepping round the centre in the
// run's turning direction. Returns the run's circle and accumulated sweep, or null.
function fitRun(Q, k, e, sign) {
  const m = e - k;
  const c = arcCenterAndSweep(Q[k], Q[k + Math.round(m / 3)], Q[k + Math.round((2 * m) / 3)]);
  if (!c || !(c.r > 0)) return null;
  const run = { center: c.center, r: c.r, tol: Math.max(1e-6, 1e-4 * c.r), sign, sweep: 0 };
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

// Runs of straight segments that trace a circle → three-point arcs. Curves pass through
// untouched and break runs. A closed ring is first re-seated at a "hard break" (a vertex
// no run can pass: a curve meets it, or it turns out of band) so a run that wraps the
// ring's start is seen whole; a ring with no hard break — a faceted circle — is tried as
// one run all the way round. Orientation is preserved. When nothing is refit the input
// contour is returned as-is (same object).
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
  let k = 0;
  while (k < n) {
    // Segments k..j-1 are straight, and every joint between them turns in band, one way.
    let j = k, sign = 0;
    while (j < n && isLine(S[j])) {
      if (j > k) {
        const t = turnAt(Q[j - 1], Q[j], Q[j + 1]);
        if (!inBand(t) || (sign !== 0 && Math.sign(t) !== sign)) break;
        sign = Math.sign(t);
      }
      j++;
    }
    let e = k + minVerts - 1;
    let run = sign !== 0 && e <= j ? fitRun(Q, k, e, sign) : null;
    while (run && e < j && extendRun(run, Q[e], Q[e + 1])) e++;
    if (run) { out.push(...arcPieces(Q[k], Q[e], run)); changed = true; k = e; }
    else { out.push(S[k]); k++; }
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
