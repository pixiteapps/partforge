import { describe, test, expect } from "vitest";
import { PRIM, PRIM_LIPSCHITZ, evalPrim, roundConeParams, unionN, intersectN, WARP, warpPoint, sanitize } from "../src/framework/geometry/implicit/primitives.js";
import { smin2 } from "../src/framework/geometry/implicit/expr-lower.js";

const F = (...v) => Float64Array.of(...v);
let seed = 7;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;

const CASES = [
  ["sphere", PRIM.SPHERE, F(3)],
  ["ellipsoid", PRIM.ELLIPSOID, F(4, 2, 1)],
  ["ellipsoid long x", PRIM.ELLIPSOID, F(10, 1, 1)],
  ["ellipsoid long y", PRIM.ELLIPSOID, F(1, 6, 2)],
  ["capsule", PRIM.CAPSULE, F(-2, 0, 0, 3, 1, 0, 1.5)],
  ["roundcone", PRIM.ROUNDCONE, roundConeParams([0, 0, 0], [0, 6, 0], 2, 1)],
  ["box", PRIM.BOX, F(2, 3, 1, 0.4)],
  ["cylinder", PRIM.CYLINDER, F(3, 2, 0.3)],
  ["torus", PRIM.TORUS, F(4, 1)],
  ["halfspace", PRIM.HALFSPACE, F(0, 0, 1, 2)],
];

describe("primitives", () => {
  test("known values", () => {
    expect(evalPrim(PRIM.SPHERE, F(3), 0, 0, 5)).toBe(2);
    expect(evalPrim(PRIM.BOX, F(1, 1, 1, 0), 3, 0, 0)).toBe(2);
    expect(evalPrim(PRIM.CYLINDER, F(2, 1, 0), 0, 0, 0)).toBe(-1);
    expect(evalPrim(PRIM.TORUS, F(4, 1), 4, 0, 0)).toBe(-1);
    expect(evalPrim(PRIM.HALFSPACE, F(0, 0, 1, 2), 0, 0, 5)).toBe(3);
    expect(evalPrim(PRIM.CAPSULE, F(0, 0, 0, 0, 10, 0, 1), 0, 5, 3)).toBe(2);
  });
  test("every primitive's gradient magnitude stays within its Lipschitz bound (1 unless PRIM_LIPSCHITZ says otherwise)", () => {
    const e = 1e-5;
    for (const [name, code, P] of CASES) {
      let worst = 0;
      for (let i = 0; i < 4000; i++) {
        const sc = i % 4 === 0 ? 0.05 : 9;   // every fourth point is near the centre
        const x = rnd() * sc, y = rnd() * sc, z = rnd() * sc;
        const gx = (evalPrim(code, P, x + e, y, z) - evalPrim(code, P, x - e, y, z)) / (2 * e);
        const gy = (evalPrim(code, P, x, y + e, z) - evalPrim(code, P, x, y - e, z)) / (2 * e);
        const gz = (evalPrim(code, P, x, y, z + e) - evalPrim(code, P, x, y, z - e)) / (2 * e);
        worst = Math.max(worst, Math.sqrt(gx * gx + gy * gy + gz * gz));
      }
      expect(worst, name).toBeLessThanOrEqual((PRIM_LIPSCHITZ[code] ?? 1) + 1e-4);
    }
  });
  test("unionN of two children IS the normalized quadratic smin", () => {
    for (let i = 0; i < 1000; i++) {
      const a = rnd() * 3, b = rnd() * 3, k = Math.abs(rnd()) * 2;
      expect(unionN(F(a, b), 2, k)).toBe(smin2(a, b, k));
    }
  });
  test("unionN/intersectN do not depend on child order", () => {
    const v = [0.3, 0.9, -0.2, 0.5];
    const perms = [[0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 0, 2]];
    const u = perms.map((p) => unionN(F(...p.map((i) => v[i])), 4, 1.2));
    const n = perms.map((p) => intersectN(F(...p.map((i) => v[i])), 4, 1.2));
    expect(new Set(u).size).toBe(1);
    expect(new Set(n).size).toBe(1);
  });
  test("a child ≥ k above the minimum contributes exactly nothing", () => {
    expect(unionN(F(0.2, 5, 0.6), 3, 1)).toBe(unionN(F(0.2, 0.6), 2, 1));
    expect(intersectN(F(0.2, -5, 0.6), 3, 1)).toBe(intersectN(F(0.2, 0.6), 2, 1));
  });
  test("warps: twist turns xy, bend maps the axis onto an arc, taper scales xy", () => {
    const o = [0, 0, 0];
    warpPoint(o, WARP.TWIST, F(Math.PI / 20), 1, 0, 10);      // 90° at z = 10
    expect(o[0]).toBeCloseTo(0, 12); expect(o[1]).toBeCloseTo(-1, 12); expect(o[2]).toBe(10);
    const R = 10, th = 0.5;
    warpPoint(o, WARP.BEND, F(R), R - R * Math.cos(th), 0, R * Math.sin(th));  // a point on the bent axis
    expect(o[0]).toBeCloseTo(0, 12); expect(o[2]).toBeCloseTo(R * th, 12);
    warpPoint(o, WARP.TAPER, F(0, 1, 10, 0.5), 2, 2, 10);
    expect(o).toEqual([4, 4, 10]);
  });
  test("sanitize maps NaN and infinities to ±BIG", () => {
    expect(sanitize(NaN)).toBe(1e6);
    expect(sanitize(-Infinity)).toBe(-1e6);
    expect(sanitize(3)).toBe(3);
  });
});
