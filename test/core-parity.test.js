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
  // A creased subdivision body (shading-policy.js `skin`): a closed crease, an open run
  // (faces split out as parts of their own), and a cut across both.
  "creased cage [skin parts]": one((k) => {
    const c = k.cage({ box: { size: [30, 20, 16], segs: [3, 2, 1] } });
    c.crease("-z:0,0");
    c.crease(["+z:0,0", "+z:1,0"], ["+z:0,1", "+z:1,1"]);
    return k.subdiv(c).cut(k.cylinder({ d: 6, h: 40, center: true }));
  }),
};
// k.implicit runs its whole engine on the core (core/implicit-core.js); each image
// a spec reads is registered on the kernel before the build. The kernel is a preview
// one (cleanup decimates) unless `quality` says "print" (it does not).
const implicitPart = (specs, images = new Map(), quality = "preview") => ({
  ...one((k) => (specs.length === 1 ? k.implicit(specs[0]) : k.union(specs.map((sp) => k.implicit(sp))))),
  testImages: images, testQuality: quality,
});
// A spec with `solid` leaves (the MESH op) needs the kernel's own solids, so it is made inside
// the build from `k`.
const solidPart = (makeSpec, quality = "preview") => ({ ...one((k) => k.implicit(makeSpec(k))), testImages: new Map(), testQuality: quality });
const solidLeaf = (solid) => ({ kind: "solid", solid });
// The plate and boss join (a blended union of two solids) and the blob shrink (offset −2 over
// one solid), at edge 0.6: `preview` sets the preview tier's edge, `resolution` the print tier's.
const solidJoin = (k, edge) => ({ root: { kind: "union", k: 8, children: [
  solidLeaf(k.box({ min: [-30, -20, 0], max: [30, 20, 6] })), solidLeaf(k.cylinder({ r: 8, h: 26 }).at([0, 0, 4])),
] }, ...edge });
const solidShrink = (k, edge) => ({ root: { kind: "offset", d: -2, child: solidLeaf(k.sphere(16)
  .union(k.box({ min: [-8, -8, -22], max: [8, 8, 0] })).union(k.cylinder({ r: 6, h: 44 }).rotateY(90).at([-22, 0, 4]))) }, ...edge });
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
  // A tapered capsule whose larger end swallows the other, and a tube segment with coincident
  // endpoints: both lower to the larger end's sphere.
  "implicit swallowed taper": implicitPart([{ root: { kind: "union", children: [
    { kind: "capsule", a: [0, 0, 0], b: [0, 0, 1], r: [4, 1] },
    { kind: "tube", points: [[10, 0, 0], [10, 0, 0], [10, 0, 8]], r: [3, 1, 1] },
  ] }, preview: 0.8 }]),
  "implicit flush pocket":implicitPart([{ root: { kind: "subtract", children: [{ kind: "box", size: [10, 10, 10] }, { kind: "box", size: [4, 4, 10], at: [0, 0, 5] }] }, preview: 0.5 }]),
  // The MESH op (solid leaves): the plate and boss join at both tiers, the blob shrink.
  "implicit solid join": solidPart((k) => solidJoin(k, { preview: 0.6 })),
  "implicit solid join, print tier": solidPart((k) => solidJoin(k, { resolution: 0.6 }), "print"),
  "implicit solid shrink": solidPart((k) => solidShrink(k, { preview: 0.6 })),
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
  const kernel = await bootManifoldKernel({ quality: part.testQuality ?? "preview", meshFields: true });
  for (const [name, im] of part.testImages ?? []) await kernel._registerImage({ name, ...im });
  const built = buildView(kernel, part, view);
  const meshes = built.map(({ name, mesh }) => ({
    name, triangles: mesh.triangles, features: mesh.features ?? null,
    positions: bytes(mesh.positions), normals: bytes(mesh.normals), edges: bytes(mesh.edges), featureIds: bytes(mesh.featureIds),
    bindings: mesh.bindings ? { frames: mesh.bindings.frames, frameA: bytes(mesh.bindings.frameA), frameB: bytes(mesh.bindings.frameB), weight: bytes(mesh.bindings.weight) } : null,
  }));
  kernel.cleanup?.();
  const measured = measure(kernel, part, view, {}, { minWall: true, gaps: true });
  // A sweep row's `ms` is wall time, never part of the contract (the rest of the row is).
  if (measured.sweeps) measured.sweeps = measured.sweeps.map(({ ms: _ms, ...row }) => row);
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
        // Pose bindings (a preview k.implicit's, mesh-bindings.js): both sides or neither, equal.
        expect(m.bindings === null, `${m.name}.bindings present`).toBe(o.bindings === null);
        if (m.bindings) {
          expect(m.bindings.frames, `${m.name}.bindings.frames`).toEqual(o.bindings.frames);
          for (const k of ["frameA", "frameB", "weight"]) expect(Buffer.compare(m.bindings[k], o.bindings[k]), `${m.name}.bindings.${k}`).toBe(0);
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
        const compiled = compileImplicit(spec);
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

// The MESH op on the core: the solid fixtures above pass through buildView, where a core that
// quietly declined a solid spec would still match. Here meshImplicit runs each one directly,
// core off against core on (both builds), through a stand-in that counts the session's mesh
// fields: the core must really have taken them, and answered (nothing refused, no fault).
describe("solid leaves: the MESH op runs on the core", () => {
  let k;
  beforeAll(async () => { k = await bootManifoldKernel({ quality: "print", meshFields: true }); });
  const SOLID_CASES = [
    ["solid join, preview tier", () => solidJoin(k, {}), 0.6, "preview", 2],
    ["solid join, print tier", () => solidJoin(k, {}), 0.6, "print", 2],
    ["solid shrink", () => solidShrink(k, {}), 0.6, "preview", 1],
  ];
  for (const [name, make, edge, tier, fields] of SOLID_CASES) {
    test(`core on == core off: ${name} at ${edge} mm`, () => {
      const compiled = compileImplicit(make());
      expect(compiled.meshes.length).toBe(fields);
      setCoreEnabled(false);
      const off = meshImplicit(compiled, edge, { tier });
      expect(off.indices.length).toBeGreaterThan(0);
      for (const simd of [true, false]) {
        if (simd) delete globalThis.PARTFORGE_CORE_SIMD; else globalThis.PARTFORGE_CORE_SIMD = false;
        setCoreForTesting(undefined);
        setCoreEnabled(true);
        const real = core();
        let added = 0;
        const standIn = { ...real, x: { ...real.x, ip_mesh_field_add: (...a) => { added++; return real.x.ip_mesh_field_add(...a); } } };
        setCoreForTesting(standIn);
        const on = meshImplicit(compiled, edge, { tier });
        expect(real.simd, "the build under test ran").toBe(simd);
        expect(standIn.poisoned, "the core did not fault").toBeFalsy();
        expect(coreStatus(), "the core answered").toMatchObject({ reason: null, refusedMeshes: 0 });
        expect(added, "the session took every mesh field").toBe(fields);
        for (const key of ["positions", "indices", "normals"]) {
          expect(on[key]?.constructor, `${key} (${simd ? "SIMD" : "scalar"})`).toBe(off[key].constructor);
          expect(Buffer.compare(bytes(on[key]), bytes(off[key])), `${key} (${simd ? "SIMD" : "scalar"})`).toBe(0);
        }
        expect(on.warnings).toEqual(off.warnings);
        expect(on.stats).toEqual(off.stats);
      }
      delete globalThis.PARTFORGE_CORE_SIMD;
      setCoreForTesting(undefined);
      setCoreEnabled(true);
    }, 240_000);
  }
});

// The sharpen stage (implicit/sharpen.js; native/implicit_sharpen.cpp): every case of
// test/implicit-sharpen.test.js that decides something, through meshImplicit, core off against
// core on (both builds). A stand-in counts the session's sharpen calls, so the core really ran
// the stage, and nothing was refused. Positions, indices and normals byte for byte (and on the
// owner path every owner field), the warnings and the stats, sharpEdges and sharpCorners included.
// The stage's own tables never leave the engine.
describe("the sharpen stage runs on the core", () => {
  let k;
  beforeAll(async () => { k = await bootManifoldKernel({ quality: "print", meshFields: true }); });
  const box = (size, at) => ({ root: { kind: "box", size, ...(at ? { at } : {}) } });
  const plate = () => ({ root: { kind: "union", k: 8, children: [solidLeaf(k.box({ min: [-30, -20, 0], max: [30, 20, 6] })),
    solidLeaf(k.cylinder({ r: 8, h: 26 }).at([20, 0, 4]))] } });
  const bracket = () => ({ root: { kind: "union", k: 6, children: [
    solidLeaf(k.box({ min: [-30, -20, 0], max: [30, 20, 6] }).union(k.box({ min: [-30, -20, 0], max: [-24, 20, 30] }))),
    solidLeaf(k.cylinder({ r: 5, h: 20 }).at([-14, 0, 4]))] } });
  const curved = () => ({ root: { kind: "intersect", k: 0, children: [{ kind: "sphere", r: 12 }, { kind: "cylinder", r: 8, h: 40 }] } });
  const posed = (gap) => ({
    frames: { fa: { at: [-7.4, 0, 0] }, fb: { at: [7.4, 0, 0], rotate: [{ axis: "y", deg: 6 }] } },
    root: { kind: "contact", gap, bulge: 0, children: [
      { kind: "capsule", a: [0, 0, -20], b: [0, 0, 20], r: 8, frame: "fa", label: "a" },
      { kind: "capsule", a: [0, 0, -20], b: [0, 0, 20], r: 8, frame: "fb", label: "b" },
      { kind: "box", size: [36, 24, 6], at: [0, 0, 26], label: "c" },
    ] },
  });
  const KNURL = "vec2 z = normalize(p.xy); for (int i = 0; i < 4; i++) { z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y); } "
    + "float c = cos(p.z * 1.3); float s = sin(p.z * 1.3); return max(z.x * c - z.y * s, z.x * c + z.y * s);";
  const knurl = () => ({ kind: "displace", amount: 0.7, child: solidLeaf(k.cylinder({ r: 12, h: 30 })), by: { expr: KNURL } });
  const cagePost = () => {
    const c = k.cage({ box: { size: [44, 24, 22], segs: [2, 1, 1] } });
    c.extrude("+x:0,0", { by: 14, scale: 0.55 });
    return { root: { kind: "union", k: 7, children: [solidLeaf(k.subdiv(c).at([0, 0, 24])), solidLeaf(k.cylinder({ r: 5, h: 22 }).at([-6, 0, 0]))] } };
  };
  const offset = (d) => ({ root: { kind: "offset", d, child: solidLeaf(k.box({ min: [-20, -15, -10], max: [20, 15, 10] })) } });
  const thinWall = () => ({ root: { kind: "intersect", children: [{ kind: "onion", t: 0.8, child: { kind: "box", size: [30, 30, 30] } },
    { kind: "halfspace", normal: "z", offset: 5 }] } });
  // The box sweep's cases (implicit-sharpen.test.js): side n cells, placed at offset `o` cells.
  const OFFSETS = [[0, 0, 0], [0.37, 0.11, 0.73], [0.5, 0.5, 0.5]];
  const sweep = (edge, n, o) => { const h = (n * edge) / 2; return box([2 * h, 2 * h, 2 * h], OFFSETS[o].map((x) => x * edge)); };
  const cube = (edge, n) => { const h = (n * edge) / 2; return box([2 * h, 2 * h, 2 * h]); };
  // A pyramid's tip (implicit-sharpen.test.js's "pyramid"): n faces leaning `lean` degrees from
  // upright, turned `rot` radians, through (0, 0, H). Its corner candidates go back to their start.
  const pyramid = (n, lean, rot, H) => {
    const s = Math.sin(((90 - lean) * Math.PI) / 180), c = Math.cos(((90 - lean) * Math.PI) / 180), sides = [];
    for (let i = 0; i < n; i++) {
      const a = rot + (2 * Math.PI * i) / n;
      sides.push({ kind: "halfspace", normal: [s * Math.cos(a), s * Math.sin(a), c], offset: H * c });
    }
    return { root: { kind: "intersect", children: [{ kind: "box", size: [40, 40, 40] }, { kind: "halfspace", normal: [0, 0, -1], offset: 0 }, ...sides] } };
  };
  // [name, spec maker, edge, tier, sharp points expected]
  const CASES = [
    ...[[0.6, "preview"], [0.3, "print"]].flatMap(([edge, tier]) => [
      [`box at ${edge} ${tier}`, () => box([40, 30, 6]), edge, tier, true],
      [`plate-edge at ${edge} ${tier}`, plate, edge, tier, true],
      [`bracket-corner at ${edge} ${tier}`, bracket, edge, tier, true],
      [`curved-crease at ${edge} ${tier}`, curved, edge, tier, true],
      [`posed, gap 0, at ${edge} ${tier}`, () => posed(0), edge, tier, true],
      [`posed, gap 0.05, at ${edge} ${tier}`, () => posed(0.05), edge, tier, true],
      // The density rule skips the knurl at 0.6. At 0.3 its share of crease edges is under a
      // fifth, so it is sharpened in full. Parity sees bytes only: its soundness (no coincident
      // vertices among them) is test/implicit-sharpen.test.js's "knurl at print 0.3".
      [`knurl at ${edge} ${tier}`, () => ({ root: knurl() }), edge, tier, edge === 0.3],
    ]),
    // The four parked sweep cases (one corner cut), and four that find all eight.
    ...[[0.6, 8, 1], [0.6, 9, 1], [1.0, 3, 1], [1.0, 4, 1], [0.6, 4, 1], [0.6, 7, 0], [1.0, 3, 0], [1.0, 11.5, 2]]
      .map(([edge, n, o]) => [`sweep box ${n} cells, offset ${o}, at ${edge}`, () => sweep(edge, n, o), edge, "preview", true]),
    ...[0.6, 1.0].flatMap((edge) => [3, 4, 4.5, 5, 6].map((n) => [`small cube ${n} cells at ${edge}`, () => cube(edge, n), edge, "preview", true])),
    ["cage post at 0.6", cagePost, 0.6, "preview", true],
    ["offset -2 at 0.6", () => offset(-2), 0.6, "preview", true],
    ["offset +2 at 0.6", () => offset(2), 0.6, "preview", false],
    ["knurl and a box at 0.6", () => ({ root: { kind: "union", children: [knurl(), solidLeaf(k.box({ min: [30, -10, 0], max: [50, 10, 10] }))] } }),
      0.6, "preview", true],
    ["thin wall at 1.0", thinWall, 1.0, "preview", true],
    ["4-faced pyramid at 0.6", () => pyramid(4, 35, 0.3, 8), 0.6, "preview", true],
    ["4-faced pyramid at 1.0", () => pyramid(4, 25, 0, 10.17), 1.0, "preview", true],
    ["6-faced pyramid at 0.6", () => pyramid(6, 35, 0.3, 10.17), 0.6, "preview", true],
  ];
  const FIELDS = ["positions", "indices", "normals"];
  const OWNER_FIELDS = [...FIELDS, "vertOwner", "ownerHeld", "pinned", "crease", "triOwner"];
  for (const [name, make, edge, tier, expectSharp] of CASES) {
    test(`core on == core off: ${name}`, () => {
      const compiled = compileImplicit(make());
      const fields = compiled.ownerRoot >= 0 ? OWNER_FIELDS : FIELDS;
      setCoreEnabled(false);
      const off = meshImplicit(compiled, edge, { tier });
      expect(off.indices.length).toBeGreaterThan(0);
      expect(off.stats.sharpEdges + off.stats.sharpCorners > 0, "sharp points").toBe(expectSharp);
      expect(off.sharp).toBeUndefined();
      expect(off.sharpPlanes).toBeUndefined();
      for (const simd of [true, false]) {
        if (simd) delete globalThis.PARTFORGE_CORE_SIMD; else globalThis.PARTFORGE_CORE_SIMD = false;
        setCoreForTesting(undefined);
        setCoreEnabled(true);
        const real = core();
        let sharpened = 0;
        const standIn = { ...real, x: { ...real.x, ip_sharpen: (...a) => { sharpened++; return real.x.ip_sharpen(...a); } } };
        setCoreForTesting(standIn);
        const on = meshImplicit(compiled, edge, { tier });
        const build = simd ? "SIMD" : "scalar";
        expect(real.simd, "the build under test ran").toBe(simd);
        expect(standIn.poisoned, "the core did not fault").toBeFalsy();
        expect(coreStatus(), "the core answered").toMatchObject({ reason: null, refusedMeshes: 0 });
        expect(sharpened, "the stage ran on the core").toBe(1);
        for (const key of fields) {
          expect(on[key]?.constructor, `${key} (${build})`).toBe(off[key].constructor);
          expect(Buffer.compare(bytes(on[key]), bytes(off[key])), `${key} (${build})`).toBe(0);
        }
        expect(on.sharp).toBeUndefined();
        expect(on.sharpPlanes).toBeUndefined();
        expect(on.warnings).toEqual(off.warnings);
        expect(on.stats).toEqual(off.stats);
      }
      delete globalThis.PARTFORGE_CORE_SIMD;
      setCoreForTesting(undefined);
      setCoreEnabled(true);
    }, 600_000);
  }
});
