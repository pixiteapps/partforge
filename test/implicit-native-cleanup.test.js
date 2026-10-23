// The native projection and cleanup (native/implicit_mesh.cpp, ip_project and
// ip_cleanup) must produce the SAME BYTES as project.js's projectVertices and
// cleanup.js's cleanupMesh: positions, indices, vertLeaf and normals — at both
// tiers (CLEANUP, and the preview tier's decimating PREVIEW_CLEANUP).
import { afterEach, describe, expect, test } from "vitest";
import { core, setCoreForTesting } from "../src/framework/core/core.js";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { planLeaves, evaluateLeaves } from "../src/framework/geometry/implicit/sparse.js";
import { meshStore } from "../src/framework/geometry/implicit/mesher.js";
import { projectVertices } from "../src/framework/geometry/implicit/project.js";
import { cleanupMesh, CLEANUP, PREVIEW_CLEANUP } from "../src/framework/geometry/implicit/cleanup.js";
import { nativeCases, sessionFor } from "./fixtures/implicit-native-cases.js";
import { compileImplicit } from "../src/framework/geometry/implicit/index.js";
import { meshStoreOwners } from "../src/framework/geometry/implicit/mesher-owners.js";
import { cutCreases, untangle } from "../src/framework/geometry/implicit/crease.js";
import { SEAM_CASES, threePress, fingersOnPalm } from "./fixtures/implicit-seam-cases.js";

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

describe("native cleanup", () => {
  for (const { name, spec, images, edges } of nativeCases()) {
    for (const edge of edges) for (const [tier, opts] of [["CLEANUP", CLEANUP], ["PREVIEW_CLEANUP", PREVIEW_CLEANUP]]) {
      test(`${name} at ${edge} mm, ${tier}: cleanupMesh's positions, indices, vertLeaf and normals`, () => {
        const plan = planLeaves(lowerSpec(spec, { images }), edge);
        const store = evaluateLeaves(plan);
        const js = cleanupMesh(store, meshStore(store), opts);
        expect(js.indices.length).toBeGreaterThan(0);
        const s = sessionFor(plan);
        try {
          s.sample(plan, { readBack: false });
          s.mesh();
          const nat = s.cleanup(opts);
          same("positions", nat.positions, js.positions);
          same("indices", nat.indices, js.indices);
          same("vertLeaf", nat.vertLeaf, js.vertLeaf);
          same("normals", nat.normals, js.normals);
          same("normals()", s.normals(), js.normals);
        } finally { s.destroy(); }
      }, 120_000);
    }
  }

  test("projection alone: a `which` subset with normals, and every vertex without", () => {
    for (const name of ["blobs", "vase", "adversarial coincidentFaces"]) {
      const { spec, images } = nativeCases().find((k) => k.name === name);
      const plan = planLeaves(lowerSpec(spec, { images }), 0.8);
      const store = evaluateLeaves(plan);
      const raw = meshStore(store);
      const nv = raw.vertLeaf.length;
      // Every third vertex, back to front: the JS groups them by leaf in first-appearance order.
      const which = Int32Array.from({ length: Math.ceil(nv / 3) }, (_, q) => nv - 1 - 3 * q);
      const P = Float64Array.from(raw.positions), N = new Float64Array(3 * nv);
      projectVertices(store, P, raw.vertLeaf, { maxStep: 0.3, which, normals: N });
      const s = sessionFor(plan);
      try {
        s.sample(plan, { readBack: false });
        s.mesh();
        const nat = s.project({ maxStep: 0.3, which, normals: true });
        same("positions", nat.positions, P);
        same("normals", nat.normals, N);
        // A second pass over every vertex, no normals: the session's earlier normals stay.
        projectVertices(store, P, raw.vertLeaf, { maxStep: 0.3 });
        const nat2 = s.project({ maxStep: 0.3 });
        same("positions (all)", nat2.positions, P);
        expect(nat2.normals).toBeNull();
        same("normals kept", s.normals(), N);
      } finally { s.destroy(); }
    }
  });

  // The native decimation refuses a too-sharp collapse early, inside its fan walk, only in a pass
  // whose coordinates all lie in [1e-50, 1e75) or at 0 (where no corner sharpness can be NaN);
  // otherwise it runs the corner guard after the walk. A coordinate of 1e-60 turns the early
  // refusal off for every pass, so this holds that fallback to the JS.
  test("PREVIEW_CLEANUP with a coordinate below 1e-50 (no early corner refusal): cleanupMesh's bytes", () => {
    const { spec, images } = nativeCases().find((k) => k.name === "hand fist");
    const plan = planLeaves(lowerSpec(spec, { images }), 1.5);
    const store = evaluateLeaves(plan);
    const raw = meshStore(store);
    // Every coordinate within 0.3 mm of 0 becomes +-1e-60, so some survive every pass (a collapse
    // replaces its vertex by a midpoint, back in range).
    const positions = Float64Array.from(raw.positions, (x) => (Math.abs(x) < 0.3 ? (x < 0 ? -1e-60 : 1e-60) : x));
    const mesh = { positions, indices: raw.indices, vertLeaf: raw.vertLeaf };
    const js = cleanupMesh(store, mesh, PREVIEW_CLEANUP);
    expect(js.indices.length).toBeLessThan(raw.indices.length / 2);   // decimation ran
    const s = sessionFor(plan);
    try {
      s.sample(plan, { readBack: false });
      s.loadMesh(mesh);
      const nat = s.cleanup(PREVIEW_CLEANUP);
      same("positions", nat.positions, js.positions);
      same("indices", nat.indices, js.indices);
      same("vertLeaf", nat.vertLeaf, js.vertLeaf);
      same("normals", nat.normals, js.normals);
    } finally { s.destroy(); }
  }, 120_000);

  test("refusals: no mesh, a repeated or out-of-range vertex; the instance is not poisoned", () => {
    const plan = planLeaves(lowerSpec({ root: { kind: "sphere", r: 3 } }, { images: new Map() }), 1);
    const s = sessionFor(plan);
    try {
      expect(() => s.cleanup(CLEANUP)).toThrow(/refused/);
      expect(() => s.project({ maxStep: 1 })).toThrow(/refused/);
      s.sample(plan);
      const raw = s.mesh();
      expect(() => s.project({ maxStep: 1, which: [0, 0] })).toThrow(/refused/);
      expect(() => s.project({ maxStep: 1, which: [raw.vertLeaf.length] })).toThrow(/refused/);
      expect(() => s.project({ maxStep: 1, which: [-1] })).toThrow(/refused/);
      same("empty which moves nothing", s.project({ maxStep: 1, which: [] }).positions, raw.positions);
      expect(() => s.loadMesh({ positions: [0, 0, 0], indices: [0, 0, 1], vertLeaf: [0] })).toThrow(/refused/);
      expect(() => s.loadMesh({ positions: [0, 0, 0], indices: [], vertLeaf: [plan.leaves.length] })).toThrow(/refused/);
    } finally { s.destroy(); }
    expect(core().poisoned).toBe(false);
  });
});

// The owner path's later stages, each from the stage before it on one session: owner-aware
// cleanup (cleanupMesh on meshStoreOwners' mesh: owner/held/pinned carried, collapse guards,
// share projection, the extra pass, pinned normals), the crease cut (crease.js's cutCreases)
// and untangle — the same bytes as the JS at every stage, owner fields included.
const OWNER_CASES = [
  ...SEAM_CASES.filter((c) => /^press|^near miss|^hand fist/.test(c.name)),
  { name: "three pressed spheres gap 0", spec: threePress({ gap: 0 }) },
  { name: "fingers on palm 0.3", spec: fingersOnPalm({ fingerGap: 0.3 }) },
];
const OWNED = ["positions", "indices", "vertLeaf", "normals", "vertOwner", "ownerHeld", "pinned"];

describe("native owner cleanup, crease cut and untangle", () => {
  let creases = 0, untangled = 0;
  for (const { name, spec } of OWNER_CASES) {
    for (const [edge, tier, opts] of [[1.5, "PREVIEW_CLEANUP", PREVIEW_CLEANUP], [1.5, "CLEANUP", CLEANUP], [0.6, "CLEANUP", CLEANUP]]) {
      test(`${name} at ${edge} mm, ${tier}: each stage's bytes`, () => {
        const compiled = compileImplicit(spec, { exactContact: true });
        const node = compiled.ir.nodes[compiled.ownerRoot];
        const plan = planLeaves(compiled, edge);
        const store = evaluateLeaves(plan);
        const cleaned = cleanupMesh(store, meshStoreOwners(store, { gap: node.gap }), opts);
        const cut = cutCreases(store, cleaned, node.attWorld);
        const done = untangle(store, cut);
        creases += cut.crease.reduce((a, b) => a + b, 0);
        if (done !== cut) untangled++;
        const s = sessionFor(plan);
        try {
          s.setContact(node);
          s.sample(plan, { readBack: false });
          s.meshOwners({ readBack: false });
          const natCleaned = s.cleanup(opts);
          for (const k of OWNED) same(`cleanup ${k}`, natCleaned[k], cleaned[k]);
          const natCut = s.crease();
          for (const k of [...OWNED, "crease"]) same(`crease ${k}`, natCut[k], cut[k]);
          const natDone = s.untangle();
          for (const k of [...OWNED, "crease"]) same(`untangle ${k}`, natDone[k], done[k]);
        } finally { s.destroy(); }
      }, 300_000);
    }
  }
  test("the cases reach the cut and the repair", () => {
    expect(creases).toBeGreaterThan(0);
    expect(untangled).toBeGreaterThan(0);
  });

  // untangle also refuses (rc 3) when a triangle's edge has no list in its edge table, or an
  // empty one (native/implicit_owner.cpp's Untangle::unlink) — a guard against undefined
  // behaviour that no session mesh reaches (the table is built from the mesh's own triangles), so
  // it has no test here; like every refusal it lands in meshImplicit's JS fallback.
  test("crease and untangle need an owner mesh: refused, not run", () => {
    const plan = planLeaves(lowerSpec({ root: { kind: "sphere", r: 3 } }, { images: new Map() }), 1);
    const s = sessionFor(plan);
    try {
      s.sample(plan, { readBack: false });
      s.mesh({ readBack: false });
      s.cleanup(CLEANUP, { readBack: false });
      expect(() => s.crease()).toThrow(/refused/);
      expect(() => s.untangle()).toThrow(/refused/);
    } finally { s.destroy(); }
    expect(core().poisoned).toBe(false);
  });
});
