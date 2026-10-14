// Its own file: OCCT and Manifold never boot in one process.
import { test, expect, beforeAll } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 120_000);

test("OCCT refuses k.implicit with a clear message (tessellated STEP lands in PR 4)", () => {
  expect(() => k.implicit({ root: { kind: "sphere", r: 1 } })).toThrow(/implicit: builds on the Manifold backend/);
});
