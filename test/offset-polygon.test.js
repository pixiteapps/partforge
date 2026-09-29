// Pure unit tests for offsetPolygon — no WASM, no kernel boot.
import { expect, test } from "vitest";
import { offsetPolygon, regularPolygon } from "../src/framework/geometry/polygon.js";

const area = (p) => {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
};

const SQ = (s) => [[0, 0], [s, 0], [s, s], [0, s]];   // CCW square, corner at origin

test("sharp outset/inset of a square are exact", () => {
  expect(area(offsetPolygon(SQ(10), 1, { corners: "sharp" }))).toBeCloseTo(144, 9);  // (10+2)²
  expect(area(offsetPolygon(SQ(10), -1, { corners: "sharp" }))).toBeCloseTo(64, 9);  // (10-2)²
  expect(area(offsetPolygon(SQ(10), -1, { corners: "round" }))).toBeCloseTo(64, 9);  // inset squares have no diverging corners — style irrelevant
});

test("chamfer outset cuts 2d² off the sharp area", () => {
  expect(area(offsetPolygon(SQ(10), 1, { corners: "chamfer" }))).toBeCloseTo(144 - 2, 9);
});

test("round outset area matches the inscribed-fan closed form", () => {
  // 4 corner fans of `segs` triangles: total corner area = 2·segs·d²·sin(π/(2·segs))
  const segs = 8, d = 1.5, s = 10;
  const expected = s * s + 4 * s * d + 2 * segs * Math.sin(Math.PI / (2 * segs)) * d * d;
  expect(area(offsetPolygon(SQ(s), d, { corners: "round", segs }))).toBeCloseTo(expected, 6);
});

test("round is the default corner style", () => {
  expect(area(offsetPolygon(SQ(10), 1))).toBeCloseTo(area(offsetPolygon(SQ(10), 1, { corners: "round" })), 12);
});

test("output is CCW and either input winding is accepted", () => {
  const cw = SQ(10).slice().reverse();
  const out = offsetPolygon(cw, 1, { corners: "sharp" });
  expect(area(out)).toBeCloseTo(144, 9);     // positive ⇒ CCW
});

test("delta 0 returns a normalized copy, not the caller's arrays", () => {
  const input = SQ(10);
  const out = offsetPolygon(input, 0);
  expect(out).toEqual(input);
  expect(out).not.toBe(input);
  expect(out[0]).not.toBe(input[0]);
});

test("L-shape: reflex corner trims; sharp round-trips to identity", () => {
  const L = [[0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20]];   // CCW, area 300
  const grown = offsetPolygon(L, 1, { corners: "sharp" });
  expect(area(grown)).toBeGreaterThan(300);
  const back = offsetPolygon(grown, -1, { corners: "sharp" });
  expect(back.length).toBe(L.length);
  for (let i = 0; i < L.length; i++) {
    expect(back[i][0]).toBeCloseTo(L[i][0], 9);
    expect(back[i][1]).toBeCloseTo(L[i][1], 9);
  }
});

test("sharp falls back to chamfer past the miter limit (2·|delta|)", () => {
  // ~30° apex: miter distance d/sin(15°) ≈ 3.86d > 2d → apex chamfers (2 points);
  // 75° base corners miter (1 point each) → 4 points total.
  const needle = [[-2.679, 0], [2.679, 0], [0, 10]];
  const out = offsetPolygon(needle, 1, { corners: "sharp" });
  expect(out.length).toBe(4);
  for (const [x, y] of out) expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
});

test("input validation errors", () => {
  expect(() => offsetPolygon([[0, 0], [1, 0]], 1)).toThrow("offsetPolygon: need at least 3 points");
  expect(() => offsetPolygon(SQ(10), NaN)).toThrow("offsetPolygon: delta must be a finite number");
  expect(() => offsetPolygon(SQ(10), "0.2")).toThrow("offsetPolygon: delta must be a finite number");
  expect(() => offsetPolygon(SQ(10), 1, { corners: "bevel" }))
    .toThrow('offsetPolygon: corners must be "round" | "chamfer" | "sharp"');
  expect(() => offsetPolygon([[0, 0], [1, NaN], [1, 1]], 1)).toThrow("offsetPolygon: coordinates must be finite numbers");
  expect(() => offsetPolygon(null, 1)).toThrow("offsetPolygon: profile must be a point list, a path contour, or {outer, holes}");
  const bowtie = [[0, 0], [10, 10], [10, 0], [0, 10]];
  expect(() => offsetPolygon(bowtie, 0.5)).toThrow("offsetPolygon: input polygon self-intersects");
});

test("collapse and result-self-intersection throw", () => {
  expect(() => offsetPolygon(SQ(10), -5, { corners: "sharp" })).toThrow("offsetPolygon: offset collapses the polygon");
  expect(() => offsetPolygon(SQ(10), -7, { corners: "sharp" })).toThrow("offsetPolygon: offset collapses the polygon");
  // dumbbell: two 10-wide lobes joined by a 2-wide waist — inset past the waist
  // would split the region; we throw instead of returning a figure-eight.
  const dumbbell = [
    [0, 0], [10, 0], [10, 4], [14, 4], [14, 0], [24, 0],
    [24, 10], [14, 10], [14, 6], [10, 6], [10, 10], [0, 10],
  ];
  expect(() => offsetPolygon(dumbbell, -1.5, { corners: "sharp" }))
    .toThrow("offsetPolygon: offset result self-intersects (reduce |delta| or simplify the profile)");
});

test("regions offset as material: outer grows, holes shrink", () => {
  const region = { outer: SQ(40), holes: [[[15, 15], [25, 15], [25, 25], [15, 25]]] };
  const out = offsetPolygon(region, 1, { corners: "sharp" });
  expect(area(out.outer)).toBeCloseTo(42 * 42, 9);
  expect(area(out.holes[0])).toBeCloseTo(8 * 8, 9);
  // input without holes mirrors shape: no holes key on output
  expect(offsetPolygon({ outer: SQ(10) }, 1, { corners: "sharp" }).holes).toBeUndefined();
});

test("a hole that would vanish throws collapse", () => {
  const region = { outer: SQ(40), holes: [[[15, 15], [25, 15], [25, 25], [15, 25]]] };
  expect(() => offsetPolygon(region, 6, { corners: "sharp" }))
    .toThrow("offsetPolygon: offset collapses the polygon");
});

test("sharp inset of a regular n-gon reproduces planter's closed form", () => {
  // planter.js derives Rin = Rout − wall/cos(π/n); a sharp inset along the face
  // normals is exactly that — each inset vertex is the original scaled by Rin/Rout.
  for (const n of [3, 6, 9]) {
    const Rout = 60, wall = 3;
    const outer = regularPolygon(n, Rout);
    const inner = offsetPolygon(outer, -wall, { corners: "sharp" });
    const scale = (Rout - wall / Math.cos(Math.PI / n)) / Rout;
    expect(inner.length).toBe(n);
    for (let i = 0; i < n; i++) {
      expect(inner[i][0]).toBeCloseTo(outer[i][0] * scale, 9);
      expect(inner[i][1]).toBeCloseTo(outer[i][1] * scale, 9);
    }
  }
});

test("purity: identical input twice gives deeply equal output", () => {
  const L = [[0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20]];
  expect(offsetPolygon(L, 0.7, { corners: "round" }))
    .toEqual(offsetPolygon(L, 0.7, { corners: "round" }));
});
