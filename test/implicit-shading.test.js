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

// Fingernails are their own fine-grid k.implicit, unioned onto the hand. Both sides
// of that seam are organic skin: no outline traces each nail (the user saw one).
test("seams between two organic surfaces draw no feature lines", async () => {
  const { handSpec, nailSpecs } = await import("./fixtures/implicit-trees.js");
  const k = await bootManifoldKernel();
  const p = part((kk) => kk.union([kk.implicit(handSpec()), ...nailSpecs().map((s) => kk.implicit(s))]));
  const [{ mesh }] = buildView(k, p, "main");
  expect(mesh.triangles).toBeGreaterThan(0);
  expect(mesh.edges?.length ?? 0).toBe(0);
}, 120_000);

test("seams between an organic surface and a mechanical one still draw", async () => {
  const k = await bootManifoldKernel();
  const p = part((kk) => kk.union([
    kk.implicit({ root: { kind: "sphere", r: 8 }, preview: 1 }),
    kk.box({ size: [10, 10, 10] }).translate([0, 0, -12]),
  ]));
  const [{ mesh }] = buildView(k, p, "main");
  expect(mesh.edges?.length ?? 0).toBeGreaterThan(0);
});
