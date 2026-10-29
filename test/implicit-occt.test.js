// Its own file: OCCT and Manifold never boot in one process.
import { test, expect, beforeAll } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";
import { implicitFrames } from "../src/framework/geometry/implicit/frame-report.js";
import { handSpec } from "./fixtures/implicit-trees.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 120_000);

test("OCCT refuses k.implicit with a clear message (tessellated STEP lands in PR 4)", () => {
  expect(() => k.implicit({ root: { kind: "sphere", r: 1 } })).toThrow(/implicit: builds on the Manifold backend/);
});

test("implicitFrames runs on OCCT", () => {
  expect(k.implicitFrames(handSpec()).rotateY(180).report()).toEqual(implicitFrames(handSpec()).rotateY(180).report());
});
