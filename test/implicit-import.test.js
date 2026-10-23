// k.implicit meshes enter Manifold already carrying one reserved original ID — no
// separate asOriginal() pass (~48 ms CPU on a 177k-triangle hand).
import { expect, test, vi } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";

const ball = { root: { kind: "sphere", r: 10 }, preview: 1 };

test("the implicit op never calls asOriginal and the solid carries one original id", async () => {
  const wasm = await Module();
  wasm.setup();
  const k = createManifoldKernel(wasm, { quality: "preview" });
  const spy = vi.spyOn(wasm.Manifold.prototype, "asOriginal");
  const reserve = vi.spyOn(wasm.Manifold, "reserveIDs");
  const s = k.implicit(ball);
  expect(spy).not.toHaveBeenCalled();
  expect(reserve).toHaveBeenCalledTimes(1);
  const reserved = reserve.mock.results[0].value;
  const m = s._m;
  // (originalID() reads -1 for an imported run mesh; the run table is what shading reads.)
  const g = m.getMesh();
  expect([...g.runOriginalID]).toEqual([reserved]);
  spy.mockRestore(); reserve.mockRestore();
});
