import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing.js";

// OCCT and Manifold must not boot in the same process — hence this separate file.
//
// A point list that repeats a point (an outline whose chamfer is 0 lists its corner
// twice) builds a zero-length edge. Manifold ignores it; OCCT used to throw
// StdFail_NotDone, so the part previewed and then failed its STEP download. The
// volumes below are the ones Manifold gives for the same inputs.
let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 60000);

const SQUARE = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
const REPEATED = [[-1, -1], [1, -1], [1, 1], [1, 1], [-1, 1]];

test("a loft whose rings all repeat a point builds", () => {
  const solid = k.loft({ rings: [{ polygon: REPEATED, z: 0 }, { polygon: REPEATED, z: 5 }] });
  expect(solid.volume()).toBeCloseTo(20, 6);
});

test("a loft where only one ring repeats a point builds", () => {
  const split = [[-1, -1], [1, -1], [1, 1], [0.5, 1], [-1, 1]];
  const solid = k.loft({ rings: [{ polygon: REPEATED, z: 0 }, { polygon: split, z: 5 }] });
  expect(solid.volume()).toBeCloseTo(20, 6);
});

test("prism, extrude and revolve take a repeated point", () => {
  expect(k.prism({ points: REPEATED, h: 5 }).volume()).toBeCloseTo(20, 6);
  expect(k.extrude({ profile: REPEATED, h: 5 }).volume()).toBeCloseTo(20, 6);
  const turned = k.revolve({ profile: [[0, 0], [2, 0], [2, 0], [2, 3], [0, 3]] });
  expect(turned.volume()).toBeCloseTo(Math.PI * 4 * 3, 3);
});

test("a repeated point exports as STEP", async () => {
  const solid = k.loft({ rings: [{ polygon: REPEATED, z: 0 }, { polygon: REPEATED, z: 5 }] });
  const data = await k.toSTEP([{ name: "loft", solid }]);
  expect(data.byteLength ?? data.length).toBeGreaterThan(1000);
});

test("an outline with no repeat is unchanged", () => {
  expect(k.prism({ points: SQUARE, h: 5 }).volume()).toBeCloseTo(20, 6);
});
