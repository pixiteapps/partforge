import { expect, test } from "vitest";
import { recoverArcs } from "../src/framework/geometry/arc-fit.js";
import { arcCenterAndSweep } from "../src/framework/geometry/paper-bridge.js";
import { PACE, cpuMs } from "./helpers/cpu-pace.js";

// A circle the way paper.js builds one: four cubics with the standard kappa
// handle. This is the exact shape importSVG hands back for a <circle>.
const KAPPA = 0.5522847498307936;
function paperCircle(cx, cy, r) {
  const k = KAPPA * r;
  const pts = [[cx + r, cy], [cx, cy + r], [cx - r, cy], [cx, cy - r]];
  const tans = [[0, k], [-k, 0], [0, -k], [k, 0]];
  const segments = [];
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4], ta = tans[i], tb = tans[(i + 1) % 4];
    segments.push({ to: b, c1: [a[0] + ta[0], a[1] + ta[1]], c2: [b[0] - tb[0], b[1] - tb[1]] });
  }
  return { start: pts[0], segments };
}

test("a paper-style circle collapses to arcs", () => {
  const out = recoverArcs(paperCircle(5, 7, 3));
  expect(out.segments.every((s) => s.via)).toBe(true);
  expect(out.segments.every((s) => s.c1 === undefined)).toBe(true);
});

// Sweep-direction coverage: paperCircle above always traces CCW (right → top →
// left → bottom, positive dA). recoverArcs' 3-point circle fit has to be
// equally correct for the opposite handedness — nothing about ingest
// guarantees CCW: a transformed <circle> (e.g. a negative scale) or a winding
// flip (svg-ingest.js negates y to go from SVG's y-down to the model's y-up,
// which reverses every contour's sense) can hand recoverArcs a CW run just as
// easily. This is the highest-risk part of arc recovery — a sign error in the
// fit or in how the recovered `via` encodes sweep direction — and until now
// nothing here traced a circle the other way to catch it.
function paperCircleCW(cx, cy, r) {
  const k = KAPPA * r;
  const pts = [[cx + r, cy], [cx, cy - r], [cx - r, cy], [cx, cy + r]];
  const tans = [[0, -k], [-k, 0], [0, k], [k, 0]];
  const segments = [];
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4], ta = tans[i], tb = tans[(i + 1) % 4];
    segments.push({ to: b, c1: [a[0] + ta[0], a[1] + ta[1]], c2: [b[0] - tb[0], b[1] - tb[1]] });
  }
  return { start: pts[0], segments };
}

test("a clockwise (mirrored) circle also collapses to arcs, with the correct negative sweep", () => {
  const out = recoverArcs(paperCircleCW(5, 7, 3));
  expect(out.segments.every((s) => s.via)).toBe(true);
  expect(out.segments.every((s) => s.c1 === undefined)).toBe(true);
  let prev = out.start;
  for (const s of out.segments) {
    const c = arcCenterAndSweep(prev, s.via, s.to);
    expect(c.center[0]).toBeCloseTo(5, 6);
    expect(c.center[1]).toBeCloseTo(7, 6);
    expect(c.r).toBeCloseTo(3, 6);
    expect(c.dA).toBeLessThan(0);   // CW is the negative-sweep sense in this convention — CCW (above) is positive
    prev = s.to;
  }
});

test("the recovered circle has the exact original centre and radius", () => {
  const out = recoverArcs(paperCircle(5, 7, 3));
  let prev = out.start;
  for (const s of out.segments) {
    const c = arcCenterAndSweep(prev, s.via, s.to);
    expect(c.center[0]).toBeCloseTo(5, 6);
    expect(c.center[1]).toBeCloseTo(7, 6);
    expect(c.r).toBeCloseTo(3, 6);
    prev = s.to;
  }
});

test("a full circle is split into arcs of at most 180 degrees", () => {
  const out = recoverArcs(paperCircle(0, 0, 1));
  expect(out.segments.length).toBeGreaterThanOrEqual(2);
  let prev = out.start;
  for (const s of out.segments) {
    const c = arcCenterAndSweep(prev, s.via, s.to);
    expect(Math.abs(c.dA)).toBeLessThanOrEqual(Math.PI + 1e-9);
    prev = s.to;
  }
});

test("an ellipse does not collapse — it is not a circle", () => {
  const c = paperCircle(0, 0, 4);
  const squash = (p) => [p[0], p[1] / 2];
  const flat = { start: squash(c.start), segments: c.segments.map((s) => ({ to: squash(s.to), c1: squash(s.c1), c2: squash(s.c2) })) };
  const out = recoverArcs(flat);
  expect(out.segments.some((s) => s.c1)).toBe(true);
});

test("a freeform curve does not collapse", () => {
  const wiggle = { start: [0, 0], segments: [
    { to: [10, 0], c1: [2, 8], c2: [8, -8] },
    { to: [20, 4], c1: [12, 6], c2: [18, -2] },
  ] };
  const out = recoverArcs(wiggle);
  expect(out.segments).toEqual(wiggle.segments);
});

test("lines and existing arcs pass through untouched", () => {
  const mixed = { start: [0, 0], segments: [
    { to: [5, 0] }, { to: [10, 5], via: [9, 1] }, { to: [0, 5] },
  ] };
  expect(recoverArcs(mixed)).toEqual(mixed);
});

test("a circular run collapses while its non-circular neighbours stay cubic", () => {
  const c = paperCircle(0, 0, 2);
  const mixed = { start: [0, 0], segments: [
    { to: c.start },                                   // a line into the arc run
    ...c.segments.slice(0, 2),                         // half the circle
    { to: [40, 40], c1: [20, 0], c2: [30, 30] },       // a freeform cubic out of it
  ] };
  const out = recoverArcs(mixed);
  expect(out.segments[0].via).toBeUndefined();         // line untouched
  expect(out.segments.some((s) => s.via)).toBe(true);  // the run collapsed
  expect(out.segments.at(-1).c1).toEqual([20, 0]);     // freeform untouched
});

test("a single cubic that is a quarter circle collapses on its own", () => {
  const c = paperCircle(0, 0, 5);
  const one = { start: c.start, segments: [c.segments[0], { to: c.start }] };
  const out = recoverArcs(one);
  expect(out.segments[0].via).toBeDefined();
});

test("endpoints are preserved exactly", () => {
  const c = paperCircle(3, 4, 2);
  const out = recoverArcs(c);
  expect(out.start).toEqual(c.start);
  expect(out.segments.at(-1).to).toEqual(c.segments.at(-1).to);
});

// --- the tolerance must not grow with the fitted radius ----------------------
//
// The acceptance band used to be `1e-3 * r` alone, where r is the radius of the
// circle the run FITS. A nearly-straight run fits a huge circle, so the band grew
// without limit exactly where the author's own feature was smallest, and a gentle
// asymmetric cubic — the most common curve in real logo artwork — was silently
// replaced by an arc that missed it by half the curve's own depth. Nothing threw,
// and the stored file then claimed `"kind": "arc"`, so the intent was unrecoverable.
//
// Max deviation of a cubic run from the circle a recovered arc encodes, sampled
// densely. The arc's three points (previous point, `via`, `to`) determine it.
const deviationFromArc = (start, cubics, arc) => {
  const c = arcCenterAndSweep(start, arc.via, arc.to);
  const d = (p) => Math.hypot(p[0] - c.center[0], p[1] - c.center[1]);
  const at = (p0, s, t) => {
    const u = 1 - t;
    return [0, 1].map((i) =>
      u ** 3 * p0[i] + 3 * u * u * t * s.c1[i] + 3 * u * t * t * s.c2[i] + t ** 3 * s.to[i]);
  };
  let max = 0, p = start;
  for (const s of cubics) {
    for (let i = 0; i <= 200; i++) max = Math.max(max, Math.abs(d(at(p, s, i / 200)) - c.r));
    p = s.to;
  }
  return max;
};

const straightRun = (c1, c2) => ({ start: [0, 0], segments: [{ c1, c2, to: [100, 0] }] });

test("a shallow ASYMMETRIC cubic is left alone, not swallowed by a huge-radius fit", () => {
  // Reported case: fitted r = 913.6, max deviation 0.701 against the curve's own
  // sagitta of 1.427 — 49% error, accepted silently.
  const out = recoverArcs(straightRun([10, 3.0], [55, 0.4]));
  expect(out.segments[0].via).toBeUndefined();
  expect(out.segments[0].c1).toEqual([10, 3.0]);

  // …and the milder sibling from the same report (27% error) too.
  expect(recoverArcs(straightRun([20, 2.2], [70, 0.9])).segments[0].via).toBeUndefined();
});

test("a shallow cubic that really is near-circular still recovers, and accurately", () => {
  const run = straightRun([33, 1.5], [67, 1.5]);
  const out = recoverArcs(run);
  expect(out.segments[0].via).toBeDefined();
  // Fidelity, not just acceptance: within 2e-3 of the 100-unit chord.
  expect(deviationFromArc(run.start, run.segments, out.segments[0])).toBeLessThan(0.2);
});

test("a deep non-circular cubic stays a cubic (unchanged behaviour)", () => {
  expect(recoverArcs(straightRun([33, 40], [67, 40])).segments[0].via).toBeUndefined();
});

test("genuine circles still recover across four orders of magnitude of radius", () => {
  // The chord bound must not be so tight that a real large-radius circle — the
  // thing a radius-relative tolerance existed to protect — stops being one.
  for (const r of [0.5, 5, 100, 5000]) {
    const out = recoverArcs(paperCircle(0, 0, r));
    expect(out.segments.every((s) => s.via), `r=${r} lost its arcs`).toBe(true);
  }
});

// --- a run whose fit points are collinear is not a circle --------------------
//
// The fit runs through a run's first, middle and last endpoints. On a sine-wave edge —
// one cubic per quarter period — a run spanning whole periods has those three points on
// one straight line to float noise: the fitted radius came out near 1e17, `dist − r`
// cancelled to exactly 0 at every probe, and 14 of the wave's cubics were replaced by ONE
// "arc" that is a straight chord. Its ±3 mm were gone from every shape built on it — the
// laser checks' width searches read "nothing narrower than 3 mm" over a real 1 mm web
// (test/sheet-dfm.test.js). A fit that far from its own points is refused, and a probe's
// distance from the circle is measured without that cancellation.
// A sine of amplitude `amp` and period `period` over `periods` periods, one Hermite cubic
// per quarter period, run right to left as a plate's top edge runs.
const sineWave = (amp, period, periods, x0 = 0, y0 = 60) => {
  const n = periods * 4, dx = period / 4, k2 = (2 * Math.PI) / period;
  const y = (x) => y0 + amp * Math.sin(k2 * (x - x0)), dy = (x) => amp * k2 * Math.cos(k2 * (x - x0));
  const segments = [];
  for (let i = n; i > 0; i--) {
    const a = x0 + i * dx, b = x0 + (i - 1) * dx, h3 = (b - a) / 3;
    segments.push({ c1: [a + h3, y(a) + dy(a) * h3], c2: [b - h3, y(b) - dy(b) * h3], to: [b, y(b)] });
  }
  return { start: [x0 + n * dx, y(x0 + n * dx)], segments };
};
test("a sine-wave edge is never read as one arc, however many periods it runs", () => {
  for (const periods of [4, 6, 8, 500]) {
    const out = recoverArcs(sineWave(3, 25, periods, 12.5));
    expect(out.segments.filter((s) => s.via), `${periods} periods`).toEqual([]);
  }
});

// What is and is not a circle. `turned(c, a)` rotates a contour about the origin, so a
// collinear triple is collinear only to float noise, as it is on real artwork.
const turned = (c, a) => {
  const r = (p) => [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a)];
  return { start: r(c.start), segments: c.segments.map((s) => ({ to: r(s.to), ...(s.c1 ? { c1: r(s.c1), c2: r(s.c2) } : {}) })) };
};
// An arc of radius r about `c` from angle a0 sweeping `sweep`, as n cubics with the exact
// circular handle — a run the fit must read as the circle it is.
const circularRun = (c, r, a0, sweep, n) => {
  const P = (a) => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
  const d = sweep / n, k = Math.abs((4 / 3) * Math.tan(d / 4) * r), s = Math.sign(d);
  const segments = [];
  for (let i = 0; i < n; i++) {
    const a = a0 + i * d, b = a + d, pa = P(a), pb = P(b);
    segments.push({ c1: [pa[0] - s * k * Math.sin(a), pa[1] + s * k * Math.cos(a)],
      c2: [pb[0] + s * k * Math.sin(b), pb[1] - s * k * Math.cos(b)], to: pb });
  }
  return { start: P(a0), segments };
};
const circleOf = (start, arc) => arcCenterAndSweep(start, arc.via, arc.to);
test.each([
  ["three collinear straight cubics", { start: [0, 0], segments: [0, 1, 2].map((i) => ({ c1: [10 * i + 10 / 3, 0], c2: [10 * i + 20 / 3, 0], to: [10 * i + 10, 0] })) }],
  ["a symmetric two-cubic S", { start: [0, 0], segments: [{ c1: [3, 4], c2: [7, 4], to: [10, 0] }, { c1: [13, -4], c2: [17, -4], to: [20, 0] }] }],
  ["one period of a sine wave", sineWave(3, 25, 1, 0, 0)],
  ["two periods of a shallow sine wave", sineWave(0.5, 30, 2, 0, 0)],
])("%s stays cubic at any angle: no arc spans two of its cubics", (_, curve) => {
  for (const a of [0, 0.3, Math.PI / 6, 1, 2.2]) {
    const input = turned(curve, a);
    // A single cubic may be read as the circle it is within tolerance (a shallow sine's
    // quarter is); no ARC may run from one of the input's joints past the next.
    const joints = [input.start, ...input.segments.map((s) => s.to)];
    const jointOf = (p) => joints.findIndex((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-9);
    const out = recoverArcs(input);
    let from = out.start;
    for (const s of out.segments) {
      if (s.via) expect(jointOf(s.to) - jointOf(from), `angle ${a}`).toBe(1);
      from = s.to;
    }
  }
});
test("a true large-radius arc is still read as its circle, exactly", () => {
  for (const r of [5000, 1e5]) {                       // 100 mm spans: r up to 1000 × the span
    const run = circularRun([0, -r], r, Math.PI / 2 - 50 / r, 100 / r, 4);
    const out = recoverArcs(run);
    expect(out.segments.every((s) => s.via), `r ${r}`).toBe(true);
    const c = circleOf(out.start, out.segments[0]);
    expect(c.r / r - 1, `r ${r}`).toBeLessThan(1e-9);
    expect(Math.abs(c.center[1] + r) / r, `r ${r}`).toBeLessThan(1e-9);
  }
});
test("quarter-circle Béziers from r 0.5 to 500 are read as their circles, either way round", () => {
  for (const r of [0.5, 1, 5, 50, 500]) for (const [sweep, n] of [[Math.PI / 2, 1], [Math.PI, 2], [-Math.PI / 2, 1], [-Math.PI, 2], [1.5 * Math.PI, 3]]) {
    const at = `r ${r}, sweep ${sweep.toFixed(2)} in ${n}`;
    const out = recoverArcs(circularRun([3, 4], r, 0.3, sweep, n));
    expect(out.segments.every((s) => s.via), at).toBe(true);
    let from = out.start;
    for (const s of out.segments) {
      const c = circleOf(from, s);
      expect(Math.abs(c.r - r) / r, at).toBeLessThan(2e-3);
      expect(Math.hypot(c.center[0] - 3, c.center[1] - 4) / r, at).toBeLessThan(2e-3);
      expect(Math.sign(c.dA), at).toBe(Math.sign(sweep));
      from = s.to;
    }
  }
});

// --- the search: the longest run that fits, found in time linear in the cubics -----------
//
// The fit is tried for every length a run from a given cubic can reach, and the longest that
// fits wins. A shorter run that does not fit rules nothing out: a gentle large-radius arc's
// short runs are refused as too flat for their span, and the same arc tiny and far from the
// origin has short runs whose three-point fits rounding swamps — both read as one arc only
// because the search looks past those failures. It stops at a miss no longer run can make
// up, and does not re-probe what a longer fit could not have changed; trying every length
// and re-probing each whole made one ring of 1,600 cubics that are not a circle cost 3.4 s
// (roughly cubic), and a circle of 4,000 cubics 3.6 s (quadratic) — before the laser checks'
// first priced step, since they read their shapes through this fit.
test("a large-radius arc in many cubics is one arc, though its short runs are too flat to fit", () => {
  for (const [r, length, n] of [[5e4, 12, 8], [1e5, 16, 8], [1e5, 24, 12], [1e6, 160, 8]]) {
    const out = recoverArcs(circularRun([0, -r], r, Math.PI / 2 - length / 2 / r, length / r, n));
    expect(out.segments.every((s) => s.via), `r ${r}, ${length} mm in ${n}`).toBe(true);
    const c = circleOf(out.start, out.segments[0]);
    expect(Math.abs(c.r / r - 1), `r ${r}`).toBeLessThan(1e-6);
  }
});
test("a tiny arc far from the origin is one arc, though rounding swamps its short runs' fits", () => {
  for (const a0 of [0, 1, 3, 5]) {                     // r 0.0972 mm, 0.763° in 8 cubics, ~1,200 mm out
    const out = recoverArcs(circularRun([-773.7, 957.6], 0.0972, a0, (-0.763 * Math.PI) / 180, 8));
    expect(out.segments.map((s) => (s.via ? "A" : "C")).join(""), `a0 ${a0}`).toBe("A");
  }
});
// A closed organic outline: Catmull-Rom cubics through n points of a wobbly ellipse, none of
// them on one circle for long (the reviewer's ring); and a circle of n kappa cubics.
const organicRing = (n) => {
  const pts = Array.from({ length: n }, (_, i) => {
    const th = (2 * Math.PI * i) / n, r = 40 + 6 * Math.sin(7 * th) + 2 * Math.sin(23 * th + 1) + Math.sin(51 * th + 2);
    return [1.3 * r * Math.cos(th), r * Math.sin(th)];
  });
  const segments = pts.map((p1, i) => {
    const p0 = pts[(i - 1 + n) % n], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    return { c1: [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2: [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6], to: p2 };
  });
  return { start: pts[0], segments };
};
// `cpuMs` is main-thread CPU time in the calibration desktop's milliseconds
// (test/helpers/cpu-pace.js): on a runner PACE times slower, 150 is 150 × PACE ms of its own.
test("1,600 and 4,000 cubics that are not a circle, or 4,000 that are, are read in under 150 ms of CPU", () => {
  for (const [name, ring] of [["organic 1,600", organicRing(1600)], ["organic 4,000", organicRing(4000)],
    ["circle of 4,000", circularRun([0, 0], 40, 0, 2 * Math.PI - 1e-3, 4000)]]) {
    const t0 = cpuMs();
    const out = recoverArcs(ring);
    const ms = cpuMs() - t0;
    expect(ms, `${name} (pace ${PACE.toFixed(2)})`).toBeLessThan(150);   // were 3.4 s, ~50 s and 3.6 s
    expect(out.segments.length, name).toBeGreaterThan(0);
  }
  expect(recoverArcs(circularRun([0, 0], 40, 0, 2 * Math.PI - 1e-3, 4000)).segments.every((s) => s.via)).toBe(true);
});
