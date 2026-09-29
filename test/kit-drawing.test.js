// The kit's drawing stage (export/drawing.js): the line-run arc refit, kerf with its
// topology guard, exact bounds, and the dedupe key. The refit is conservative by
// design — a hexagon or a star must come out as the polygon it is, and a faceted
// circle as a circle — so both directions are pinned here.
import { beforeAll, describe, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import {
  refitLineRuns, refitRing, ringsOf, applyKerf, drawingBounds, canonicalDrawingKey, LAYER_ORDER, LAYER_KIND,
} from "../src/framework/export/drawing.js";
import { arcCenterAndSweep } from "../src/framework/geometry/arc-math.js";
import { pointsToContour, reverseContour } from "../src/framework/geometry/profile.js";
import {
  circleProfile, roundedRectPolygon, slotPolygon, hexPolygon, starPolygon, regularPolygon, ellipsePolygon, piePolygon,
} from "../src/framework/geometry/polygon.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const kinds = (c) => c.segments.map((s) => (s.via ? "a" : s.c1 ? "c" : "l")).join("");
// every arc of a contour as { center, r, dA }
const arcsOf = (c) => {
  const out = [];
  let from = c.start;
  for (const s of c.segments) { if (s.via) out.push(arcCenterAndSweep(from, s.via, s.to)); from = s.to; }
  return out;
};
const expectCircle = (arcs, [cx, cy], r) => {
  for (const g of arcs) {
    expect(g.center[0]).toBeCloseTo(cx, 6);
    expect(g.center[1]).toBeCloseTo(cy, 6);
    expect(g.r).toBeCloseTo(r, 6);
  }
};
const RECT = [[0, 0], [40, 0], [40, 30], [0, 30]];
// sheetHole's contract form: a CCW circle as two exact arcs (contract §4)
const hole = (x, y, r) => ({ start: [x + r, y], segments: [{ to: [x - r, y], via: [x, y + r] }, { to: [x + r, y], via: [x, y - r] }] });

test("the layer order is the cut order, and only engrave is filled", () => {
  expect(LAYER_ORDER).toEqual(["engrave", "score", "cut-inner", "cut-outer"]);
  expect(LAYER_KIND).toEqual({ engrave: "fill", score: "line", "cut-inner": "line", "cut-outer": "line" });
});

describe("refitLineRuns: faceted circles come back as arcs", () => {
  test("circleProfile's 48-gon becomes two exact half circles, closed, same start", () => {
    const ring = pointsToContour(circleProfile(5, [10, 10]));
    const out = refitLineRuns(ring);
    expect(kinds(out)).toBe("aa");
    expectCircle(arcsOf(out), [10, 10], 5);
    expect(arcsOf(out).map((g) => g.dA)).toEqual([expect.closeTo(Math.PI, 9), expect.closeTo(Math.PI, 9)]);
    expect(out.start).toEqual(ring.start);
    expect(out.segments.at(-1).to).toEqual(out.start);
  });

  test("orientation is kept: a clockwise 48-gon sweeps negative", () => {
    const out = refitLineRuns(reverseContour(pointsToContour(circleProfile(5, [10, 10]))));
    expect(kinds(out)).toBe("aa");
    expect(arcsOf(out).every((g) => g.dA < 0)).toBe(true);
  });

  test("a 48-gon hole that a boolean re-seated mid-ring still comes back whole", () => {
    const h = k.shape2d(RECT).cut(circleProfile(5, [20, 15])).toContours()[0].holes[0];
    expect(kinds(h)).toBe("l".repeat(48));
    const out = refitLineRuns(h);
    expect(kinds(out)).toBe("aa");
    expectCircle(arcsOf(out), [20, 15], 5);
    expect(arcsOf(out).every((g) => g.dA < 0)).toBe(true);   // a hole is CW
  });

  test("roundedRectPolygon's chorded corners and slotPolygon's ends become arcs; the straights stay lines", () => {
    const rr = refitLineRuns(pointsToContour(roundedRectPolygon(40, 20, 5)));
    expect(kinds(rr)).toBe("alalalal");
    for (const g of arcsOf(rr)) { expect(g.r).toBeCloseTo(5, 9); expect(g.dA).toBeCloseTo(Math.PI / 2, 9); }
    const slot = refitLineRuns(pointsToContour(slotPolygon(20, 4)));
    expect(kinds(slot)).toBe("alal");
    for (const g of arcsOf(slot)) expect(g.r).toBeCloseTo(4, 9);
  });

  test("a pie's rim becomes one arc between its two radii", () => {
    const out = refitLineRuns(pointsToContour(piePolygon(10, 120)));
    expect(kinds(out)).toBe("lal");
    expect(arcsOf(out)[0].dA).toBeCloseTo((2 * Math.PI) / 3, 9);
  });

  test("a 24-gon turns exactly 15° per step — inside the band, so it is read as a circle", () => {
    expect(kinds(refitLineRuns(pointsToContour(regularPolygon(24, 10))))).toBe("aa");
  });

  test("an open run of points on a semicircle becomes one arc and stays open", () => {
    const pts = Array.from({ length: 13 }, (_, i) => [10 * Math.cos((Math.PI * i) / 12), 10 * Math.sin((Math.PI * i) / 12)]);
    const open = { start: pts[0], segments: pts.slice(1).map((p) => ({ to: p })) };
    const out = refitLineRuns(open);
    expect(kinds(out)).toBe("a");
    expect(out.segments[0].to).toEqual([pts[12][0], pts[12][1]]);
  });

  test("a 4000-gon still refits to two arcs", () => {
    expect(kinds(refitLineRuns(pointsToContour(circleProfile(50, [0, 0], 4000))))).toBe("aa");
  });
});

// Distance from p to one contour segment: a line's nearest point, or an arc's radial gap
// when p lies inside its sweep (else the nearer endpoint).
const TAU = 2 * Math.PI;
function segmentDistance(p, from, s) {
  const g = s.via ? arcCenterAndSweep(from, s.via, s.to) : null;
  if (!g) {
    const dx = s.to[0] - from[0], dy = s.to[1] - from[1], L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((p[0] - from[0]) * dx + (p[1] - from[1]) * dy) / L2)) : 0;
    return Math.hypot(p[0] - from[0] - t * dx, p[1] - from[1] - t * dy);
  }
  const a0 = Math.atan2(from[1] - g.center[1], from[0] - g.center[0]);
  const ap = Math.atan2(p[1] - g.center[1], p[0] - g.center[0]);
  const along = g.dA >= 0 ? (((ap - a0) % TAU) + TAU) % TAU : (((a0 - ap) % TAU) + TAU) % TAU;
  if (along <= Math.abs(g.dA)) return Math.abs(Math.hypot(p[0] - g.center[0], p[1] - g.center[1]) - g.r);
  return Math.min(Math.hypot(p[0] - from[0], p[1] - from[1]), Math.hypot(p[0] - s.to[0], p[1] - s.to[1]));
}
// The farthest any authored vertex sits from the refit contour.
function worstVertexMove(pts, out) {
  let worst = 0;
  for (const p of pts) {
    let best = Infinity, from = out.start;
    for (const s of out.segments) { best = Math.min(best, segmentDistance(p, from, s)); from = s.to; }
    worst = Math.max(worst, best);
  }
  return worst;
}
// A plate whose top edge is `f` sampled at n + 1 points, right to left (so the ring is CCW).
const edgePlate = (len, n, f) => [[0, -20], [len, -20], ...Array.from({ length: n + 1 }, (_, i) => { const x = len - (len * i) / n; return [x, f(x)]; })];
const sineEdge = (len, amp, n) => edgePlate(len, n, (x) => amp * Math.sin((TAU * x) / len));

describe("refitLineRuns: a smooth curve that is not a circle is never moved (dense, never wrong — spec D.1)", () => {
  // Every run the refit accepts is held to an absolute band, so a near-flat stretch of a
  // gentle curve can no longer be swallowed by a huge three-point circle whose relative
  // tolerance ran to millimetres.
  test.each([
    ["a 600 × 5 mm sine edge at 1200 points", sineEdge(600, 5, 1200)],
    ["a 280 × 3 mm sine edge at 1120 points", sineEdge(280, 3, 1120)],
    ["a 280 × 5 mm sine edge at 560 points", sineEdge(280, 5, 560)],
    ["a 600 × 10 mm Gaussian bump sampled every 6 mm", edgePlate(600, 100, (x) => 10 * Math.exp(-(((x - 300) / 100) ** 2)))],
    ["a dense 150 × 20 mm ellipse (96 points)", ellipsePolygon(150, 20, 96)],
    ["a dense 150 × 20 mm ellipse (200 points)", ellipsePolygon(150, 20, 200)],
  ])("%s: every authored vertex stays within 0.01 mm of the output", (_, pts) => {
    expect(worstVertexMove(pts, refitLineRuns(pointsToContour(pts)))).toBeLessThan(0.01);
  });

  test("a near-straight run on a circle far wider than itself stays lines", () => {
    // 41 points on r = 5000 over 20 mm: on one circle, every turn in band — but a
    // 5000 mm arc spanning 20 mm is a flat line the laser should trace as drawn, not a
    // faceted circle to recover.
    const pts = Array.from({ length: 41 }, (_, i) => { const t = (i * 0.5) / 5000; return [5000 * Math.sin(t), 5000 * (1 - Math.cos(t))]; });
    const open = { start: pts[0], segments: pts.slice(1).map((p) => ({ to: p })) };
    expect(refitLineRuns(open)).toBe(open);
  });

  test("large and off-grid faceted circles still come back exact", () => {
    for (const [r, c] of [[200, [0, 0]], [110 / 3, [41.2345, 17.891]]]) {
      const out = refitLineRuns(pointsToContour(circleProfile(r, c)));
      expect(kinds(out)).toBe("aa");
      expectCircle(arcsOf(out), c, r);
    }
    const h = k.shape2d([[0, 0], [120, 0], [120, 120], [0, 120]]).cut(circleProfile(10, [60, 60])).toContours()[0].holes[0];
    const out = refitLineRuns(h);
    expect(kinds(out)).toBe("aa");
    expectCircle(arcsOf(out), [60, 60], 10);
  });

  test("a long run that turns one way but fits no circle is refit in linear time", () => {
    // Vertices turning 1–1.5° per step with varying step lengths: the old loop rescanned
    // the whole in-band run from every vertex whose circle fit failed (32k: ~13 s).
    const spiral = (n) => {
      const pts = [[0, 0]];
      let a = 0;
      for (let i = 1; i < n; i++) {
        a += ((1 + (0.5 * ((i * 7) % 11)) / 10) * Math.PI) / 180;
        const step = 1 + 0.5 * Math.sin(i * 1.7);
        pts.push([pts[i - 1][0] + step * Math.cos(a), pts[i - 1][1] + step * Math.sin(a)]);
      }
      return { pts, open: { start: pts[0], segments: pts.slice(1).map((p) => ({ to: p })) } };
    };
    const big = spiral(32000).open;
    const t0 = performance.now();
    refitLineRuns(big);
    expect(performance.now() - t0).toBeLessThan(3000);
    // and what it keeps is faithful (checked on a shorter stretch: the check is quadratic)
    const { pts, open } = spiral(2000);
    expect(worstVertexMove(pts, refitLineRuns(open))).toBeLessThan(0.01);
  });
});

describe("refitLineRuns: genuine polygons stay polygons (the same object back)", () => {
  test.each([
    ["a hexagon (60° turns)", hexPolygon(10)],
    ["a star (turns alternate)", starPolygon(8, 10, 8)],
    ["a 20-gon (18° turns, over the band)", regularPolygon(20, 10)],
    ["an ellipse (no 8 vertices on one circle)", ellipsePolygon(20, 10)],
    ["a 90° pie rim of 7 vertices (under minVerts)", piePolygon(10, 90, 24)],
    ["a rectangle", RECT],
  ])("%s", (_, pts) => {
    const ring = pointsToContour(pts);
    expect(refitLineRuns(ring)).toBe(ring);
  });

  test("the thresholds are options", () => {
    const ring = pointsToContour(circleProfile(5));
    expect(refitLineRuns(ring, { maxTurnDeg: 5 })).toBe(ring);    // 7.5° steps now out of band
    expect(kinds(refitLineRuns(pointsToContour(regularPolygon(20, 10)), { maxTurnDeg: 20 }))).toBe("aa");
  });
});

describe("refitRing", () => {
  test("a hole cut with cutAll comes back from its cubics as arcs on the exact circle", () => {
    const h = k.shape2d(RECT).cutAll([hole(20, 15, 5)]).toContours()[0].holes[0];
    expect(kinds(h)).toBe("cccc");
    const out = refitRing(h);
    expect(kinds(out)).toMatch(/^a+$/);
    expectCircle(arcsOf(out), [20, 15], 5);
  });

  test("ringsOf splits regions into outer rings and hole rings, region by region", () => {
    const regions = k.shape2d(RECT).cutAll([hole(10, 15, 3), hole(30, 15, 3)]).union([[50, 0], [60, 0], [60, 10], [50, 10]]).toContours();
    const { outer, holes } = ringsOf(regions);
    expect(outer).toHaveLength(2);
    expect(holes).toHaveLength(2);
  });
});

describe("drawingBounds", () => {
  const path = (start, segments, closed = true) => ({ start, segments, closed });

  test("an arc's bulge counts, not just its endpoints", () => {
    const b = drawingBounds([{ id: "cut-outer", paths: [path([10, 0], [{ to: [-10, 0], via: [0, 10] }, { to: [10, 0] }])] }]);
    expect(b.min).toEqual([-10, 0]);
    expect(b.max[0]).toBe(10);
    expect(b.max[1]).toBeCloseTo(10, 12);
  });

  test("a clockwise arc bulges the other way", () => {
    const b = drawingBounds([{ id: "score", paths: [path([10, 0], [{ to: [-10, 0], via: [0, -10] }], false)] }]);
    expect(b.min[1]).toBeCloseTo(-10, 12);
    expect(b.max[1]).toBeCloseTo(0, 12);
  });

  test("a cubic's extreme between its endpoints counts", () => {
    const b = drawingBounds([{ id: "engrave", paths: [path([0, 0], [{ to: [10, 0], c1: [0, 8], c2: [10, 8] }, { to: [0, 0] }])] }]);
    expect(b.max[1]).toBeCloseTo(6, 12);   // B(½) = ¾·8
  });

  test("no paths → null", () => {
    expect(drawingBounds([])).toBe(null);
  });
});

describe("canonicalDrawingKey", () => {
  const drawingAt = ([dx, dy]) => {
    const ring = { start: [dx, dy], segments: [{ to: [dx + 10, dy] }, { to: [dx + 10, dy + 5], via: [dx + 12.5, dy + 2.5] }, { to: [dx, dy] }], closed: true };
    const layers = [{ id: "cut-outer", paths: [ring] }];
    return { layers, bounds: drawingBounds(layers), nominal: [12.5, 5], kerf: 0 };
  };

  test("the same drawing anywhere has one key; a different one does not", () => {
    expect(canonicalDrawingKey(drawingAt([0, 0]))).toBe(canonicalDrawingKey(drawingAt([120.5, -33.25])));
    expect(canonicalDrawingKey(drawingAt([0, 0]))).toBe(canonicalDrawingKey(drawingAt([1e-6, 0])));   // under the 1e-4 rounding
    const other = drawingAt([0, 0]);
    other.layers[0].paths[0].segments[0].to = [11, 0];
    other.bounds = drawingBounds(other.layers);
    expect(canonicalDrawingKey(other)).not.toBe(canonicalDrawingKey(drawingAt([0, 0])));
  });
});

const refitRegions = (regions) => regions.map((rg) => ({ outer: refitRing(rg.outer), holes: rg.holes.map(refitRing) }));

describe("applyKerf", () => {
  const plate = () => refitRegions(k.shape2d(RECT).cutAll([hole(20, 15, 5)]).toContours());

  test("the outline grows and the hole shrinks by kerf/2, and the hole stays an exact circle", () => {
    const out = applyKerf(plate(), 0.2, { label: "Front" });
    const b = drawingBounds([{ id: "cut-outer", paths: ringsOf(out).outer.map((r) => ({ ...r, closed: true })) }]);
    expect(b.min[0]).toBeCloseTo(-0.1, 9); expect(b.min[1]).toBeCloseTo(-0.1, 9);
    expect(b.max[0]).toBeCloseTo(40.1, 9); expect(b.max[1]).toBeCloseTo(30.1, 9);
    const h = ringsOf(out).holes[0];
    expect(kinds(h)).toMatch(/^a+$/);
    expectCircle(arcsOf(h), [20, 15], 4.9);
    // round corners: the rectangle's four corners are now kerf/2 arcs
    expect(arcsOf(ringsOf(out).outer[0]).map((g) => g.r)).toEqual(Array(4).fill(expect.closeTo(0.1, 9)));
  });

  test("kerf 0 returns the very same regions — byte-identical to no kerf", () => {
    const regions = plate();
    expect(applyKerf(regions, 0, { label: "Front" })).toBe(regions);
  });

  test("a slot the kerf closes is a named options error", () => {
    const slotted = refitRegions(k.shape2d(RECT).cut([[10, 10], [10.15, 10], [10.15, 20], [10, 20]]).toContours());
    expect(() => applyKerf(slotted, 0.2, { label: "Front", gap: 0.15 }))
      .toThrow('cut kit options: kerf 0.20 mm closes a 0.15 mm slot in "Front" — widen it or lower kerf');
    expect(() => applyKerf(slotted, 0.2, { label: "Front" }))
      .toThrow('cut kit options: kerf 0.20 mm closes a slot in "Front" — widen it or lower kerf');
  });

  test("a mouth the kerf seals (a new hole) is the same error", () => {
    const c = refitRegions(k.shape2d([[0, 0], [20, 0], [20, 20], [0, 20]]).cut([[5, 5], [15, 5], [15, 15], [5, 15]])
      .cut([[9.95, 14], [10.05, 14], [10.05, 21], [9.95, 21]]).toContours());
    expect(ringsOf(c).holes).toHaveLength(0);
    expect(() => applyKerf(c, 0.2, { label: "Clip" })).toThrow('cut kit options: kerf 0.20 mm closes a slot in "Clip"');
  });

  test("pieces the kerf joins are a named options error", () => {
    const two = refitRegions(k.shape2d([[0, 0], [10, 0], [10, 10], [0, 10]]).union([[10.15, 0], [20.15, 0], [20.15, 10], [10.15, 10]]).toContours());
    expect(two).toHaveLength(2);
    expect(() => applyKerf(two, 0.2, { label: "Feet" }))
      .toThrow('cut kit options: kerf 0.20 mm joins separate pieces of "Feet" — space them apart or lower kerf');
  });
});
