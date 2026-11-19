// Its own file: OCCT and Manifold never boot in one process.
import { test, expect, beforeAll } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";
import { isCage } from "../src/framework/geometry/subdiv/index.js";
import { meshNativeRefusal } from "../src/framework/geometry/kernel.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 120_000);

test("OCCT hands out a real cage and refuses k.subdiv, naming it and saying how a sub-part got there", () => {
  const c = k.cage({ box: { size: [10, 10, 10] } });
  expect(isCage(c)).toBe(true);
  expect(c.centroid("+z:0,0")).toEqual([0, 0, 5]);
  let err;
  try { k.subdiv(c); } catch (e) { err = e; }
  expect(err.message).toMatch(/^subdiv: OCCT cannot build k\.subdiv \(it is mesh-native\) — this part reached OCCT because meta\.backend pins it there/);
  expect(err.message).toMatch(/make the k\.subdiv call unconditional$/);
  expect(err.message).not.toMatch(/implicit/);
  expect(err.code).toBeUndefined();   // uncoded, like k.implicit's: exportPieceError names the piece
});

test("the CLI's reroute knows both OCCT refusals by the shared predicate", () => {
  const thrown = (fn) => { try { fn(); } catch (e) { return e.message; } return null; };
  expect(meshNativeRefusal(thrown(() => k.subdiv(k.cage({ box: { size: [10, 10, 10] } }))))).toBe("subdiv");
  expect(meshNativeRefusal(thrown(() => k.implicit({ root: { kind: "sphere", r: 1 } })))).toBe("implicit");
  expect(meshNativeRefusal("fillet: function selectors need the OCCT backend")).toBeNull();
});
