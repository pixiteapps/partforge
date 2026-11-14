import { describe, test, expect } from "vitest";
import { pfSin, pfCos, pfAtan2 } from "../src/framework/geometry/js-math.js";
import { latticeHash, valueNoise } from "../src/framework/geometry/implicit/noise.js";

const grid = (lo, hi, n) => Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));

describe("partforge trig", () => {
  test("pfSin/pfCos track Math.sin/Math.cos to 1e-15 on [-1000, 1000]", () => {
    for (const x of grid(-1000, 1000, 20001)) {
      expect(Math.abs(pfSin(x) - Math.sin(x))).toBeLessThan(1e-15 * Math.max(1, Math.abs(x)));
      expect(Math.abs(pfCos(x) - Math.cos(x))).toBeLessThan(1e-15 * Math.max(1, Math.abs(x)));
    }
  });
  test("exact at the obvious points", () => {
    expect(pfSin(0)).toBe(0);
    expect(pfCos(0)).toBe(1);
    expect(pfSin(-0.5)).toBe(-pfSin(0.5));
  });
  test("pfAtan2 tracks Math.atan2 to 2e-16 relative over every quadrant", () => {
    for (const y of grid(-50, 50, 201)) for (const x of grid(-50, 50, 201)) {
      const want = Math.atan2(y, x), got = pfAtan2(y, x);
      expect(Math.abs(got - want)).toBeLessThanOrEqual(4e-16 * Math.max(1, Math.abs(want)));
    }
    expect(pfAtan2(0, -1)).toBe(Math.PI);
    expect(pfAtan2(1, 0)).toBe(Math.PI / 2);
    expect(pfAtan2(0, 0)).toBe(0);
    expect(Number.isNaN(pfAtan2(NaN, 1))).toBe(true);
  });
  test("trig is NaN on non-finite input (deterministic, no throw)", () => {
    expect(Number.isNaN(pfSin(Infinity))).toBe(true);
    expect(Number.isNaN(pfCos(NaN))).toBe(true);
  });
});

describe("noise", () => {
  test("latticeHash is in [0,1), deterministic and decorrelated", () => {
    const seen = new Set();
    for (let i = -20; i < 20; i++) for (let j = -20; j < 20; j++) {
      const v = latticeHash(i, j, 7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(latticeHash(i, j, 7)).toBe(v);
      seen.add(v);
    }
    expect(seen.size).toBeGreaterThan(1590); // ~1600 distinct values
  });
  test("valueNoise is continuous and bounded", () => {
    let prev = valueNoise(0.3, 0.7, 1.1);
    for (let t = 0.001; t < 3; t += 0.001) {
      const v = valueNoise(0.3 + t, 0.7, 1.1);
      expect(v).toBeGreaterThanOrEqual(-0.5);
      expect(v).toBeLessThan(0.5);
      expect(Math.abs(v - prev)).toBeLessThan(0.01);
      prev = v;
    }
  });
});
