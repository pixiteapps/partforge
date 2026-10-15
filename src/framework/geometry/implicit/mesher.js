// src/framework/geometry/implicit/mesher.js
// Marching tetrahedra over the sparse store: each leaf's cells are split into the
// six Kuhn tetrahedra (face-consistent, so the surface closes), crossings are
// welded per grid edge (key = lowCorner·8 + direction bits) and interpolated low → high
// so equal crossings get equal coordinates. There is no vertex snapping: a shared snapped
// vertex merges crossings and breaks manifoldness on thin features, so the mesh is closed
// by construction; short-edge slivers are left to cleanup.
import { LEAF } from "./sparse.js";

const KUHN = [[0, 1, 3, 7], [0, 1, 5, 7], [0, 2, 3, 7], [0, 2, 6, 7], [0, 4, 5, 7], [0, 4, 6, 7]];

export function meshStore(store) {
  const { origin, edge, n, leaves } = store;
  const S = LEAF + 1;
  const positions = [], indices = [], vertLeaf = [];
  const edgeVerts = new Map();
  const gIndex = (i, j, l) => (l * n[1] + j) * n[0] + i;
  // Per-cell scratch: the 8 corner positions, a tet's corner split, its inside → outside
  // direction, and the current triangle's 3 edge midpoints.
  const CP = new Float64Array(24), negC = new Int32Array(4), posC = new Int32Array(4), g = new Float64Array(3), M = new Float64Array(9);
  const setMid = (k, ca, cb) => {
    M[3 * k] = (CP[3 * ca] + CP[3 * cb]) / 2; M[3 * k + 1] = (CP[3 * ca + 1] + CP[3 * cb + 1]) / 2; M[3 * k + 2] = (CP[3 * ca + 2] + CP[3 * cb + 2]) / 2;
  };

  for (let L = 0; L < leaves.length; L++) {
    const { i0, j0, l0, vals } = leaves[L];
    const at = (i, j, l) => vals[(l * S + j) * S + i];
    const posOf = (i, j, l) => [origin[0] + (i0 + i) * edge, origin[1] + (j0 + j) * edge, origin[2] + (l0 + l) * edge];
    // Corner c of cell (i, j, l): offset bits (c & 1, c >> 1 & 1, c >> 2 & 1).
    const vertexOn = (i, j, l, ca, cb) => {
      const lo = ca & cb, dir = ca ^ cb;               // Kuhn edges run low → high along monotone bits
      const hi = lo | dir;
      const li = i + (lo & 1), lj = j + ((lo >> 1) & 1), ll = l + ((lo >> 2) & 1);
      const hi_i = i + (hi & 1), hi_j = j + ((hi >> 1) & 1), hi_l = l + ((hi >> 2) & 1);
      const a = at(li, lj, ll), b = at(hi_i, hi_j, hi_l);
      const key = gIndex(i0 + li, j0 + lj, l0 + ll) * 8 + dir;
      let v = edgeVerts.get(key);
      if (v !== undefined) return v;
      const t = a / (a - b), pa = posOf(li, lj, ll), pb = posOf(hi_i, hi_j, hi_l);
      v = positions.length / 3;
      positions.push(pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t);
      vertLeaf.push(L);
      edgeVerts.set(key, v);
      return v;
    };
    // Orientation is topological, not read from the interpolated positions: the triangle's
    // edge midpoints M (which depend only on the tet's corners and labels) are tested against
    // the inside → outside direction g, so slivers whose crossings sit almost on a corner cannot flip.
    // (Crossings on distinct grid edges are distinct vertices, so a triangle never repeats one.)
    const tri = (a, b, c) => {
      const ux = M[3] - M[0], uy = M[4] - M[1], uz = M[5] - M[2];
      const vx = M[6] - M[0], vy = M[7] - M[1], vz = M[8] - M[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * g[0] + ny * g[1] + nz * g[2] < 0) indices.push(a, c, b); else indices.push(a, b, c);
    };
    const iEnd = Math.min(LEAF, n[0] - 1 - i0), jEnd = Math.min(LEAF, n[1] - 1 - j0), lEnd = Math.min(LEAF, n[2] - 1 - l0);
    for (let l = 0; l < lEnd; l++) for (let j = 0; j < jEnd; j++) for (let i = 0; i < iEnd; i++) {
      let neg = 0;
      for (let c = 0; c < 8; c++) if (at(i + (c & 1), j + ((c >> 1) & 1), l + ((c >> 2) & 1)) < 0) neg++;
      if (neg === 0 || neg === 8) continue;
      for (let c = 0; c < 8; c++) {   // corner positions, as posOf computes them
        CP[3 * c] = origin[0] + (i0 + (i + (c & 1))) * edge;
        CP[3 * c + 1] = origin[1] + (j0 + (j + ((c >> 1) & 1))) * edge;
        CP[3 * c + 2] = origin[2] + (l0 + (l + ((c >> 2) & 1))) * edge;
      }
      for (const tet of KUHN) {
        let nn = 0, np = 0;
        for (let q = 0; q < 4; q++) {
          const c = tet[q];
          if (at(i + (c & 1), j + ((c >> 1) & 1), l + ((c >> 2) & 1)) < 0) negC[nn++] = c; else posC[np++] = c;
        }
        if (nn === 0 || nn === 4) continue;
        for (let a = 0; a < 3; a++) {
          let sn = 0, sp = 0;
          for (let q = 0; q < nn; q++) sn += CP[3 * negC[q] + a];
          for (let q = 0; q < np; q++) sp += CP[3 * posC[q] + a];
          g[a] = sp / np - sn / nn;   // inside → outside
        }
        if (nn === 1 || nn === 3) {
          const lone = nn === 1 ? negC[0] : posC[0], others = nn === 1 ? posC : negC;
          setMid(0, lone, others[0]); setMid(1, lone, others[1]); setMid(2, lone, others[2]);
          tri(vertexOn(i, j, l, lone, others[0]), vertexOn(i, j, l, lone, others[1]), vertexOn(i, j, l, lone, others[2]));
        } else {
          const n0 = negC[0], n1 = negC[1], q0 = posC[0], q1 = posC[1];
          const v00 = vertexOn(i, j, l, n0, q0), v01 = vertexOn(i, j, l, n0, q1), v10 = vertexOn(i, j, l, n1, q0), v11 = vertexOn(i, j, l, n1, q1);
          setMid(0, n0, q0); setMid(1, n0, q1); setMid(2, n1, q1);
          tri(v00, v01, v11);
          setMid(0, n0, q0); setMid(1, n1, q1); setMid(2, n1, q0);
          tri(v00, v11, v10);
        }
      }
    }
  }
  return { positions: Float64Array.from(positions), indices: Uint32Array.from(indices), vertLeaf: Int32Array.from(vertLeaf) };
}
