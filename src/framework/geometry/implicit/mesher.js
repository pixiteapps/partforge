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
    // edge midpoints (which depend only on the tet's corners and labels) are tested against the
    // inside → outside direction, so slivers whose crossings sit almost on a corner cannot flip.
    const tri = (a, b, c, ma, mb, mc, g) => {
      if (a === b || b === c || a === c) return;   // two crossings welded to one vertex
      const ux = mb[0] - ma[0], uy = mb[1] - ma[1], uz = mb[2] - ma[2];
      const vx = mc[0] - ma[0], vy = mc[1] - ma[1], vz = mc[2] - ma[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * g[0] + ny * g[1] + nz * g[2] < 0) indices.push(a, c, b); else indices.push(a, b, c);
    };
    const iEnd = Math.min(LEAF, n[0] - 1 - i0), jEnd = Math.min(LEAF, n[1] - 1 - j0), lEnd = Math.min(LEAF, n[2] - 1 - l0);
    for (let l = 0; l < lEnd; l++) for (let j = 0; j < jEnd; j++) for (let i = 0; i < iEnd; i++) {
      let neg = 0;
      for (let c = 0; c < 8; c++) if (at(i + (c & 1), j + ((c >> 1) & 1), l + ((c >> 2) & 1)) < 0) neg++;
      if (neg === 0 || neg === 8) continue;
      const cornerPos = (c) => posOf(i + (c & 1), j + ((c >> 1) & 1), l + ((c >> 2) & 1));
      const mid = (ca, cb) => {
        const pa = cornerPos(ca), pb = cornerPos(cb);
        return [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
      };
      for (const tet of KUHN) {
        const negC = [], posC = [];
        for (let q = 0; q < 4; q++) {
          const c = tet[q];
          (at(i + (c & 1), j + ((c >> 1) & 1), l + ((c >> 2) & 1)) < 0 ? negC : posC).push(c);
        }
        const inside = negC.length;
        if (inside === 0 || inside === 4) continue;
        const cn = negC.map(cornerPos), cp = posC.map(cornerPos), g = [0, 0, 0];
        for (let a = 0; a < 3; a++) {
          let sn = 0, sp = 0;
          for (const p of cn) sn += p[a];
          for (const p of cp) sp += p[a];
          g[a] = sp / cp.length - sn / cn.length;   // inside → outside
        }
        if (inside === 1 || inside === 3) {
          const lone = inside === 1 ? negC[0] : posC[0], others = inside === 1 ? posC : negC;
          tri(vertexOn(i, j, l, lone, others[0]), vertexOn(i, j, l, lone, others[1]), vertexOn(i, j, l, lone, others[2]),
            mid(lone, others[0]), mid(lone, others[1]), mid(lone, others[2]), g);
        } else {
          const [n0, n1] = negC, [q0, q1] = posC;
          const v00 = vertexOn(i, j, l, n0, q0), v01 = vertexOn(i, j, l, n0, q1), v10 = vertexOn(i, j, l, n1, q0), v11 = vertexOn(i, j, l, n1, q1);
          const m00 = mid(n0, q0), m01 = mid(n0, q1), m10 = mid(n1, q0), m11 = mid(n1, q1);
          tri(v00, v01, v11, m00, m01, m11, g);
          tri(v00, v11, v10, m00, m11, m10, g);
        }
      }
    }
  }
  return { positions: Float64Array.from(positions), indices: Uint32Array.from(indices), vertLeaf: Int32Array.from(vertLeaf) };
}
