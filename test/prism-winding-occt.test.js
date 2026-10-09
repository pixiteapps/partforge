// The OCCT half of prism-winding-manifold.test.js: the exact kernel's prism was
// always winding-agnostic, and the mesh kernel now matches it. OCCT and
// Manifold must not boot in the same process, hence the separate file.
import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 60_000);

test("a clockwise prism outline builds the same solid as the counter-clockwise one", () => {
  const ccw = [[0, 0], [10, 0], [0, 10]];
  expect(k.prism({ points: [...ccw].reverse(), h: 10 }).volume()).toBeCloseTo(500, 4);
  expect(k.prism({ points: ccw, h: 10 }).volume()).toBeCloseTo(500, 4);
});
