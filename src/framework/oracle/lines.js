// A part's declared lines, read at the measured pose for measure() and along each declared
// sweep's motion for its row. Worker-safe: no DOM, no three, no node, and no kernel (a
// line is read from derive's output alone). measureLines never throws; an unreadable line
// becomes `{ name, on, error }`.
import { linesInView, readLine } from "../lines/read.js";
import { resolveParams } from "../part-model.js";

const errText = (e) => String(e?.message || e).split("\n")[0].slice(0, 200);
const clockNow = () => globalThis.performance?.now?.() ?? Date.now();

/** One entry per declared line in `view`: the reading without its points, or an error. */
export function measureLines(part, view, d) {
  return linesInView(part, view).map((decl) => {
    try {
      const { name, on, mode, length, bendRatio, minBendRatio } = readLine(d, decl);
      return { name, on, mode, length, bendRatio, minBendRatio };
    } catch (e) {
      return { name: decl.name, on: decl.on, error: errText(e) };
    }
  });
}

/** Evenly spaced readings of a line along a sweep's motion, both ends included. */
export const LINE_SWEEP_SAMPLES = 33;
/**
 * The line pass's own time budget per measure() call (ms): the time spent reading lines
 * along every sweep, counted apart from the sweeps' contact deadline. A reading it stops
 * is `{ name, error: "timeout", at }`.
 */
export const LINE_SWEEP_BUDGET_MS = 2000;
// An interior extreme of length is refined to a bracket of this share of the motion's range.
const REFINE_TOL = 1e-4;
const GOLDEN = (Math.sqrt(5) - 1) / 2;
const TIMEOUT = "timeout";

/**
 * A line pass's clock: the time spent inside every sweepLines call handed this budget is
 * charged to it, on `now` (the sweeps' clock), and once `ms` is spent each later read stops.
 */
export function lineBudget({ now = clockNow, ms = LINE_SWEEP_BUDGET_MS } = {}) {
  let spent = 0;
  return {
    run(fn) {
      const t0 = now();
      try { return fn(() => spent + (now() - t0) > ms); } finally { spent += now() - t0; }
    },
  };
}

class LineTimeout extends Error {}

/**
 * Each declared line of `decls` (default: the view's) read along `motion` (`motionOf`'s
 * `{ lo, hi, at(v) }`): `{ name, lengthMin, lengthMinAt, lengthMax, lengthMaxAt, drift,
 * bendMin, bendMinAt, samples }`, the `…At` values motion values. LINE_SWEEP_SAMPLES even
 * readings, ONE derive per reading shared by every line; then each line's interior sampled
 * extremes of length refined by golden-section search between its two neighbours to
 * REFINE_TOL · (hi − lo), on that line's own derives; `samples` counts the line's readings.
 * The first reading that throws ends that line as `{ name, error, at }` (a derive that throws
 * ends every line still reading). `budget` (lineBudget's, default a fresh one) stops a line
 * not yet finished as `{ name, error: "timeout", at }`. Never throws.
 */
export function sweepLines(part, view, motion, decls = linesInView(part, view), { budget = lineBudget() } = {}) {
  return budget.run((over) => {
    const { lo, hi } = motion;
    const derive = (v) => {
      if (over()) throw new LineTimeout(TIMEOUT);
      return resolveParams(part, motion.at(v)).d;
    };
    const fail = (x, e) => { x.out = { name: x.decl.name, error: e instanceof LineTimeout ? TIMEOUT : errText(e), at: x.at }; };
    const n = LINE_SWEEP_SAMPLES;
    const vs = Array.from({ length: n }, (_, i) => (i === n - 1 ? hi : lo + ((hi - lo) * i) / (n - 1)));
    const st = decls.map((decl) => ({ decl, out: null, at: null, samples: 0, lens: [], bendMin: null, bendMinAt: null }));
    const bend = (x, r, v) => { if (r.bendRatio != null && (x.bendMin == null || r.bendRatio < x.bendMin)) { x.bendMin = r.bendRatio; x.bendMinAt = v; } };
    for (const v of vs) {
      const live = st.filter((x) => !x.out);
      if (!live.length) break;
      for (const x of live) { x.at = v; x.samples++; }
      let d;
      try { d = derive(v); } catch (e) { for (const x of live) fail(x, e); continue; }
      for (const x of live) {
        try { const r = readLine(d, x.decl); x.lens.push(r.length); bend(x, r, v); } catch (e) { fail(x, e); }
      }
    }
    return st.map((x) => x.out ?? refineLine(x, vs, derive, bend, (hi - lo) * REFINE_TOL, fail));
  });
}

function refineLine(x, vs, derive, bend, tol, fail) {
  const { lens } = x, n = vs.length;
  const read = (v) => { x.at = v; x.samples++; const r = readLine(derive(v), x.decl); bend(x, r, v); return r; };
  try {
    let iMin = 0, iMax = 0;
    for (let i = 1; i < n; i++) { if (lens[i] < lens[iMin]) iMin = i; if (lens[i] > lens[iMax]) iMax = i; }
    let lengthMin = lens[iMin], lengthMinAt = vs[iMin], lengthMax = lens[iMax], lengthMaxAt = vs[iMax];
    // golden-section search for the extreme of `sign · length` in [a, b]
    const refine = (i, sign) => {
      let a = vs[i - 1], b = vs[i + 1];
      let best = { v: vs[i], f: sign * lens[i] };
      const f = (v) => { const y = sign * read(v).length; if (y > best.f) best = { v, f: y }; return y; };
      let c = b - GOLDEN * (b - a), e = a + GOLDEN * (b - a);
      let fc = f(c), fe = f(e);
      while (b - a > tol) {
        if (fc > fe) { b = e; e = c; fe = fc; c = b - GOLDEN * (b - a); fc = f(c); } else { a = c; c = e; fc = fe; e = a + GOLDEN * (b - a); fe = f(e); }
      }
      return best;
    };
    if (iMax > 0 && iMax < n - 1) { const b = refine(iMax, 1); lengthMax = b.f; lengthMaxAt = b.v; }
    if (iMin > 0 && iMin < n - 1) { const b = refine(iMin, -1); lengthMin = -b.f; lengthMinAt = b.v; }
    return { name: x.decl.name, lengthMin, lengthMinAt, lengthMax, lengthMaxAt, drift: lengthMax - lengthMin, bendMin: x.bendMin, bendMinAt: x.bendMinAt, samples: x.samples };
  } catch (e) {
    fail(x, e);
    return x.out;
  }
}
