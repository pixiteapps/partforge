// The native core's contract (src/framework/core/core.js): turning it on changes
// NOTHING but speed. Every reference part that builds on Manifold without assets,
// plus inline forms that reach each of blend-surfaces.js's six descriptor kinds,
// is built and measured with the core off and on — meshes must be byte-identical
// (positions, normals, feature edges, feature ids) and measure() — the full,
// non-quick inspect lap: min-wall and gaps — must deep-equal.
//
// When this fails, the C++ in native/ and its JS twin have drifted. Fix the port
// (and rebuild: node scripts/build-core-wasm.mjs); never loosen this to a tolerance.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { bootManifoldKernel, buildView, measure, setCoreEnabled } from "../src/testing.js";
import { core, coreStatus, setCoreForTesting } from "../src/framework/core/core.js";
import { handSpec, nailSpecs, vaseSpec, ADVERSARIAL } from "./fixtures/implicit-trees.js";
import { TREES } from "./fixtures/implicit-small-trees.js";
import { creasedNormals } from "../src/framework/geometry/creased-normals.js";
import { ORGANIC } from "../src/framework/geometry/shading-policy.js";
import { compileImplicit, meshImplicit } from "../src/framework/geometry/implicit/index.js";
import { SEAM_CASES, GATE_EXTRA_CASES, MOVED_CASES } from "./fixtures/implicit-seam-cases.js";
import { creaseInAttachment } from "./helpers/seam-quality.js";

afterAll(() => { setCoreEnabled(true); delete globalThis.PARTFORGE_CORE_SIMD; setCoreForTesting(undefined); });

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
// k.implicit runs its whole engine on the core (core/implicit-core.js); each image
// a spec reads is registered on the kernel before the build. The kernel is a preview
// one (cleanup decimates) unless `quality` says "print" (it does not).
const implicitPart = (specs, images = new Map(), quality = "preview") => ({
  ...one((k) => (specs.length === 1 ? k.implicit(specs[0]) : k.union(specs.map((sp) => k.implicit(sp))))),
  testImages: images, testQuality: quality,
});
const vase = vaseSpec();
const IMPLICIT = {
  "implicit hand with nails": implicitPart([handSpec(), ...nailSpecs()]),
  "implicit vase": implicitPart([vase.spec], vase.images),
  "implicit bendCut": implicitPart([{ ...TREES.bendCut, preview: 0.8 }]),
  "implicit formula": implicitPart([{ ...TREES.formula, preview: 0.8 }]),
  "implicit coincident faces": implicitPart([ADVERSARIAL.coincidentFaces]),
  "implicit mirrored half box": implicitPart([{ root: { kind: "mirror", plane: "yz", child: { kind: "box", size: [10, 10, 10], at: [5, 0, 0] } }, preview: 0.5 }]),
  "implicit touching repeat": implicitPart([{ root: { kind: "repeat", linear: { count: 3, step: [4, 0, 0] }, child: { kind: "box", size: [4, 4, 4] } }, preview: 0.5 }]),
  "implicit hand, print tier": implicitPart([{ ...handSpec(), resolution: 1.2 }], new Map(), "print"),
  "implicit vase, print tier": implicitPart([{ ...vase.spec, resolution: 1.2 }], vase.images, "print"),
  "implicit flush pocket": implicitPart([{ root: { kind: "subtract", children: [{ kind: "box", size: [10, 10, 10] }, { kind: "box", size: [4, 4, 10], at: [0, 0, 5] }] }, preview: 0.5 }]),
  // The contact node's CONTACT and BULGE ops: every contact tree.
  ...Object.fromEntries(Object.keys(TREES).filter((k) => k.startsWith("contact"))
    .map((k) => [`implicit ${k}`, implicitPart([{ ...TREES[k], preview: 0.8 }])])),
};
const REFERENCE = ["bracket", "demo", "faceted-vase", "filleted-box", "gasket", "hinged-box", "hull-sweep",
  "laser-box", "lattice-box", "lofted-bottle", "planter", "propeller", "screw"];

const bytes = (a) => (a ? Buffer.from(a.buffer, a.byteOffset, a.byteLength) : null);

async function run(part, on) {
  setCoreEnabled(on);
  const view = Object.keys(part.views)[0];
  const kernel = await bootManifoldKernel({ quality: part.testQuality ?? "preview" });
  for (const [name, im] of part.testImages ?? []) await kernel._registerImage({ name, ...im });
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
  ...Object.entries(IMPLICIT).map(([name, part]) => [name, () => part]),
];
// Both builds of the core (scripts/build-core-wasm.mjs): the SIMD one this engine
// boots by default, and the scalar one an engine without wasm SIMD gets
// (PARTFORGE_CORE_SIMD = false, read when the core boots).
describe.each([["SIMD", true], ["scalar", false]])("%s build", (_, simd) => {
  beforeAll(() => {
    if (simd) delete globalThis.PARTFORGE_CORE_SIMD; else globalThis.PARTFORGE_CORE_SIMD = false;
    setCoreForTesting(undefined);
    setCoreEnabled(true);
    expect(core().simd).toBe(simd);
  });
  for (const [name, load] of cases) {
    test(`core on == core off: ${name}`, async () => {
      const part = await load();
      const off = await run(part, false);
      const refusedBefore = coreStatus().refusedMeshes;
      const on = await run(part, true);
      expect(core().simd, "the build under test ran").toBe(simd);
      // The implicit cases must really have run on the core: nothing refused or faulted.
      if (part.testImages) expect(coreStatus()).toEqual({ state: "on", reason: null, refusedMeshes: refusedBefore });
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
});

// Sibling seams (`group` in shading-policy.js): a strip of ID-run triangles bent by 2°, 4°, 8°
// and 40° at successive seams, with grouped, ungrouped and mixed-group policies, shades alike
// on the core and in JS.
describe("creased normals: sibling groups", () => {
  const strip = (bends) => {
    const V = [], T = [], ri = [0], roid = [];
    let a = [0, 0, 0], b = [0, 1, 0], ang = 0, x = 0;
    V.push(...a, ...b);
    bends.forEach((bend, i) => {
      ang += (bend * Math.PI) / 180; x += Math.cos(ang);
      const z0 = V[V.length - 4] ?? 0;
      V.push(x, 0, z0 + Math.sin(ang), x, 1, z0 + Math.sin(ang));
      const n = V.length / 3;
      T.push(n - 4, n - 2, n - 3, n - 3, n - 2, n - 1);
      ri.push(T.length); roid.push(10 + i);
    });
    return { numProp: 3, vertProperties: Float32Array.from(V), triVerts: Uint32Array.from(T), mergeFromVert: new Uint32Array(0), mergeToVert: new Uint32Array(0), runIndex: Uint32Array.from(ri), runOriginalID: Uint32Array.from(roid) };
  };
  const ids = [10, 11, 12, 13, 14];
  const POLICIES = {
    grouped: new Map(ids.map((id) => [id, { ...ORGANIC, group: 10 }])),
    mixed: new Map(ids.map((id) => [id, { ...ORGANIC, group: id < 12 ? 10 : 20 }])),
    ungrouped: new Map(ids.map((id) => [id, ORGANIC])),
  };
  for (const [name, policies] of Object.entries(POLICIES)) {
    test(`core on == core off: ${name}`, () => {
      const g = strip([0, 2, 4, 8, 40]);
      const out = [];
      for (const on of [false, true]) { setCoreEnabled(on); out.push(creasedNormals(g, { policies })); }
      setCoreEnabled(true);
      expect(Buffer.compare(bytes(out[0].normals), bytes(out[1].normals))).toBe(0);
      expect(Buffer.compare(bytes(out[0].edges), bytes(out[1].edges))).toBe(0);
      expect(out[0].edges.length).toBe(0);
    });
  }
  test("the strip really shades differently by group", () => {
    setCoreEnabled(true);
    const g = strip([0, 2, 4, 8, 40]);
    const a = creasedNormals(g, { policies: POLICIES.grouped }), b = creasedNormals(g, { policies: POLICIES.ungrouped });
    expect(Buffer.compare(bytes(a.normals), bytes(b.normals))).not.toBe(0);
  });
});

// The owner path (a root exact contact: core/implicit-core.js's owner mesher, owner cleanup,
// crease cut, untangle and the detail's seam fade): every seam fixture, the gate's extra cases
// (palm-last hands, fingers on a palm) and the moved-root cases, at the preview grid and the
// print grid, core on (both builds) against core off — positions, indices, normals and every
// owner field byte for byte, and the core must really have answered (nothing refused). A
// moved-root case also cuts no crease inside an attachment (its anchors live in a non-world
// frame, and both engines must test the world positions against world anchors).
describe("owner path: every seam fixture", () => {
  const OWNER_FIELDS = ["positions", "indices", "normals", "vertOwner", "ownerHeld", "pinned", "crease", "triOwner"];
  const moved = new Set(MOVED_CASES.map((c) => c.name));
  for (const { name, spec } of [...SEAM_CASES, ...GATE_EXTRA_CASES, ...MOVED_CASES]) {
    for (const [edge, tier] of [[1.5, "preview"], [0.6, "print"]]) {
      test(`core on == core off: ${name} at ${edge} mm`, () => {
        const compiled = compileImplicit(spec, { exactContact: true });
        setCoreEnabled(false);
        const off = meshImplicit(compiled, edge, { tier });
        expect(off.indices.length).toBeGreaterThan(0);
        if (moved.has(name)) expect(creaseInAttachment(compiled, off, edge)).toMatchObject({ attachedOnly: 0, unmade: 0 });
        for (const simd of [true, false]) {
          if (simd) delete globalThis.PARTFORGE_CORE_SIMD; else globalThis.PARTFORGE_CORE_SIMD = false;
          setCoreForTesting(undefined);
          setCoreEnabled(true);
          // A stand-in that counts the owner path's last native stage: meshImplicit really ran it.
          const real = core();
          let untangled = 0;
          const standIn = { ...real, x: { ...real.x, ip_untangle: (...a) => { untangled++; return real.x.ip_untangle(...a); } } };
          setCoreForTesting(standIn);
          const on = meshImplicit(compiled, edge, { tier });
          expect(real.simd, "the build under test ran").toBe(simd);
          // (A print-grid hand grows the instance past RECYCLE_BYTES, so it is dropped once idle: "idle", not "on".)
          expect(standIn.poisoned, "the core did not fault").toBeFalsy();
          expect(coreStatus(), "the core answered").toMatchObject({ reason: null, refusedMeshes: 0 });
          expect(untangled, "the owner path ran on the core").toBe(1);
          for (const k of OWNER_FIELDS) {
            expect(on[k]?.constructor, `${k} (${simd ? "SIMD" : "scalar"})`).toBe(off[k].constructor);
            expect(Buffer.compare(bytes(on[k]), bytes(off[k])), `${k} (${simd ? "SIMD" : "scalar"})`).toBe(0);
          }
          expect(on.warnings).toEqual(off.warnings);
          expect(on.stats).toEqual(off.stats);
        }
        delete globalThis.PARTFORGE_CORE_SIMD;
        setCoreForTesting(undefined);
        setCoreEnabled(true);
      }, 240_000);
    }
  }
});
