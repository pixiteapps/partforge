import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";
import { pathProfile, ringSectorProfile, slotProfile, pieProfile, roundedRectProfile } from "../src/framework/geometry/polygon.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); });

const KAPPA = 0.5522847498307936;
// A full circle radius R as four cubic quarter-arcs (the standard 4-Bézier circle).
const circleCubic = (R) => {
  const k4 = R * KAPPA;
  return pathProfile([R, 0])
    .cubicTo([0, R], [R, k4], [k4, R])
    .cubicTo([-R, 0], [-k4, R], [-R, k4])
    .cubicTo([0, -R], [-R, -k4], [-k4, -R])
    .cubicTo([R, 0], [k4, -R], [R, -k4])
    .close();
};

test("extruding a cubic circle gives ~π R² h with an exact B-rep (watertight)", () => {
  const R = 10, h = 5;
  const solid = k.extrude({ profile: circleCubic(R), h });
  expect(solid.volume()).toBeCloseTo(Math.PI * R * R * h, -1); // ~1571; OCCT exact
});

test("a cubic edge exports to STEP as a spline (B_SPLINE)", async () => {
  const solid = k.extrude({ profile: circleCubic(10), h: 5 });
  const step = new TextDecoder().decode(await k.toSTEP([{ name: "p", solid }]));
  expect(step).toMatch(/B_SPLINE/);
});

// The *Profile curve helpers reach OCCT as true arcs: exact volume, CIRCLE edges in STEP.
test("a ringSectorProfile prism is exact and exports CIRCLE edges", async () => {
  const exact = 0.5 * (30 ** 2 - 28 ** 2) * ((36 * Math.PI) / 180) * 2;
  const lug = k.prism({ points: ringSectorProfile(28, 30, 36), h: 2 });
  expect(Math.abs(lug.volume() - exact) / exact).toBeLessThan(1e-6);
  const step = new TextDecoder().decode(await k.toSTEP([{ name: "lug", solid: lug }]));
  expect(step).toMatch(/CIRCLE/);
});

test("slotProfile, pieProfile and roundedRectProfile build exact solids", () => {
  expect(k.prism({ points: slotProfile(20, 4), h: 1 }).volume()).toBeCloseTo(20 * 8 + Math.PI * 16, 4);
  expect(k.prism({ points: pieProfile(25, 120), h: 1 }).volume()).toBeCloseTo(0.5 * 625 * ((120 * Math.PI) / 180), 4);
  expect(k.prism({ points: roundedRectProfile(40, 20, 4), h: 1 }).volume()).toBeCloseTo(800 - (4 - Math.PI) * 16, 4);
});

test("revolve takes a path contour directly on OCCT too", () => {
  const lathe = pathProfile([0, 0]).lineTo([10, 0]).lineTo([10, 8]).arcTo([8, 10], { r: 2 }).lineTo([0, 10]).close();
  const direct = k.revolve({ profile: lathe });
  const lifted = k.revolve({ profile: k.shape2d(lathe) });
  expect(direct.volume()).toBeCloseTo(lifted.volume(), 6);
});
