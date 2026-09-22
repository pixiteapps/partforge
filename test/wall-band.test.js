// test/wall-band.test.js
// The `wall` band metric end to end: min-wall's extra running extreme (Task 4), the
// band resolved from verify.expect (Task 5), the sub-part fact (Task 6), the verify
// check (Task 7). The fixture is partforge-cloud feedback #95's bend: a 2 mm L-wall
// whose outer arc is r=4 about C; concentric when the inner arc is r=2 about C, and
// the shipped bug when it is r=3.5 about C' — 2.62 mm thick at the diagonal.
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { minWall } from "../src/framework/oracle/min-wall.js";
import { circleProfile } from "../src/framework/geometry/polygon.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const C = [6, 12];
// Everything on the wall's side of the OUTER boundary (outer corner rounded r=4 about C).
const outerRegion = (kk) => kk.shape2d([[0, 8], [6, 8], [10, 12], [10, 20], [0, 20]])
  .union(kk.shape2d(circleProfile(4, C, 128)));
// The pocket: inner corner rounded r=2 about C (concentric) …
const pocketConcentric = (kk) => kk.shape2d([[0, 10], [6, 10], [8, 12], [8, 20], [0, 20]])
  .union(kk.shape2d(circleProfile(2, C, 128)));
// … or r=3.5 about C' = (4.5, 13.5), tangent to the same two faces (the bug).
const pocketOffset = (kk) => kk.shape2d([[0, 10], [4.5, 10], [8, 13.5], [8, 20], [0, 20]])
  .union(kk.shape2d(circleProfile(3.5, [4.5, 13.5], 128)));
export const lWall = (kk, concentric) => outerRegion(kk).cut(concentric ? pocketConcentric(kk) : pocketOffset(kk)).extrude({ h: 10 });

test("minWall without a band is unchanged and reports band: null", () => {
  const r = minWall(lWall(k, true).toMesh());
  expect(r.value).toBeCloseTo(2, 1);
  expect(r.band).toBeNull();
});

test("a concentric bend stays inside its band", () => {
  const r = minWall(lWall(k, true).toMesh(), { band: { min: 1.8, max: 2.2 } });
  expect(r.band.members).toBeGreaterThan(0);
  expect(r.band.value).toBeGreaterThanOrEqual(1.8);
  expect(r.band.value).toBeLessThanOrEqual(2.25);
});

test("the offset bend reports its thickest member, located in the bend", () => {
  const r = minWall(lWall(k, false).toMesh(), { band: { min: 1.8, max: 2.2 } });
  expect(r.band.value).toBeGreaterThan(2.4);
  expect(r.band.value).toBeLessThan(2.8);
  const [x, y] = r.band.location;
  expect(x).toBeGreaterThan(5.5); expect(x).toBeLessThan(10.5);
  expect(y).toBeGreaterThan(7.5); expect(y).toBeLessThan(12.5);
});

test("samples outside the membership window are not members", () => {
  // A 10×20×5 block: every ray reads 5, 10 or 20 — none within [1.35, 3.3].
  const r = minWall(k.box({ min: [0, 0, 0], max: [10, 20, 5] }).toMesh(), { band: { min: 1.8, max: 2.2 } });
  expect(r.band).toEqual({ value: null, location: null, members: 0 });
});

test("a 1.2 mm floor under a 2 mm wall is ignored by the band", () => {
  const floor = k.box({ min: [0, 0, 0], max: [10, 20, 1.2] });
  const solid = lWall(k, true).translate([0, 0, 1.2]).union(floor);
  const r = minWall(solid.toMesh(), { band: { min: 1.8, max: 2.2 } });
  expect(r.value).toBeCloseTo(1.2, 1);                  // min wall still sees the floor
  expect(r.band.value).toBeGreaterThanOrEqual(1.8);     // the band does not
  expect(r.band.value).toBeLessThanOrEqual(2.25);
});
