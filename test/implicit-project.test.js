import { describe, test, expect } from "vitest";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { sampleField } from "../src/framework/geometry/implicit/sparse.js";
import { meshStore } from "../src/framework/geometry/implicit/mesher.js";
import { projectVertices } from "../src/framework/geometry/implicit/project.js";
import { evalReference } from "../src/framework/geometry/implicit/reference.js";
import { TREES } from "./fixtures/implicit-small-trees.js";

const setup = () => {
  const c = lowerSpec(TREES.blobs, { images: new Map() });
  const store = sampleField(c, 0.8), mesh = meshStore(store);
  return { c, store, mesh };
};
const d = (c, P, v) => evalReference(c, P[3 * v], P[3 * v + 1], P[3 * v + 2]);

describe("projectVertices", () => {
  test("moves perturbed vertices back onto the surface within the step limit", () => {
    const { c, store, mesh } = setup();
    const P = Float64Array.from(mesh.positions), n = P.length / 3;
    const base = Float64Array.from(P);
    const normals = new Float64Array(P.length);
    projectVertices(store, base, mesh.vertLeaf, { maxStep: 0.4, normals });
    for (let v = 0; v < n; v++) {
      const nx = normals[3 * v], ny = normals[3 * v + 1], nz = normals[3 * v + 2];
      P[3 * v] = base[3 * v] + 0.1 * nx; P[3 * v + 1] = base[3 * v + 1] + 0.1 * ny; P[3 * v + 2] = base[3 * v + 2] + 0.1 * nz;
    }
    const before = Float64Array.from(P);
    projectVertices(store, P, mesh.vertLeaf, { maxStep: 0.4 });
    let worstBefore = 0, worstAfter = 0, worstMove = 0;
    for (let v = 0; v < n; v++) {
      worstBefore = Math.max(worstBefore, Math.abs(d(c, before, v)));
      worstAfter = Math.max(worstAfter, Math.abs(d(c, P, v)));
      worstMove = Math.max(worstMove, Math.hypot(P[3 * v] - before[3 * v], P[3 * v + 1] - before[3 * v + 1], P[3 * v + 2] - before[3 * v + 2]));
    }
    expect(worstAfter).toBeLessThan(worstBefore * 0.5);
    expect(worstMove).toBeLessThanOrEqual(0.4 + 1e-9);
  });
  test("maxStep clamps the move", () => {
    const { mesh, store } = setup();
    const P = Float64Array.from(mesh.positions);
    for (let i = 0; i < P.length; i++) P[i] += 0.3;
    const before = Float64Array.from(P);
    projectVertices(store, P, mesh.vertLeaf, { maxStep: 0.05 });
    for (let v = 0; v < P.length / 3; v++) {
      expect(Math.hypot(P[3 * v] - before[3 * v], P[3 * v + 1] - before[3 * v + 1], P[3 * v + 2] - before[3 * v + 2])).toBeLessThanOrEqual(0.05 + 1e-9);
    }
  });
  test("`which` restricts the update; `normals` receives unit gradients", () => {
    const { mesh, store } = setup();
    const P = Float64Array.from(mesh.positions);
    for (let i = 0; i < P.length; i++) P[i] += 0.05;
    const before = Float64Array.from(P), which = [1, 3, 5], normals = new Float64Array(P.length);
    projectVertices(store, P, mesh.vertLeaf, { maxStep: 0.4, which, normals });
    for (let v = 0; v < P.length / 3; v++) {
      const moved = P[3 * v] !== before[3 * v] || P[3 * v + 1] !== before[3 * v + 1] || P[3 * v + 2] !== before[3 * v + 2];
      expect(moved).toBe(which.includes(v));
      const len = Math.hypot(normals[3 * v], normals[3 * v + 1], normals[3 * v + 2]);
      expect(len).toBeCloseTo(which.includes(v) ? 1 : 0, 9);
    }
  });
});
