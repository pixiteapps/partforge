// The kit's drawing stage (export/drawing.js): the line-run arc refit, kerf with its
// topology guard, exact bounds, and the dedupe key. The refit is conservative by
// design — a hexagon or a star must come out as the polygon it is, and a faceted
// circle as a circle — so both directions are pinned here.
import { beforeAll, describe, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import {
  refitLineRuns, refitRing, ringsOf, LAYER_ORDER, LAYER_KIND,
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
