// The native core's contract (src/framework/core/core.js): turning it on changes
// NOTHING but speed. Every reference part that builds on Manifold without assets,
// plus inline forms that reach each of blend-surfaces.js's six descriptor kinds,
// is built and measured with the core off and on — meshes must be byte-identical
// (positions, normals, feature edges, feature ids) and measure() — the full,
// non-quick inspect lap: min-wall and gaps — must deep-equal.
//
// When this fails, the C++ in native/ and its JS twin have drifted. Fix the port
// (and rebuild: node scripts/build-core-wasm.mjs); never loosen this to a tolerance.
import { afterAll, expect, test } from "vitest";
import { bootManifoldKernel, buildView, measure, setCoreEnabled } from "../src/testing.js";
import { core } from "../src/framework/core/core.js";

afterAll(() => setCoreEnabled(true));

const one = (build) => ({
  meta: { title: "core parity", units: "mm" }, parameters: [], defaults: {},
  parts: { body: { label: "Body", views: ["main"], build } }, views: { main: { label: "Main" } },
});
// Descriptor kinds each reaches (blend-surfaces.js): the reference parts cover
// line and path (filleted-box); these add the rest.
const INLINE = {
  "box-corners [line, point]": one((k) => k.box({ min: [0, 0, 0], max: [30, 24, 16] }).fillet(3)),
  "cylinder-rim [path]": one((k) => k.cylinder({ d: 24, h: 18 }).fillet(2.5)),
  "boss-on-tube [spine]": one((k) => k.cylinder({ r: 10, h: 60, center: true }).rotate(90, [0, 0, 0], [0, 1, 0])
    .union(k.cylinder({ r: 4, h: 16 })).fillet({ r: 1.5, edges: { near: [4, 0, 10] } })),
  "rim-outline [line, circle]": one((k) => k.extrude({ profile: [[0, 0], [40, 0], [40, 12], [14, 12], [14, 30], [0, 30]], h: 10 })
    .fillet({ r: 2, edges: { inPlane: "XY", at: 10 } })),
  // Not a prism (a box is, and takes roundAll's fast path, which registers no planes).
  "round-all step [planes]": one((k) => k.box({ min: [0, 0, 0], max: [30, 20, 12] })
    .union(k.box({ min: [6, 4, 12], max: [20, 16, 20] })).roundAll(2)),
};
const REFERENCE = ["bracket", "demo", "faceted-vase", "filleted-box", "gasket", "hinged-box", "hull-sweep",
  "laser-box", "lattice-box", "lofted-bottle", "planter", "propeller", "screw"];

const bytes = (a) => (a ? Buffer.from(a.buffer, a.byteOffset, a.byteLength) : null);

async function run(part, on) {
  setCoreEnabled(on);
  const view = Object.keys(part.views)[0];
  const kernel = await bootManifoldKernel();
  const built = buildView(kernel, part, view);
  const meshes = built.map(({ name, mesh }) => ({
    name, triangles: mesh.triangles, features: mesh.features ?? null,
    positions: bytes(mesh.positions), normals: bytes(mesh.normals), edges: bytes(mesh.edges), featureIds: bytes(mesh.featureIds),
  }));
  kernel.cleanup?.();
  const measured = measure(kernel, part, view, {}, { minWall: true, gaps: true });
  return { meshes, measured };
}

test("the core is available in this environment", () => {
  setCoreEnabled(true);
  expect(core()).not.toBeNull();
});

const cases = [
  ...REFERENCE.map((name) => [name, () => import(`../src/parts/${name}.js`).then((m) => m.default)]),
  ...Object.entries(INLINE).map(([name, part]) => [name, () => part]),
];
for (const [name, load] of cases) {
  test(`core on == core off: ${name}`, async () => {
    const part = await load();
    const off = await run(part, false);
    const on = await run(part, true);
    expect(on.meshes.length).toBe(off.meshes.length);
    on.meshes.forEach((m, i) => {
      const o = off.meshes[i];
      expect(m.name).toBe(o.name);
      expect(m.triangles).toBe(o.triangles);
      expect(m.features).toEqual(o.features);
      for (const k of ["positions", "normals", "edges", "featureIds"]) {
        expect(m[k] === null ? null : Buffer.compare(m[k], o[k]), `${m.name}.${k}`).toBe(o[k] === null ? null : 0);
      }
    });
    expect(on.measured).toEqual(off.measured);
  }, 120_000);
}
