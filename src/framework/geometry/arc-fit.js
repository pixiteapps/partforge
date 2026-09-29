// Circular-arc recovery: runs of cubic segments that lie on a common circle
// become symbolic {to, via} arcs.
//
// paper.js has no arc primitive, so importSVG returns every curve as a cubic —
// a <circle> arrives as four of them. Without this pass the OCCT backend would
// build a spline where the artwork had a circle. Recovering at the CONTOUR level
// rather than special-casing <circle> means arcs from `A` commands, rounded-rect
// corners, and transformed circles all come back through one mechanism.
//
// The fit is exact, not approximate. Paper's kappa construction pins each
// cubic's ENDPOINTS to the true circle and only the interior deviates, so a
// three-point fit through endpoints recovers the original centre and radius to
// float precision. The tolerances are therefore an acceptance test on the
// interiors and joints, not the accuracy of the result — see runFits for why
// there are two of them and why a radius-relative one alone is not enough, and
// fitCircle for why a fit through three nearly collinear points is refused. What
// it accepts lies within min(1e-3·r, 2e-3·chord) of each cubic at every probe: a
// non-circle closer than that to a circle is read as that circle.
//
// Pure leaf: DOM-free, node-free and paper-free — the laser checks' resolver hands it to
// the width searches (sheet/resolve.js), and the oracle and lint may not load paper.
import { arcCenterAndSweep } from "./arc-math.js";
import { cubicAt } from "./contour-corners.js";

const ARC_TOL = 1e-3;            // relative to the FITTED radius
const CHORD_TOL = 2e-3;          // relative to each cubic's OWN chord — see runFits
// Seven interior points of each cubic and its END — every joint of the run as well as
// its middles (the run's first point is a fit point, on the circle by construction).
const PROBE_TS = [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];
const MAX_SWEEP = Math.PI;       // split arcs at 180° so the 3-point form stays unambiguous
const MAX_SPAN_RATIO = 1e4;      // a fitted radius past this × the fit points' span — see fitCircle

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Does every probed interior point of every cubic in `run` lie on the circle?
//
// TWO bounds, and the tighter one wins. `ARC_TOL * r` alone is not a usable
// acceptance test, because r is the FITTED radius: the flatter a curve is, the
// bigger the circle it fits, so the band grows without limit exactly where the
// author's own feature is smallest. A gentle asymmetric cubic — the single most
// common thing in real logo artwork — fitted a circle of r = 913 and was accepted
// with a maximum deviation of 0.70 against its own sagitta of 1.43. Half the
// curve's depth, silently, and the stored file then claimed `"kind": "arc"`, so
// nothing downstream could recover the intent.
//
// The second bound is relative to the cubic's own CHORD — the straight distance
// between its endpoints. Chord is the right base rather than sagitta because it
// stays finite and meaningful as the curve flattens (sagitta goes to zero, which
// would reject genuine shallow arcs) and never degenerates on a closed run (the
// whole run's chord does: a full circle's endpoints coincide). It is a scale the
// artwork actually has, and it does not move when the fit does.
//
// CHORD_TOL is set with real headroom over what genuine circles need. Paper's
// kappa construction pins each cubic's endpoints to the true circle and errs only
// in the interior, by about 2.7e-4 * r for a 90° cubic and far less for shallower
// ones. Measured against this module's own fit, over sweeps of 1°-90° and radii
// from 0.5 to 1e5, the worst genuine deviation is 1.83e-4 of chord — so 2e-3
// leaves an 11x margin. The two shallow non-circular cubics that used to be
// accepted deviate by 3.1e-3 and 6.8e-3 of chord, comfortably outside it.
//
// A probe's distance from the circle is taken without cancellation (offCircle): as
// `|q − centre| − r` it is the difference of two numbers the size of r, and where r
// is huge it loses every digit the probe's own offset lives in.
function runFits(run, from, fit) {
  let p = from;
  for (const s of run) {
    const tol = Math.min(ARC_TOL * fit.r, CHORD_TOL * dist(p, s.to));
    for (const t of PROBE_TS) {
      if (Math.abs(offCircle(fit, cubicAt(p, s.c1, s.c2, s.to, t))) > tol) return false;
    }
    p = s.to;
  }
  return true;
}

// The signed distance of q from the fitted circle, computed in the frame of the fit's
// first point `a`: with κ = 1/r and u the unit vector from a toward the centre, the
// circle is κ|q − a|² − 2(q − a)·u = 0, and that left side is f = (ρ² − r²)/r for q at
// ρ from the centre. So ρ − r = f / (1 + √(1 + κf)) — no difference of r-sized numbers,
// and finite (the distance from the chord line) as κ goes to zero.
function offCircle({ a, kappa, u }, q) {
  const v = [q[0] - a[0], q[1] - a[1]];
  const f = kappa * (v[0] * v[0] + v[1] * v[1]) - 2 * (v[0] * u[0] + v[1] * u[1]);
  return f / (1 + Math.sqrt(Math.max(0, 1 + kappa * f)));
}

// Fit through the run's first, middle and last ENDPOINT — all exact on the
// source circle. A two-cubic run has three endpoints and uses them directly.
// A one-cubic run has only two endpoints, so the three-point fit would
// degenerate (the "middle" point would just be the last point again); use the
// cubic's own midpoint instead. That point is NOT exact on the circle (it's
// off by paper's kappa error), so the resulting centre/radius are only
// approximate for a still-unextended single-cubic run — but they're accurate
// enough to pass runFits's tolerance, and any later join with a second
// segment re-fits through three real endpoints and recovers the exact circle.
//
// A fit through three points that are collinear to float noise is refused: its
// radius is astronomical (a sine-wave edge fitted across whole periods came out near
// 1e17), and an arc that size is a straight chord drawn through the curve. It is
// refused past MAX_SPAN_RATIO × the three points' span, where a real arc's sagitta is
// under span/80,000 — a line, to every tolerance here — and a centre and `via` built
// that far out would lose their digits (arcsBetween) besides.
function fitCircle(run, from) {
  const pts = [from, ...run.map((s) => s.to)];
  const mid = pts.length >= 3
    ? pts[Math.floor(pts.length / 2)]
    : cubicAt(from, run[0].c1, run[0].c2, run[0].to, 0.5);
  const a = pts[0], b = pts.at(-1);
  const c = arcCenterAndSweep(a, mid, b);
  if (!c || !Number.isFinite(c.r) || c.r <= 0) return null;
  const span = Math.max(dist(a, mid), dist(mid, b), dist(a, b));
  if (!(c.r <= MAX_SPAN_RATIO * span)) return null;
  const u = [(c.center[0] - a[0]) / c.r, (c.center[1] - a[1]) / c.r];
  return { center: c.center, r: c.r, a, kappa: 1 / c.r, u };
}

// One arc from `from` to `to` about `center`, split so no piece exceeds 180°.
// `via` is placed at each piece's angular midpoint, which is what makes the
// three-point form recoverable.
function arcsBetween(from, to, center, r, sweepSign) {
  const ang = (p) => Math.atan2(p[1] - center[1], p[0] - center[0]);
  const a0 = ang(from);
  let dA = ang(to) - a0;
  const twoPi = 2 * Math.PI;
  while (dA <= 0) dA += twoPi;
  while (dA > twoPi) dA -= twoPi;
  if (sweepSign < 0) dA -= twoPi;
  const pieces = Math.max(1, Math.ceil(Math.abs(dA) / MAX_SWEEP - 1e-9));
  const out = [];
  for (let i = 0; i < pieces; i++) {
    const s0 = a0 + dA * (i / pieces), s1 = a0 + dA * ((i + 1) / pieces);
    const m = (s0 + s1) / 2;
    const P = (t) => [center[0] + r * Math.cos(t), center[1] + r * Math.sin(t)];
    out.push({ to: P(s1), via: P(m) });
  }
  out.at(-1).to = [to[0], to[1]];    // pin the exact endpoint
  return out;
}

// The direction the run actually travels, from the first cubic's own geometry.
function sweepSignOf(run, from, center) {
  const a = [from[0] - center[0], from[1] - center[1]];
  const q = cubicAt(from, run[0].c1, run[0].c2, run[0].to, 0.5);
  const b = [q[0] - center[0], q[1] - center[1]];
  return a[0] * b[1] - a[1] * b[0] >= 0 ? 1 : -1;
}

export function recoverArcs(contour) {
  const segs = contour.segments;
  const out = [];
  let from = contour.start;
  let i = 0;

  while (i < segs.length) {
    if (!segs[i].c1) { out.push(segs[i]); from = segs[i].to; i++; continue; }

    // Greedy: extend the cubic run while it still fits one circle.
    const runFrom = from;
    let best = null, bestEnd = i;
    let j = i;
    while (j < segs.length && segs[j].c1) {
      const run = segs.slice(i, j + 1);
      const c = fitCircle(run, runFrom);
      if (c && runFits(run, runFrom, c)) { best = c; bestEnd = j; }
      j++;
    }

    if (!best) { out.push(segs[i]); from = segs[i].to; i++; continue; }

    const run = segs.slice(i, bestEnd + 1);
    const end = run.at(-1).to;
    out.push(...arcsBetween(runFrom, end, best.center, best.r, sweepSignOf(run, runFrom, best.center)));
    from = end;
    i = bestEnd + 1;
  }

  return { start: [...contour.start], segments: out };
}
