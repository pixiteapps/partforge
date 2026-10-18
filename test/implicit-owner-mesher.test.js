// test/implicit-owner-mesher.test.js
// The owner-aware mesher on the raw mesh (no cleanup): each contact child keeps its own
// skin where the pieces are apart, at exactly the set gap; touching pieces fuse.
import { describe, test, expect } from "vitest";
import { compileImplicit } from "../src/framework/geometry/implicit/index.js";
import { planLeaves, evaluateLeaves, sampleField, LEAF } from "../src/framework/geometry/implicit/sparse.js";
import { evalBatch, evalBatchContact } from "../src/framework/geometry/implicit/program.js";
import { meshStore } from "../src/framework/geometry/implicit/mesher.js";
import { meshStoreOwners, OWNER_AIR } from "../src/framework/geometry/implicit/mesher-owners.js";
import { edgeCheck, componentCount } from "./helpers/mesh-topology.js";
import { pieceGapError, childIndex } from "./helpers/seam-quality.js";
import { capsulePress, PRESS_OVERLAP } from "./fixtures/implicit-seam-cases.js";

const EDGE = 1.5;
const CLOSED = { boundary: 0, nonManifold: 0, misoriented: 0 };
const exact = (spec) => compileImplicit(spec, { exactContact: true });
const ownerMesh = (spec, gap) => {
  const compiled = exact(spec), store = sampleField(compiled, EDGE);
  return { compiled, store, mesh: meshStoreOwners(store, { gap }) };
};

/** Each vertex's component root (triangles joined through shared vertices). */
function components(mesh) {
  const nv = mesh.positions.length / 3, parent = new Int32Array(nv).map((_, i) => i), I = mesh.indices;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t < I.length; t += 3) {
    const r = find(I[t]);
    for (let k = 1; k < 3; k++) { const s = find(I[t + k]); if (s !== r) parent[s] = r; }
  }
  return find;
}

describe("owner mesher (raw mesh)", () => {
  test("far-apart pieces mesh exactly as the plain mesher", () => {
    const { store, mesh } = ownerMesh(capsulePress({ overlap: -10 }), 0);
    const plain = meshStore(store);
    expect(Buffer.from(mesh.positions.buffer).equals(Buffer.from(plain.positions.buffer))).toBe(true);
    expect(Buffer.from(mesh.indices.buffer).equals(Buffer.from(plain.indices.buffer))).toBe(true);
    expect(mesh.vertOwner.length).toBe(plain.positions.length / 3);
  });

  for (const [gap, tol] of [[0.2, 0.002], [0.05, 0.01]]) {
    test(`press gap ${gap} is two closed shells at the gap`, () => {
      const { compiled, mesh } = ownerMesh(capsulePress({ overlap: PRESS_OVERLAP, gap }), gap);
      expect(edgeCheck(mesh.indices)).toEqual(CLOSED);
      expect(componentCount(mesh.indices)).toBe(2);
      const g = pieceGapError(compiled, mesh, "a", "b", gap);
      expect(g.maxFaceError).toBeLessThanOrEqual(tol);
      expect(g.min).toBeGreaterThanOrEqual(gap - tol);
    });
  }

  test("press gap 0 is one closed solid", () => {
    const { mesh } = ownerMesh(capsulePress({ overlap: PRESS_OVERLAP, gap: 0 }), 0);
    expect(edgeCheck(mesh.indices)).toEqual(CLOSED);
    expect(componentCount(mesh.indices)).toBe(1);
  });

  test("near miss 0.3 at gap 0 stays apart", () => {
    const { compiled, mesh } = ownerMesh(capsulePress({ overlap: -0.3, gap: 0 }), 0);
    expect(edgeCheck(mesh.indices)).toEqual(CLOSED);
    expect(componentCount(mesh.indices)).toBe(2);
    expect(pieceGapError(compiled, mesh, "a", "b", 0).min).toBeGreaterThanOrEqual(0.3 - 0.01);
  });

  test("owners: the press-0.2 a-shell is owned by a throughout", () => {
    const { compiled, mesh } = ownerMesh(capsulePress({ overlap: PRESS_OVERLAP, gap: 0.2 }), 0.2);
    const ia = childIndex(compiled, "a"), find = components(mesh), P = mesh.positions;
    let left = 0;   // the vertex furthest toward −x lies on a's shell
    for (let v = 1; v < P.length / 3; v++) if (P[3 * v] < P[3 * left]) left = v;
    const shell = find(left);
    let count = 0;
    for (let v = 0; v < P.length / 3; v++) if (find(v) === shell) { expect(mesh.vertOwner[v]).toBe(ia); count++; }
    expect(count).toBeGreaterThan(100);
    expect(mesh.ownerHeld.length).toBe(P.length / 3);
    expect(mesh.pinned.some((p) => p === 1)).toBe(true);
  });

  test("evaluateLeaves samples once: one capturing batch per leaf, plus zero nudges", () => {
    const compiled = exact(capsulePress({ overlap: PRESS_OVERLAP, gap: 0 })), plan = planLeaves(compiled, EDGE);
    expect(plan.ownerRoot).toBe(compiled.ownerRoot);
    expect(plan.ownerK).toBe(2);
    const S3 = (LEAF + 1) ** 3;
    let plain = 0, leafCalls = 0, nudgeCalls = 0;
    const store = evaluateLeaves(plan, {
      evalBatch: (...a) => { plain++; return evalBatch(...a); },
      evalBatchContact: (...a) => { if (a[2].length === S3) leafCalls++; else nudgeCalls++; return evalBatchContact(...a); },
    });
    expect(plain).toBe(0);
    expect(leafCalls).toBe(plan.leaves.length);
    expect(nudgeCalls).toBeLessThanOrEqual(plan.leaves.length);
    // The same values as an uncapturing run; owners are AIR exactly where the stored value is ≥ 0.
    const ref = evaluateLeaves(planLeaves(compileImplicit(capsulePress({ overlap: PRESS_OVERLAP, gap: 0 })), EDGE));
    expect(ref.leaves[0].owner).toBeUndefined();
    let solid = 0;
    for (const leaf of store.leaves) {
      expect(leaf.owner).toBeInstanceOf(Int8Array);
      expect(leaf.owner.length).toBe(S3);
      for (let s = 0; s < S3; s++) {
        if (leaf.vals[s] >= 0) expect(leaf.owner[s]).toBe(OWNER_AIR);
        else { expect(leaf.owner[s]).toBeGreaterThanOrEqual(0); solid++; }
      }
    }
    expect(solid).toBeGreaterThan(0);
  });
});
