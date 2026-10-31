// src/framework/geometry/implicit/mesher.js
// Marching tetrahedra over the sparse store: each leaf's cells are split into the
// six Kuhn tetrahedra (face-consistent, so the surface closes), crossings are
// welded per grid edge (key = lowCorner·8 + direction bits) and interpolated low → high
// so equal crossings get equal coordinates. There is no vertex snapping: a shared snapped
// vertex merges crossings and breaks manifoldness on thin features, so the mesh is closed
// by construction; short-edge slivers are left to cleanup.
import { LEAF } from "./sparse.js";

export const KUHN = [[0, 1, 3, 7], [0, 1, 5, 7], [0, 2, 3, 7], [0, 2, 6, 7], [0, 4, 5, 7], [0, 4, 6, 7]];

/**
 * The plain marching-tetrahedra emitter both meshers share: welded grid-edge vertices and
 * topologically oriented triangles, one leaf at a time. `onVertex(v, sLo, sHi, gLo, dir, loInside)`
 * (optional) hears of each new edge vertex: its leaf-local low/high sample indices, the low
 * grid point's index, the edge direction bits and whether the low end is inside.
 * Use: setLeaf(L), then per cell cellNeg(i, j, l) → corners(i, j, l) → tet(i, j, l, KUHN[t]).
 */
export function tetMesher(store, onVertex = null) {
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
  let L = -1, i0 = 0, j0 = 0, l0 = 0, vals = null;
  const at = (i, j, l) => vals[(l * S + j) * S + i];
  // Corner c of cell (i, j, l): offset bits (c & 1, c >> 1 & 1, c >> 2 & 1).
  const vertexOn = (i, j, l, ca, cb) => {
    const lo = ca & cb, dir = ca ^ cb;               // Kuhn edges run low → high along monotone bits
    const hi = lo | dir;
    const li = i + (lo & 1), lj = j + ((lo >> 1) & 1), ll = l + ((lo >> 2) & 1);
    const hi_i = i + (hi & 1), hi_j = j + ((hi >> 1) & 1), hi_l = l + ((hi >> 2) & 1);
    const a = at(li, lj, ll), b = at(hi_i, hi_j, hi_l);
    const gLo = gIndex(i0 + li, j0 + lj, l0 + ll), key = gLo * 8 + dir;
    let v = edgeVerts.get(key);
    if (v !== undefined) return v;
    const t = a / (a - b);
    const pax = origin[0] + (i0 + li) * edge, pay = origin[1] + (j0 + lj) * edge, paz = origin[2] + (l0 + ll) * edge;
    const pbx = origin[0] + (i0 + hi_i) * edge, pby = origin[1] + (j0 + hi_j) * edge, pbz = origin[2] + (l0 + hi_l) * edge;
    v = positions.length / 3;
    positions.push(pax + (pbx - pax) * t, pay + (pby - pay) * t, paz + (pbz - paz) * t);
    vertLeaf.push(L);
    edgeVerts.set(key, v);
    if (onVertex !== null) onVertex(v, (ll * S + lj) * S + li, (hi_l * S + hi_j) * S + hi_i, gLo, dir, a < 0);
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
  return {
    positions, indices, vertLeaf, CP, gIndex, vertexOn,
    /** The current leaf's grid offset. */
    get i0() { return i0; }, get j0() { return j0; }, get l0() { return l0; },
    setLeaf(k) {
      L = k;
      ({ i0, j0, l0, vals } = leaves[k]);
    },
    /** The current leaf's cell range: [iEnd, jEnd, lEnd]. */
    ends: () => [Math.min(LEAF, n[0] - 1 - i0), Math.min(LEAF, n[1] - 1 - j0), Math.min(LEAF, n[2] - 1 - l0)],
    /** How many of cell (i, j, l)'s corners are inside. */
    cellNeg(i, j, l) {
      let neg = 0;
      for (let c = 0; c < 8; c++) if (at(i + (c & 1), j + ((c >> 1) & 1), l + ((c >> 2) & 1)) < 0) neg++;
      return neg;
    },
    /** Fills CP with cell (i, j, l)'s corner positions. */
    corners(i, j, l) {
      for (let c = 0; c < 8; c++) {   // corner positions, as posOf computes them
        CP[3 * c] = origin[0] + (i0 + (i + (c & 1))) * edge;
        CP[3 * c + 1] = origin[1] + (j0 + (j + ((c >> 1) & 1))) * edge;
        CP[3 * c + 2] = origin[2] + (l0 + (l + ((c >> 2) & 1))) * edge;
      }
    },
    /** Plain marching tetrahedra on the field for one Kuhn tet of the cell whose corners are in CP. */
    tet(i, j, l, tet) {
      let nn = 0, np = 0;
      for (let q = 0; q < 4; q++) {
        const c = tet[q];
        if (at(i + (c & 1), j + ((c >> 1) & 1), l + ((c >> 2) & 1)) < 0) negC[nn++] = c; else posC[np++] = c;
      }
      if (nn === 0 || nn === 4) return;
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
    },
  };
}

export function meshStore(store) {
  const m = tetMesher(store);
  for (let L = 0; L < store.leaves.length; L++) {
    m.setLeaf(L);
    const [iEnd, jEnd, lEnd] = m.ends();
    for (let l = 0; l < lEnd; l++) for (let j = 0; j < jEnd; j++) for (let i = 0; i < iEnd; i++) {
      const neg = m.cellNeg(i, j, l);
      if (neg === 0 || neg === 8) continue;
      m.corners(i, j, l);
      for (const tet of KUHN) m.tet(i, j, l, tet);
    }
  }
  return { positions: Float64Array.from(m.positions), indices: Uint32Array.from(m.indices), vertLeaf: Int32Array.from(m.vertLeaf) };
}
