// The routed preview on OCCT, whose coplanar booleans are fragile: a through pocket's
// tool must clear both faces, as a through drill's does (descriptor.js routedPreview).
import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";
import { routedPart } from "../src/framework/sheet/routed.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); });

const RECT = [[0, 0], [100, 0], [100, 60], [0, 60]];
const build = (over) => routedPart({ views: ["main"], label: "Plinth", material: "walnut", thickness: 18,
  profile: (kk) => kk.shape2d(RECT), ...over }).build(k, {}, {});

test("a through pocket removes region × thickness on OCCT", () => {
  const s = build({ pockets: () => [{ region: [[10, 10], [40, 10], [40, 30], [10, 30]], depth: 18 }] });
  expect(s.volume()).toBeCloseTo(100 * 60 * 18 - 30 * 20 * 18, 1);
  expect(s.boundingBox().min[2]).toBeCloseTo(0, 4);
});
