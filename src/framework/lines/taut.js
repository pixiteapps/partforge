// The taut solver of the lines core (spec 2026-11-20-lines-rope-and-cable-design.md): a
// rope pulled tight through an ordered list of elements. Free spans are straight tangents;
// on a drum the rope lies on a circle (a helix when the drum has a `lead`).
//
// Closed form, for drums whose axes are all parallel. Everything is worked in the plane
// across that axis (u, v) with the axial coordinate w carried beside it. A skew pair of
// axes is not solved here and throws.
//
// An element is one of
//   { kind: "anchor", at: [x, y, z] }                       a point the rope is fixed at
//   { kind: "drum", name, center, axis, radius, side,       a cylinder it wraps
//     turns?, lead?, w?, fixed?: { wrap } }
// `side` is the way the rope goes round, seen from the tip of the axis, travelling along
// the line: "ccw" or "cw". A drum in the middle of the line is wrapped by what the two
// tangents leave, plus `turns` whole turns. A drum at either END of the line holds the
// rope's termination: `fixed.wrap` is how many degrees of rope lie on it at this pose (a
// drum that turns changes it; the caller works that out, the solver knows no motion).
// `lead` is the helix's axial advance per turn, signed along the axis in the direction of
// travel; `w` the axial position where the rope first meets the drum (a terminated drum:
// where its termination sits), default the drum centre's. `w` is measured along the FIRST
// drum's axis, also for a drum whose own axis is given the other way round.
//
// `closed: true` is a loop (a belt): every element is a drum, none holds a termination,
// and the last one's tangent runs back to the first.
//
// The rope's centreline runs at the PITCH radius, radius + d / 2.
//
// Pure: no kernel, no DOM. Angles in degrees, lengths in mm.
import { SpecError } from "../geometry/errors.js";

const RAD = Math.PI / 180;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const isVec = (v) => Array.isArray(v) && v.length === 3 && v.every((c) => Number.isFinite(c));
const mod360 = (a) => ((a % 360) + 360) % 360;
/** The most degrees of arc between two sampled points of a wrap. */
export const ARC_STEP_DEG = 10;

const fail = (field, msg) => { throw new SpecError(`line: ${field ? `${field}: ` : ""}${msg}`, { field }); };

// A right-handed basis { x, y, z } with z the axis. Any x across the axis will do: the
// solver's answers do not depend on which.
function basisFor(z) {
  const seed = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const y0 = cross(z, seed);
  const l = Math.hypot(y0[0], y0[1], y0[2]);
  const y = [y0[0] / l, y0[1] / l, y0[2] / l];
  return { x: cross(y, z), y, z };
}

function readElements(d, through, closed) {
  if (!Number.isFinite(d) || !(d > 0)) fail("d", `must be a positive number, got ${JSON.stringify(d)}`);
  if (!Array.isArray(through) || through.length < 2) fail("through", "must list at least two elements");
  let axis = null;
  const els = through.map((e, i) => {
    const at = `through[${i}]`;
    if (e?.kind === "anchor") {
      if (closed) fail(`${at}.kind`, "a closed line runs over drums only");
      if (!isVec(e.at)) fail(`${at}.at`, `must be [x, y, z] numbers, got ${JSON.stringify(e.at)}`);
      return { kind: "anchor", name: e.name ?? null, p: e.at, R: 0, s: 1, radius: 0, lead: 0, turns: 0, fixed: null };
    }
    if (e?.kind !== "drum") fail(`${at}.kind`, `must be "anchor" or "drum", got ${JSON.stringify(e?.kind)}`);
    if (!isVec(e.center)) fail(`${at}.center`, `must be [x, y, z] numbers, got ${JSON.stringify(e.center)}`);
    const a = e.axis ?? [0, 0, 1];
    if (!isVec(a)) fail(`${at}.axis`, `must be [x, y, z] numbers, got ${JSON.stringify(a)}`);
    const l = Math.hypot(a[0], a[1], a[2]);
    if (!(l > 1e-12)) fail(`${at}.axis`, "must not be zero length");
    const unit = [a[0] / l, a[1] / l, a[2] / l];
    if (!Number.isFinite(e.radius) || !(e.radius > 0)) fail(`${at}.radius`, `must be a positive number, got ${JSON.stringify(e.radius)}`);
    if (e.side !== "ccw" && e.side !== "cw") fail(`${at}.side`, `must be "ccw" or "cw", got ${JSON.stringify(e.side)}`);
    let s = e.side === "ccw" ? 1 : -1;
    let lead = e.lead ?? 0;
    if (!Number.isFinite(lead)) fail(`${at}.lead`, `must be a number, got ${JSON.stringify(e.lead)}`);
    if (!axis) axis = unit;
    else {
      const c = dot(axis, unit);
      if (Math.abs(Math.abs(c) - 1) > 1e-9) fail(`${at}.axis`, "is not parallel to the first drum's axis; a skew pair is not solved yet");
      if (c < 0) { s = -s; lead = -lead; } // the same drum, described from its other end
    }
    const ends = !closed && (i === 0 || i === through.length - 1);
    let fixed = null;
    if (ends) {
      if (!Number.isFinite(e.fixed?.wrap)) fail(`${at}.fixed.wrap`, "a drum at the end of a line holds the rope's termination: give the degrees of rope on it");
      fixed = { wrap: e.fixed.wrap };
    } else if (e.fixed != null) fail(`${at}.fixed`, closed ? "a closed line has no termination" : "only a drum at the end of a line holds a termination");
    const turns = e.turns ?? 0;
    if (!Number.isInteger(turns) || turns < 0) fail(`${at}.turns`, `must be a whole number of turns, 0 or more, got ${JSON.stringify(e.turns)}`);
    if (e.w != null && !Number.isFinite(e.w)) fail(`${at}.w`, `must be a number, got ${JSON.stringify(e.w)}`);
    return { kind: "drum", name: e.name ?? null, p: e.center, R: e.radius + d / 2, s, radius: e.radius, lead, turns, fixed, wGiven: e.w ?? null };
  });
  const basis = basisFor(axis ?? [0, 0, 1]);
  for (const e of els) {
    e.c = [dot(e.p, basis.x), dot(e.p, basis.y)];
    e.w = e.wGiven ?? dot(e.p, basis.z);
  }
  return { els, basis };
}

// The tangent from element i to element j in the plane: the unit normal q (the travel
// direction turned a quarter turn clockwise), the planar length, and where it leaves and
// lands. A ccw-wrapped circle is touched at centre + R q, a cw one at centre - R q.
function tangent(a, b, at) {
  const D = [b.c[0] - a.c[0], b.c[1] - a.c[1]];
  const dist = Math.hypot(D[0], D[1]);
  const k = a.R * a.s - b.R * b.s;
  if (!(dist > 1e-9) || Math.abs(k) > dist) fail(at, "no tangent between these two elements (they overlap, or sit on one axis)");
  const dh = [D[0] / dist, D[1] / dist], nh = [-dh[1], dh[0]];
  const ca = k / dist, cb = -Math.sqrt(Math.max(0, 1 - ca * ca));
  const q = [ca * dh[0] + cb * nh[0], ca * dh[1] + cb * nh[1]];
  const t = [-q[1], q[0]];
  return { q, planar: D[0] * t[0] + D[1] * t[1] };
}
const radialAngle = (e, q) => Math.atan2(e.s * q[1], e.s * q[0]) / RAD;

/**
 * Solves a taut line (`closed: true` for a loop). Returns
 *   length   the centreline's length, mm
 *   spans    [{ from, to, length, fleet }]: each free span; `fleet` is its angle off the
 *            plane across the axis, degrees (0 when the two ends sit at one axial position)
 *   wraps    [{ on, angle, turns, radius, bendRatio, length, entry, exit, w: [in, out], runOff }]
 *            per drum, in line order: degrees of rope on it, the pitch radius, drum diameter
 *            over rope diameter, the tangent angles about the axis, and `runOff: true` when a
 *            terminated drum has less than no rope left on it (its wrap is then read as 0)
 *   points   the centreline as [x, y, z] points, arcs sampled every ARC_STEP_DEG
 */
export function solveTaut({ d, through, closed = false }) {
  const { els, basis } = readElements(d, through, closed);
  const n = els.length;
  const tans = [];
  const links = closed ? n : n - 1; // tans[i] runs from element i to element (i + 1) % n
  for (let i = 0; i < links; i++) tans.push(tangent(els[i], els[(i + 1) % n], `through[${i}] to through[${(i + 1) % n}]`));

  // wraps, then the axial position the rope has where it meets and leaves each element
  for (let i = 0; i < n; i++) {
    const e = els[i];
    if (e.kind !== "drum") { e.wIn = e.wOut = e.w; continue; }
    const first = !closed && i === 0, last = !closed && i === n - 1;
    e.exit = last ? null : radialAngle(e, tans[i].q);
    e.entry = first ? null : radialAngle(e, tans[(i - 1 + n) % n].q);
    if (e.fixed) {
      e.runOff = e.fixed.wrap < 0;
      e.wrap = Math.max(0, e.fixed.wrap);
      if (first) { e.entry = e.exit - e.s * e.wrap; e.wIn = e.w; e.wOut = e.w + (e.lead * e.wrap) / 360; }
      else { e.exit = e.entry + e.s * e.wrap; e.wOut = e.w; e.wIn = e.w - (e.lead * e.wrap) / 360; }
    } else {
      e.runOff = false;
      e.wrap = mod360(e.s * (e.exit - e.entry)) + 360 * e.turns;
      e.wIn = e.w; e.wOut = e.w + (e.lead * e.wrap) / 360;
    }
  }

  const world = (u, v, w) => [0, 1, 2].map((j) => u * basis.x[j] + v * basis.y[j] + w * basis.z[j]);
  const points = [], spans = [], wraps = [];
  let length = 0;
  const arc = (e) => {
    const steps = Math.max(1, Math.ceil(e.wrap / ARC_STEP_DEG));
    for (let j = 0; j <= steps; j++) {
      const f = j / steps, a = (e.entry + e.s * e.wrap * f) * RAD;
      points.push(world(e.c[0] + e.R * Math.cos(a), e.c[1] + e.R * Math.sin(a), e.wIn + (e.wOut - e.wIn) * f));
    }
  };
  for (let i = 0; i < n; i++) {
    const e = els[i];
    if (e.kind === "anchor") points.push(world(e.c[0], e.c[1], e.w));
    else {
      arc(e);
      const theta = e.wrap * RAD;
      const len = Math.hypot(e.R * theta, (e.lead * e.wrap) / 360);
      length += len;
      wraps.push({ on: e.name, angle: e.wrap, turns: e.wrap / 360, radius: e.R, bendRatio: (2 * e.radius) / d, length: len,
        entry: e.entry, exit: e.exit, w: [e.wIn, e.wOut], runOff: e.runOff });
    }
    if (i < links) {
      const next = els[(i + 1) % n];
      const dw = next.wIn - e.wOut;
      const len = Math.hypot(tans[i].planar, dw);
      length += len;
      spans.push({ from: e.name, to: next.name, length: len, fleet: Math.atan2(Math.abs(dw), tans[i].planar) / RAD });
    }
  }
  if (closed) points.push(points[0].slice());
  return { length, spans, wraps, points };
}
