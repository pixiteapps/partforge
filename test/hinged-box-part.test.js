// The animation reference part: builds clean, poses are rigid and
// view-independent, and the animations block round-trips the timeline model.
import { beforeAll, expect, test } from "vitest";
import part from "../src/parts/hinged-box.js";
import { bootManifoldKernel, measure } from "../src/testing.js";
import { viewAnimations, evaluate } from "../src/framework/animation.js";

let kernel;
beforeAll(async () => { kernel = await bootManifoldKernel(); });

test("builds and measures clean at defaults", () => {
  const r = measure(kernel, part, "box");
  expect(r.ok).toBe(true);
  expect(r.subparts.map((s) => s.name).sort()).toEqual(["base", "lid"]);
  expect(r.overlaps).toEqual([]);
});

test("lidAngle/lidLift are pose-only: same volume at any pose", () => {
  const closed = measure(kernel, part, "box");
  const open = measure(kernel, part, "box", { lidAngle: 90, lidLift: 20 }); // params is the 4th positional
  const vol = (r, n) => r.subparts.find((s) => s.name === n).volume;
  expect(vol(open, "lid")).toBeCloseTo(vol(closed, "lid"), 3);
  expect(vol(open, "base")).toBeCloseTo(vol(closed, "base"), 3);
});

test("animations are view-owned: box view carries all three", () => {
  const byView = viewAnimations(part);
  expect([...byView.keys()]).toEqual(["box"]);
  const [open, cycle, assemble] = byView.get("box");
  expect(open.cues).toMatchObject([{ t: 0, view: "front" }]);
  expect(cycle.loop).toBe(true);
  expect(assemble.steps.map((s) => s.label)).toEqual(
    ["Lid appears", "Lower the lid", "Open to check clearance"]);
  expect(evaluate(open, 1).values.lidAngle).toBe(110);
});

test("assemble fades the lid in, then moves it", () => {
  const assemble = viewAnimations(part).get("box").find((a) => a.name === "assemble");
  expect(assemble.opacityKeys).toEqual(["lid"]);
  expect(evaluate(assemble, 0).opacity.lid).toBe(0);        // absent at the start
  expect(evaluate(assemble, 1 / 3).opacity.lid).toBe(1);    // fully in when motion starts
  expect(evaluate(assemble, 1).opacity.lid).toBe(1);        // holds through later steps
});
