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
  // The lines run along the seam itself: segments with both ends on the sphere (within the
  // 1 mm preview grid's chord error) and on the box's surface (x, y in ±5, z in [−12, −2]).
  const boxDist = (x, y, z) => {
    const q = [Math.abs(x) - 5, Math.abs(y) - 5, Math.abs(z + 7) - 5];
    const out = Math.hypot(...q.map((v) => Math.max(v, 0)));
    return out > 0 ? out : -Math.max(...q);
  };
  const onSeam = (e, o) => Math.abs(Math.hypot(e[o], e[o + 1], e[o + 2]) - 8) < 0.5 && Math.abs(boxDist(e[o], e[o + 1], e[o + 2])) < 0.05;
  const E = mesh.edges;
  let seam = 0, seamLength = 0;
  for (let o = 0; o < E.length; o += 6) {
    if (!onSeam(E, o) || !onSeam(E, o + 3)) continue;
    seam++; seamLength += Math.hypot(E[o + 3] - E[o], E[o + 4] - E[o + 1], E[o + 5] - E[o + 2]);
  }
  // The seam: on each side face (x or y = ±5) the circle of radius √39 the sphere cuts,
  // over |y| ≤ 5 — the box's top lies inside the sphere. Its lines trace most of it.
  const R = Math.sqrt(39), seamTotal = 4 * 2 * Math.asin(5 / R) * R;
  expect(seam).toBeGreaterThanOrEqual(20);
  expect(seamLength).toBeGreaterThan(0.75 * seamTotal);
});
