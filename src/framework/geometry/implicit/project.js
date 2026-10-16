// src/framework/geometry/implicit/project.js
// Newton projection of mesh vertices onto d = 0, batched per leaf: each vertex is
// evaluated with its own leaf's program, which is exact within PAD_CELLS (1 cell)
// of the leaf (sparse.js). Each move is clamped per step (`maxStep`); nothing bounds
// the cumulative drift by construction, but on the fixtures it measured at most
// 0.69 cell, inside the 1-cell pad.
import { evalBatch } from "./program.js";

export function projectVertices(store, positions, vertLeaf, { maxStep, which = null, normals = null }) {
  const e = 0.1 * store.edge;
  const groups = new Map();   // leaf index -> vertex list (insertion order = vertex order)
  const count = which ? which.length : positions.length / 3;
  for (let q = 0; q < count; q++) {
    const v = which ? which[q] : q, L = vertLeaf[v];
    let g = groups.get(L);
    if (!g) { g = []; groups.set(L, g); }
    g.push(v);
  }
  for (const [L, verts] of groups) {
    const prog = store.leaves[L].prog, m = verts.length;
    const X = new Float64Array(7 * m), Y = new Float64Array(7 * m), Z = new Float64Array(7 * m), out = new Float64Array(7 * m);
    verts.forEach((v, k) => {
      const x = positions[3 * v], y = positions[3 * v + 1], z = positions[3 * v + 2], o = 7 * k;
      X[o] = x; Y[o] = y; Z[o] = z;
      X[o + 1] = x + e; Y[o + 1] = y; Z[o + 1] = z;
      X[o + 2] = x - e; Y[o + 2] = y; Z[o + 2] = z;
      X[o + 3] = x; Y[o + 3] = y + e; Z[o + 3] = z;
      X[o + 4] = x; Y[o + 4] = y - e; Z[o + 4] = z;
      X[o + 5] = x; Y[o + 5] = y; Z[o + 5] = z + e;
      X[o + 6] = x; Y[o + 6] = y; Z[o + 6] = z - e;
    });
    evalBatch(prog, store.textures, X, Y, Z, out);
    verts.forEach((v, k) => {
      const o = 7 * k, d = out[o];
      const gx = (out[o + 1] - out[o + 2]) / (2 * e), gy = (out[o + 3] - out[o + 4]) / (2 * e), gz = (out[o + 5] - out[o + 6]) / (2 * e);
      const g2 = gx * gx + gy * gy + gz * gz;
      if (!(g2 > 1e-12)) return;
      const gl = Math.sqrt(g2);
      if (normals) { normals[3 * v] = gx / gl; normals[3 * v + 1] = gy / gl; normals[3 * v + 2] = gz / gl; }
      let t = d / gl;                              // signed distance estimate along the gradient
      if (t > maxStep) t = maxStep; else if (t < -maxStep) t = -maxStep;
      positions[3 * v] -= (gx / gl) * t; positions[3 * v + 1] -= (gy / gl) * t; positions[3 * v + 2] -= (gz / gl) * t;
    });
  }
}
