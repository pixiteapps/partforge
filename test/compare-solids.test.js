import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { compareTolerance, COMPARE_MAX_TRIANGLES } from "../src/framework/oracle/compare.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const box = (n) => ({ min: [0, 0, 0], max: [n, n, n] });

describe("compareTolerance", () => {
  test("0.1% of the shared diagonal, clamped to 0.02-0.25 mm", () => {
    expect(compareTolerance(box(160), box(160))).toBeCloseTo(0.25, 2);   // 277 mm diagonal, clamped
    expect(compareTolerance(box(20), box(20))).toBeCloseTo(0.0346, 3);
    expect(compareTolerance(box(5), box(5))).toBe(0.02);
  });
  test("reads the union of the two boxes", () => {
    const a = { min: [0, 0, 0], max: [20, 20, 20] };
    const b = { min: [20, 0, 0], max: [40, 20, 20] };
    expect(compareTolerance(a, b)).toBeCloseTo(Math.hypot(40, 20, 20) / 1000, 6);
  });
  test("the triangle ceiling", () => {
    expect(COMPARE_MAX_TRIANGLES).toBe(300000);
  });
});

describe("_compareSolids", () => {
  test("partitions a part and its reference into disjoint common / missing / excess", () => {
    const plate = () => k.box({ size: [40, 40, 4] });
    const ref = plate().union(k.cylinder({ d: 8, h: 6 }).at([-10, 0, 4]));   // boss
    const part = plate().union(k.box({ size: [10, 6, 4] }).at([25, 0, 0]));   // tab
    const r = k._compareSolids(part, ref, { tolerance: 0.1 });
    const sum = r.common.volume() + r.missing.volume() + r.excess.volume();
    expect(sum).toBeCloseTo(part.union(ref).volume(), 3);
    expect(r.common.intersect(r.missing).volume()).toBeLessThan(1e-6);
    expect(r.common.intersect(r.excess).volume()).toBeLessThan(1e-6);
    expect(r.regions.map((x) => x.change).sort()).toEqual(["excess", "missing"]);
    expect(r.regions[0].mm3).toBeGreaterThanOrEqual(r.regions[1].mm3);
    expect(r.missingVolume).toBeCloseTo(r.missing.volume(), 6);
    expect(r.excessVolume).toBeCloseTo(r.excess.volume(), 6);
    const boss = r.regions.find((x) => x.change === "missing");
    expect(boss.at[0]).toBeCloseTo(-10, 0);
    expect(boss.at[2]).toBeCloseTo(7, 0);
    expect(boss.size[2]).toBeCloseTo(6, 3);
    k.cleanup();
  });

  test("tolerance drops a skin and keeps a feature in common", () => {
    const plate = () => k.box({ size: [30, 30, 6] });
    const hole = (r) => k.cylinder({ d: 2 * r, h: 20 }).at([0, 0, -5]);
    const boss = () => k.cylinder({ d: 6, h: 2 }).at([10, 10, 6]);
    const part = plate().cut(hole(5));
    const ref = plate().cut(hole(5.05)).union(boss());
    const bossVolume = boss().volume();
    const r2 = k._compareSolids(part, ref, { tolerance: 0.1 });
    expect(r2.excess).toBeNull();                         // the 0.05 mm ring in the hole
    expect(r2.excessVolume).toBe(0);
    expect(r2.missing.volume()).toBeCloseTo(bossVolume, 0);
    expect(r2.regions).toHaveLength(1);
    // dropped material stays in common: common = (part ∪ ref) − missing
    expect(r2.common.volume() + r2.missing.volume()).toBeCloseTo(part.union(ref).volume(), 3);
    k.cleanup();
  });

  test("an exact match has nothing missing or extra", () => {
    const a = k.box({ size: [10, 10, 10] }).union(k.cylinder({ d: 4, h: 4 }).at([0, 0, 10]));
    expect(k._compareSolids(a, a.translate([0, 0, 0]), { tolerance: 0.1 }))
      .toMatchObject({ missing: null, excess: null, regions: [], missingVolume: 0, excessVolume: 0 });
    k.cleanup();
  });

  test("lists at most 8 regions, largest first, totals over every kept piece", () => {
    const plate = () => k.box({ size: [100, 20, 2] });
    let ref = plate();
    let expected = 0;
    for (let i = 0; i < 10; i++) {
      const bump = k.box({ size: [4, 4, 1 + i] }).at([-45 + i * 10, 0, 2]);
      expected += bump.volume();
      ref = ref.union(bump);
    }
    const r = k._compareSolids(plate(), ref, { tolerance: 0.1 });
    expect(r.regions).toHaveLength(8);
    for (let i = 1; i < r.regions.length; i++) expect(r.regions[i - 1].mm3).toBeGreaterThanOrEqual(r.regions[i].mm3);
    expect(r.regions[0].mm3).toBeCloseTo(160, 3);
    expect(r.missingVolume).toBeCloseTo(expected, 3);
    k.cleanup();
  });

  test("the kernel's default ceiling is COMPARE_MAX_TRIANGLES", () => {
    // The kernel cannot import ./oracle (kit-layering.test.js), so it spells the
    // default as a literal; this pins the two together.
    const src = readFileSync(new URL("../src/framework/geometry/manifold-backend.js", import.meta.url), "utf8");
    const m = src.match(/_compareSolids: \(a, b, \{ tolerance = 0, maxTriangles = (\d+) \}/);
    expect(Number(m?.[1])).toBe(COMPARE_MAX_TRIANGLES);
  });

  test("refuses inputs over the triangle ceiling before any boolean", () => {
    const big = k.sphere ? k.sphere({ d: 20 }) : k.cylinder({ d: 20, h: 20 });
    const big2 = big.translate([1, 0, 0]);
    expect(k._compareSolids(big, big2, { tolerance: 0.1, maxTriangles: 100 })).toEqual({ skipped: "too-large" });
    k.cleanup();
  });

  test("refuses an empty input as not-closed", () => {
    const a = k.box({ size: [10, 10, 10] });
    const empty = a.cut(k.box({ size: [20, 20, 20] }));
    expect(empty.isEmpty()).toBe(true);
    expect(k._compareSolids(a, empty, { tolerance: 0.1 })).toEqual({ skipped: "not-closed" });
    expect(k._compareSolids(empty, a, { tolerance: 0.1 })).toEqual({ skipped: "not-closed" });
    k.cleanup();
  });
});
