import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { routedPart } from "../src/framework/sheet/routed.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const RECT = [[0, 0], [100, 0], [100, 60], [0, 60]];
const build = (over) => routedPart({ views: ["main"], label: "Plinth", material: "walnut", thickness: 18,
  profile: (kk) => kk.shape2d(RECT), ...over }).build(k, {}, {});

test("the bare profile extrudes to the thickness", () => {
  const s = build({});
  expect(s.volume()).toBeCloseTo(100 * 60 * 18, 3);
  const bb = s.boundingBox();
  expect(bb.min[2]).toBeCloseTo(0, 6); expect(bb.max[2]).toBeCloseTo(18, 6);
});

test("a pocket removes region × depth from the top face", () => {
  const s = build({ pockets: () => [{ region: [[10, 10], [40, 10], [40, 30], [10, 30]], depth: 5 }] });
  expect(s.volume()).toBeCloseTo(100 * 60 * 18 - 30 * 20 * 5, 2);
  expect(s.boundingBox().max[2]).toBeCloseTo(18, 6);   // the pocket is open at the top, the top face remains elsewhere
});

test("a blind drill removes a cylinder from the top; a through drill removes the full thickness", () => {
  // The kernel's cylinder is a faceted polygon (segment count from its own resolution),
  // so it removes slightly LESS than the exact π r² h — ~0.05%, about 0.7 mm³ for the
  // through hole. 2 mm³ allows that and still tells 9 mm from 18 mm deep (≈353 mm³ apart).
  const blind = build({ drills: () => [{ at: [50, 30], d: 10, depth: 9 }] });
  expect(Math.abs(blind.volume() - (100 * 60 * 18 - Math.PI * 25 * 9))).toBeLessThan(2);
  const through = build({ drills: () => [{ at: [50, 30], d: 10, depth: 18 }] });
  expect(Math.abs(through.volume() - (100 * 60 * 18 - Math.PI * 25 * 18))).toBeLessThan(2);
  expect(through.boundingBox().min[2]).toBeCloseTo(0, 6);   // the overcut tool leaves no sliver below the bottom face
});

test("an extra solid is subtracted as given", () => {
  const s = build({ extra: (kk) => [{ solid: kk.box({ size: [10, 10, 10] }).translate([65, 25, 13]), footprint: [[60, 20], [70, 20], [70, 30], [60, 30]], label: "notch", method: "chisel" }] });
  // the box spans z 13..23: 5 mm of it lies inside the 18 mm stock
  expect(s.volume()).toBeCloseTo(100 * 60 * 18 - 10 * 10 * 5, 2);
});

test("reference lines groove the face like a score", () => {
  const s = build({ reference: () => [[[0, 30], [100, 30]]] });
  expect(s.volume()).toBeLessThan(100 * 60 * 18);
  expect(s.volume()).toBeGreaterThan(100 * 60 * 18 - 100 * 0.3 * 0.2 - 1);
});

test("a through pocket (depth = thickness) removes region × thickness and leaves no skin at the bottom", () => {
  const s = build({ pockets: () => [{ region: [[10, 10], [40, 10], [40, 30], [10, 30]], depth: 18 }] });
  expect(s.volume()).toBeCloseTo(100 * 60 * 18 - 30 * 20 * 18, 2);
  expect(s.boundingBox().min[2]).toBeCloseTo(0, 6);
});

test("a far pocket removes region × depth from the BOTTOM face (z = 0)", () => {
  const s = build({ pockets: () => [{ region: [[10, 10], [40, 10], [40, 30], [10, 30]], depth: 5, face: "far" }] });
  expect(s.volume()).toBeCloseTo(100 * 60 * 18 - 30 * 20 * 5, 2);
  expect(s.boundingBox().min[2]).toBeCloseTo(0, 6);
  // nothing removed above z = 5 inside the pocket: a probe box there is fully solid
  // (k.box is centred in x/y and sits on z = 0, so the pocket's centre is [25, 20])
  expect(s.intersect(k.box({ size: [30, 20, 13] }).translate([25, 20, 5])).volume()).toBeCloseTo(30 * 20 * 13, 2);
});

test("a far blind drill cuts up from z = 0; a far through drill clears both faces", () => {
  const blind = build({ drills: () => [{ at: [50, 30], d: 10, depth: 9, face: "far" }] });
  expect(Math.abs(blind.volume() - (100 * 60 * 18 - Math.PI * 25 * 9))).toBeLessThan(2);
  expect(blind.intersect(k.cylinder({ d: 10, h: 9 }).translate([50, 30, 9])).volume()).toBeGreaterThan(600); // the top 9 mm are solid
  const thru = build({ drills: () => [{ at: [50, 30], d: 10, depth: 18, face: "far" }] });
  expect(Math.abs(thru.volume() - (100 * 60 * 18 - Math.PI * 25 * 18))).toBeLessThan(2);
});
