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
