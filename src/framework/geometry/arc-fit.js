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
// interiors and joints, not the accuracy of the result — see probeRun for why
// there are two of them and why a radius-relative one alone is not enough, and
// fitCircle for why a fit through three nearly collinear points is refused. What
// it accepts lies within min(1e-3·r, 2e-3·chord) of each cubic at every probe: a
// non-circle closer than that to a circle is read as that circle.
//
// Pure leaf: DOM-free, node-free and paper-free — the laser checks' resolver hands it to
// the width searches (sheet/resolve.js), and the oracle and lint may not load paper.
// Those run it before the first step they price, so its cost is linear in the cubics
// wherever that can be shown not to change what it returns (recoverArcs).
import { circumcircle } from "./arc-math.js";
import { cubicAt } from "./contour-corners.js";

const ARC_TOL = 1e-3;            // relative to the FITTED radius
const CHORD_TOL = 2e-3;          // relative to each cubic's OWN chord — see probeRun
// Seven interior points of each cubic and its END — every joint of the run as well as
// its middles (the run's first point is a fit point, on the circle by construction).
const PROBE_TS = [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];
const MAX_SWEEP = Math.PI;       // split arcs at 180° so the 3-point form stays unambiguous
const MAX_SPAN_RATIO = 1e4;      // a fitted radius past this × the fit points' span — see fitCircle
// Rounding, per unit of the numbers' own scale. A three-point fit in absolute coordinates
// moves a probe by up to about 40·EPS·M²/span (M the largest coordinate; measured over
// 190,000 fits), and a probe's computed distance from a circle is good to a few EPS of
// the radius and coordinates; both are taken at this, with headroom.
const ROUND = 64 * Number.EPSILON;

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Does every probed interior point of every cubic of the run segs[i..j] lie on the circle?
// → { miss: { dev, bound, at } } for a probe that does not (its distance, the loosest
// bound any fit can give it — its chord's — and where it is), else { devs, bounds }: how
// far each cubic's probes lie from the circle at most, and each one's chord bound. With
// `all`, every probe is measured and none refused.
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
function probeRun(segs, i, j, from, fit, all = false) {
  const devs = [], bounds = [];
  let p = from;
  for (let k = i; k <= j; k++) {
    const s = segs[k], bound = CHORD_TOL * dist(p, s.to);
    const tol = Math.min(ARC_TOL * fit.r, bound);
    let most = 0;
    for (const t of PROBE_TS) {
      const at = cubicAt(p, s.c1, s.c2, s.to, t), d = Math.abs(offCircle(fit, at));
      if (d > tol && !all) return { miss: { dev: d, bound, at } };
      if (d > most) most = d;
    }
    devs.push(most); bounds.push(bound);
    p = s.to;
  }
  return { devs, bounds };
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
// enough to pass probeRun's tolerance, and any later join with a second
// segment re-fits through three real endpoints and recovers the exact circle.
//
// A fit through three points that are collinear to float noise is refused: its
// radius is astronomical (a sine-wave edge fitted across whole periods came out near
// 1e17), and an arc that size is a straight chord drawn through the curve. It is
// refused past MAX_SPAN_RATIO × the three points' span, where a real arc's sagitta is
// under span/80,000 — a line, to every tolerance here — and a centre and `via` built
// that far out would lose their digits (arcsBetween) besides.
//
// The run is read in place, by index — never copied: recoverArcs tries a fit for many
// lengths of a run. `noise` is how far rounding can move a probe off the fitted circle
// (ROUND), `scale` how large the numbers its probes are measured with are.
function fitCircle(segs, i, j, from) {
  const n = j - i + 1;                  // its endpoints are from, segs[i].to … segs[j].to
  const mid = n >= 2
    ? segs[i + Math.floor((n + 1) / 2) - 1].to
    : cubicAt(from, segs[i].c1, segs[i].c2, segs[i].to, 0.5);
  const a = from, b = segs[j].to;
  const c = circumcircle(a, mid, b);
  if (!c || !Number.isFinite(c.r) || c.r <= 0) return null;
  const span = Math.max(dist(a, mid), dist(mid, b), dist(a, b));
  if (!(c.r <= MAX_SPAN_RATIO * span)) return null;
  const u = [(c.center[0] - a[0]) / c.r, (c.center[1] - a[1]) / c.r];
  const M = Math.max(Math.abs(a[0]), Math.abs(a[1]), Math.abs(mid[0]), Math.abs(mid[1]), Math.abs(b[0]), Math.abs(b[1]));
  return { center: c.center, r: c.r, a, kappa: 1 / c.r, u, noise: (ROUND * M * M) / span, scale: 3 * c.r + M };
}

// Does the run segs[i..j] fit the circle c? `known` is the last fit a run from i was
// probed whole against: its fit, the last cubic it covers (upTo), and how far each covered
// cubic's probes lay from its fit (devs, with their chord bounds). A probe lies at most
// |Δcentre| + |Δr| farther from c than from that fit, so a covered cubic whose probes the
// shift cannot carry past their bound under c is not probed again (the shift is taken with
// both fits' rounding on top); the rest are. Where more than a quarter of them would be,
// the run is probed whole and becomes the new `known`.
// → { miss } as probeRun's, or { known } for the run that fitted.
function fitsRun(segs, i, j, runFrom, c, known) {
  const start = (k) => (k === i ? runFrom : segs[k - 1].to);
  if (known) {
    const tolR = ARC_TOL * c.r, covered = known.upTo - i + 1;
    const shift = dist(c.center, known.fit.center) + Math.abs(c.r - known.fit.r) + ROUND * Math.max(c.scale, known.fit.scale);
    const again = [];
    if (!(known.dev + shift <= tolR && shift <= known.slack)) {
      for (let k = 0; k < covered && 4 * again.length <= covered; k++) {
        if (!(known.devs[k] + shift <= Math.min(tolR, known.bounds[k]))) again.push(i + k);
      }
    }
    if (4 * again.length <= covered) {
      for (const k of again) { const m = probeRun(segs, k, k, start(k), c); if (m.miss) return m; }
      const m = probeRun(segs, known.upTo + 1, j, start(known.upTo + 1), c);
      if (m.miss) return m;
      const x = probeRun(segs, known.upTo + 1, j, start(known.upTo + 1), known.fit, true);
      return { known: cover(known, x, j) };
    }
  }
  const m = probeRun(segs, i, j, runFrom, c);
  return m.miss ? m : { known: cover({ fit: c, devs: [], bounds: [], dev: 0, slack: Infinity }, m, j) };
}
// `known` with the cubics measured in `x` (devs against known's own fit) covered, to `upTo`.
function cover(known, x, upTo) {
  x.devs.forEach((d, k) => {
    known.devs.push(d); known.bounds.push(x.bounds[k]);
    known.dev = Math.max(known.dev, d); known.slack = Math.min(known.slack, x.bounds[k] - d);
  });
  known.upTo = upTo;
  return known;
}

// Whether no longer run from the same start can fit where the fit `c` of the run segs[i..j]
// missed. Every longer fit passes through the run's start as c does, and must come within
// its bound of c's other two fit points — the ends of the cubic at the run's middle and of
// its last cubic — and of the missed probe. Two circles through one point differ, to first
// order, by α + β·cos θ + γ·sin θ along the circle, so where they differ by e1 and e2 at the
// other two fit points they differ by at most |L1|·e1 + |L2|·e2 at the probe (L the
// trigonometric Lagrange basis on the three fit points' angles about c's centre). A miss
// farther than that from any circle a longer run could fit, with a quarter's headroom and
// the fits' rounding on top, is final.
function final(segs, i, j, runFrom, c, miss) {
  const n = j - i + 1, m = i + Math.floor((n + 1) / 2) - 1;       // the cubic ending at the middle fit point
  const bound = (k) => CHORD_TOL * dist(k === i ? runFrom : segs[k - 1].to, segs[k].to);
  const angle = (p) => Math.atan2(p[1] - c.center[1], p[0] - c.center[0]);
  const t0 = angle(runFrom), t1 = angle(segs[m].to), t2 = angle(segs[j].to), tq = angle(miss.at);
  const basis = (x, y, z) => Math.abs((Math.sin((tq - x) / 2) * Math.sin((tq - y) / 2)) / (Math.sin((z - x) / 2) * Math.sin((z - y) / 2)));
  const reach = basis(t0, t2, t1) * (bound(m) + c.noise) + basis(t0, t1, t2) * (bound(j) + c.noise);
  return miss.dev > miss.bound + 1.25 * reach + 2 * c.noise;
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

// The direction the run actually travels, from its first cubic's own geometry.
function sweepSignOf(first, from, center) {
  const a = [from[0] - center[0], from[1] - center[1]];
  const q = cubicAt(from, first.c1, first.c2, first.to, 0.5);
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

    // Greedy: the longest run from i that fits one circle. A shorter run failing does not
    // rule out a longer one — its fit points are closer together, so it is refused as too
    // flat for its span, or rounding swamps it, or a small cubic near no fit point misses
    // its small bound where a longer fit lands on it — and a search that stopped at the first
    // failure changed 117 of 6,000 genuine arcs and near-circles split into up to 8 pieces.
    // But trying every length made the search cubic in a run of cubics that are not a circle
    // (1,600 of them: 3.4 s), and re-probing every length of a run that fits, quadratic in a
    // circle of many cubics (4,000: 3.6 s). So the search ends at a miss no longer run can
    // make up (final), and a longer fit re-probes only what it could change (fitsRun).
    const runFrom = from;
    let best = null, bestEnd = i, known = null;
    for (let j = i; j < segs.length && segs[j].c1; j++) {
      const c = fitCircle(segs, i, j, runFrom);
      if (!c) continue;
      const r = fitsRun(segs, i, j, runFrom, c, known);
      if (r.miss) {
        if (j > i && final(segs, i, j, runFrom, c, r.miss)) break;
        continue;
      }
      best = c; bestEnd = j; known = r.known;
    }

    if (!best) { out.push(segs[i]); from = segs[i].to; i++; continue; }

    const end = segs[bestEnd].to;
    out.push(...arcsBetween(runFrom, end, best.center, best.r, sweepSignOf(segs[i], runFrom, best.center)));
    from = end;
    i = bestEnd + 1;
  }

  return { start: [...contour.start], segments: out };
}
