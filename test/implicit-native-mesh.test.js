// The native marching tetrahedra (native/implicit_mesh.cpp, ip_mesh) must build the
// SAME BYTES as mesher.js's meshStore from the same leaf store: positions (vertex
// creation order = index), indices (orientation included) and vertLeaf.
import { afterEach, describe, expect, test } from "vitest";
import { core, setCoreForTesting } from "../src/framework/core/core.js";
import { NativeSession } from "../src/framework/core/implicit-core.js";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { planLeaves, evaluateLeaves } from "../src/framework/geometry/implicit/sparse.js";
import { meshStore } from "../src/framework/geometry/implicit/mesher.js";
import { nativeCases, sessionFor } from "./fixtures/implicit-native-cases.js";
import { compileImplicit } from "../src/framework/geometry/implicit/index.js";
import { meshStoreOwners } from "../src/framework/geometry/implicit/mesher-owners.js";
import { SEAM_CASES, capsulePress, threePress, fingersOnPalm } from "./fixtures/implicit-seam-cases.js";

afterEach(() => setCoreForTesting(undefined));

const bytes = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
function same(name, nat, js) {
  expect(nat.constructor).toBe(js.constructor);
  if (nat.length !== js.length) throw new Error(`${name}: native length ${nat.length} vs JS ${js.length}`);
  if (Buffer.compare(bytes(nat), bytes(js)) !== 0) {
    const k = js.findIndex((v, i) => !Object.is(v, nat[i]));
    throw new Error(`${name}[${k}]: native ${nat[k]} vs JS ${js[k]}`);
  }
}

describe("native marching tetrahedra", () => {
  for (const { name, spec, images, edges } of nativeCases()) {
    for (const edge of edges) {
      test(`${name} at ${edge} mm: positions, indices and vertLeaf match meshStore`, () => {
        const plan = planLeaves(lowerSpec(spec, { images }), edge);
        const js = meshStore(evaluateLeaves(plan));
        expect(js.indices.length).toBeGreaterThan(0);
        const s = sessionFor(plan);
        try {
          s.sample(plan);
          const nat = s.mesh();
          same("positions", nat.positions, js.positions);
          same("indices", nat.indices, js.indices);
          same("vertLeaf", nat.vertLeaf, js.vertLeaf);
        } finally { s.destroy(); }
      }, 120_000);
    }
  }

  test("a dense plan (leaves clamped at the grid's far faces) meshes the same bytes", () => {
    for (const name of ["blobs", "carved", "touching mirrorHalfBox"]) {
      const { spec, images } = nativeCases().find((k) => k.name === name);
      const plan = planLeaves(lowerSpec(spec, { images }), 1, { cull: false });
      const js = meshStore(evaluateLeaves(plan));
      const s = sessionFor(plan);
      try {
        s.sample(plan, { readBack: false });
        const nat = s.mesh();
        same("positions", nat.positions, js.positions);
        same("indices", nat.indices, js.indices);
        same("vertLeaf", nat.vertLeaf, js.vertLeaf);
      } finally { s.destroy(); }
    }
  });

  test("an edge key past 2^32 welds like the JS (64-bit grid indices)", () => {
    // The same sphere's plan on a grid whose layers are n0·n1 = 2^29 points apart, so
    // the same (i, j) edge in adjacent layers differs by exactly 2^32 in its key: a
    // key truncated to 32 bits would weld them together.
    const plan = planLeaves(lowerSpec({ root: { kind: "sphere", r: 3 } }, { images: new Map() }), 1);
    const big = { ...plan, n: [2 ** 14, 2 ** 15, plan.n[2]] };
    expect(big.n[0] * big.n[1] * 8).toBe(2 ** 32);
    const js = meshStore(evaluateLeaves(big));
    const s = sessionFor(big);
    try {
      s.sample(big);
      const nat = s.mesh();
      same("positions", nat.positions, js.positions);
      same("indices", nat.indices, js.indices);
      same("vertLeaf", nat.vertLeaf, js.vertLeaf);
    } finally { s.destroy(); }
  });

  test("mesh before sample is refused, not run; an empty store meshes to nothing", () => {
    const s = new NativeSession(core());
    try {
      expect(() => s.mesh()).toThrow(/refused/);
      const plan = planLeaves(lowerSpec({ root: { kind: "sphere", r: 3 } }, { images: new Map() }), 1);
      s.sample({ ...plan, leaves: [] });
      const nat = s.mesh();
      expect([nat.positions.length, nat.indices.length, nat.vertLeaf.length]).toEqual([0, 0, 0]);
    } finally { s.destroy(); }
    expect(core().poisoned).toBe(false);
  });
});

// The owner mesher (mesher-owners.js's meshStoreOwners, ip_mesh_owners): a root exact contact's
// store meshed with its owners — air-node refinement of open owner edges, held plain vertices,
// pinned gap-face vertices — the same bytes, owner fields included.
const OWNER_STAGE_CASES = [
  ...SEAM_CASES.filter((c) => /^press|^near miss|^hand fist/.test(c.name)),
  { name: "three pressed spheres gap 0", spec: threePress({ gap: 0 }) },
  { name: "three pressed spheres gap 0.2", spec: threePress({ gap: 0.2 }) },
  { name: "fingers on palm 0.3", spec: fingersOnPalm({ fingerGap: 0.3 }) },
];

describe("native owner mesher", () => {
  let held = 0, pinned = 0;
  for (const { name, spec } of OWNER_STAGE_CASES) {
    for (const edge of [1.5, 0.6]) {
      test(`${name} at ${edge} mm: meshStoreOwners' positions, indices, vertLeaf, vertOwner, ownerHeld and pinned`, () => {
        const compiled = compileImplicit(spec, { exactContact: true });
        const node = compiled.ir.nodes[compiled.ownerRoot];
        const plan = planLeaves(compiled, edge);
        const js = meshStoreOwners(evaluateLeaves(plan), { gap: node.gap });
        expect(js.indices.length).toBeGreaterThan(0);
        held += js.ownerHeld.reduce((a, b) => a + b, 0);
        pinned += js.pinned.reduce((a, b) => a + b, 0);
        const s = sessionFor(plan);
        try {
          s.setContact(node);
          s.sample(plan, { readBack: false });
          const nat = s.meshOwners();
          for (const k of ["positions", "indices", "vertLeaf", "vertOwner", "ownerHeld", "pinned"]) same(k, nat[k], js[k]);
        } finally { s.destroy(); }
      }, 120_000);
    }
  }
  test("the cases reach the refinement: held and pinned vertices were compared", () => {
    expect(held).toBeGreaterThan(0);
    expect(pinned).toBeGreaterThan(0);
  });

  test("meshOwners needs an owner plan and a contact; refused, not run, and the instance is not poisoned", () => {
    const sphere = planLeaves(lowerSpec({ root: { kind: "sphere", r: 3 } }, { images: new Map() }), 1);
    const s = sessionFor(sphere);
    try {
      s.sample(sphere, { readBack: false });
      expect(() => s.meshOwners()).toThrow(/refused/);   // no owner plan, no contact
    } finally { s.destroy(); }
    const compiled = compileImplicit(capsulePress({ overlap: 1.2, gap: 0.2 }), { exactContact: true });
    const plan = planLeaves(compiled, 1.5);
    const t = sessionFor(plan);
    try {
      t.sample(plan, { readBack: false });
      expect(() => t.meshOwners()).toThrow(/refused/);   // an owner plan, but no contact set
    } finally { t.destroy(); }
    expect(core().poisoned).toBe(false);
  });
});
