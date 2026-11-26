// A part's declared lines, read at the measured pose for measure() and along each declared
// sweep's motion for its row. Worker-safe: no DOM, no three, no node, and no kernel (a
// line is read from derive's output alone). measureLines never throws; an unreadable line
// becomes `{ name, on, error }`.
import { linesInView, readLine } from "../lines/read.js";
import { resolveParams } from "../part-model.js";

const errText = (e) => String(e?.message || e).split("\n")[0].slice(0, 200);

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
// An interior extreme of length is refined to a bracket of this share of the motion's range.
const REFINE_TOL = 1e-4;
const GOLDEN = (Math.sqrt(5) - 1) / 2;

/**
 * Each declared line of `decls` (default: the view's) read along `motion` (`motionOf`'s
 * `{ lo, hi, at(v) }`): `{ name, lengthMin, lengthMinAt, lengthMax, lengthMaxAt, drift,
 * bendMin, bendMinAt, samples }`, the `…At` values motion values. LINE_SWEEP_SAMPLES even
 * readings, then each interior sampled extreme of length refined by golden-section search
 * between its two neighbours to REFINE_TOL · (hi − lo); `samples` counts every reading. The
 * first reading that throws ends that line as `{ name, error, at }`. Never throws.
 */
export function sweepLines(part, view, motion, decls = linesInView(part, view)) {
  return decls.map((decl) => sweepLine(part, motion, decl));
}

function sweepLine(part, motion, decl) {
  const { lo, hi } = motion;
  let samples = 0, at = null;
  const read = (v) => {
    at = v;
    samples++;
    const { d } = resolveParams(part, motion.at(v));
    return readLine(d, decl);
  };
  try {
    const n = LINE_SWEEP_SAMPLES;
    const vs = Array.from({ length: n }, (_, i) => (i === n - 1 ? hi : lo + ((hi - lo) * i) / (n - 1)));
    const lens = [];
    let bendMin = null, bendMinAt = null;
    const bend = (r, v) => { if (r.bendRatio != null && (bendMin == null || r.bendRatio < bendMin)) { bendMin = r.bendRatio; bendMinAt = v; } };
    for (const v of vs) { const r = read(v); lens.push(r.length); bend(r, v); }
    let iMin = 0, iMax = 0;
    for (let i = 1; i < n; i++) { if (lens[i] < lens[iMin]) iMin = i; if (lens[i] > lens[iMax]) iMax = i; }
    let lengthMin = lens[iMin], lengthMinAt = vs[iMin], lengthMax = lens[iMax], lengthMaxAt = vs[iMax];
    const tol = REFINE_TOL * (hi - lo);
    // golden-section search for the extreme of `sign · length` in [a, b]
    const refine = (i, sign) => {
      let a = vs[i - 1], b = vs[i + 1];
      let best = { v: vs[i], f: sign * lens[i] };
      const f = (v) => { const r = read(v); bend(r, v); const y = sign * r.length; if (y > best.f) best = { v, f: y }; return y; };
      let c = b - GOLDEN * (b - a), e = a + GOLDEN * (b - a);
      let fc = f(c), fe = f(e);
      while (b - a > tol) {
        if (fc > fe) { b = e; e = c; fe = fc; c = b - GOLDEN * (b - a); fc = f(c); } else { a = c; c = e; fc = fe; e = a + GOLDEN * (b - a); fe = f(e); }
      }
      return best;
    };
    if (iMax > 0 && iMax < n - 1) { const b = refine(iMax, 1); lengthMax = b.f; lengthMaxAt = b.v; }
    if (iMin > 0 && iMin < n - 1) { const b = refine(iMin, -1); lengthMin = -b.f; lengthMinAt = b.v; }
    return { name: decl.name, lengthMin, lengthMinAt, lengthMax, lengthMaxAt, drift: lengthMax - lengthMin, bendMin, bendMinAt, samples };
  } catch (e) {
    return { name: decl.name, error: errText(e), at };
  }
}
