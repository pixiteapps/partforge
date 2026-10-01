// The contact sheet's laser-cut views (materials.html). "Laser-cut, unburnt" is the twin
// scripts/capture-contact-sheet.mjs diffs against, so its promise is pinned: the same
// swatches, in the same places, with the same geometry — only the burn differs.
import { beforeAll, expect, test } from "vitest";
import part from "../../src/parts/material-swatches.js";
import { bootManifoldKernel } from "../../src/testing.js";
import { buildPosed } from "../../src/framework/part-model.js";
import { burnsFor, sheetFrameFor } from "../../src/framework/materials/sheet-look.js";
import { isSheetPart } from "../../src/framework/sheet/constants.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const inView = (view) => Object.entries(part.parts).filter(([, sp]) => sp.views.includes(view));
const keysIn = (view) => inView(view).map(([n]) => n.slice(n.indexOf("_") + 1));
const BURNING = ["plywood_3", "plywood_6", "plywood_9", "oak_3", "oak_6", "oak_9", "walnut_3", "walnut_6", "walnut_9", "oak_standing", "stock_plywood", "stock_stained"];

test("the Laser-cut view and its unburnt twin hold the same swatches", () => {
  expect(keysIn("laser").length).toBeGreaterThan(0);
  expect(keysIn("unburnt")).toEqual(keysIn("laser"));
});

test("in the Laser-cut view exactly the wood sheets burn; no twin burns", () => {
  expect(inView("laser").filter(([, sp]) => burnsFor(sp)).map(([n]) => n.slice("laser_".length)).sort()).toEqual([...BURNING].sort());
  for (const [n, sp] of inView("unburnt")) {
    expect(burnsFor(sp), n).toBe(false);
    if (isSheetPart(sp)) expect(sp.sheet.place, n).toBeTypeOf("function");
  }
});

test("the standing swatch's frame is not the identity; a flat swatch's is", () => {
  expect(sheetFrameFor(part.parts.laser_oak_standing, { p: {}, d: {} }).frame).not.toEqual(IDENTITY);
  expect(sheetFrameFor(part.parts.laser_oak_3, { p: {}, d: {} }).frame).toEqual(IDENTITY);
});

test("each twin builds the same solid in the same place", () => {
  for (const key of keysIn("laser")) {
    const at = (name) => buildPosed(k, part, name, { purpose: "display", view: name.startsWith("laser") ? "laser" : "unburnt", p: {}, d: {} });
    const a = at(`laser_${key}`), b = at(`unburnt_${key}`);
    expect(b.volume(), key).toBeCloseTo(a.volume(), 6);
    const [ba, bb] = [a.boundingBox(), b.boundingBox()];
    expect(bb.min, key).toEqual(ba.min);
    expect(bb.max, key).toEqual(ba.max);
  }
});
