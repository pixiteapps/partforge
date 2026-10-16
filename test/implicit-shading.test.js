// k.implicit surfaces shade ORGANIC: one smooth skin, so detail grooves (creases,
// texture relief) draw no feature lines in the CAD overlay and shade smoothly.
import { expect, test } from "vitest";
import { bootManifoldKernel, buildView } from "../src/testing.js";

const part = (build) => ({
  meta: { title: "implicit shading", units: "mm" }, parameters: [], defaults: {},
  parts: { body: { label: "Body", views: ["main"], build } }, views: { main: { label: "Main" } },
});

test("creased implicit skin draws no same-surface feature lines", async () => {
  const k = await bootManifoldKernel();
  const p = part((kk) => kk.implicit({
    root: { kind: "box", size: [30, 30, 10], round: 3 },
    detail: [{ kind: "creases", amplitude: 0.5, wavelength: 1.5, axis: "x", side: [0, 0, 1] }],
    preview: 1,
  }));
  const [{ mesh }] = buildView(k, p, "main");
  expect(mesh.triangles).toBeGreaterThan(0);
  expect(mesh.edges?.length ?? 0).toBe(0);
});
