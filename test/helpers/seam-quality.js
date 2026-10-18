// test/helpers/seam-quality.js
// Seam-cleanliness measures for owner-meshed contact parts (the seam spec's "Testing"):
// flipped triangles against each triangle's own field, folded triangle pairs, and the
// gap a piece's shell keeps from another piece. All fields come from one full-decision
// program of the compiled tree, through evalBatchContact's shares.
import { fullDecision } from "../../src/framework/geometry/implicit/interval.js";
import { emitProgram, evalBatchContact } from "../../src/framework/geometry/implicit/program.js";
import { attachWeight, ATTACH_STRIDE } from "../../src/framework/geometry/implicit/contact.js";

const fullProgram = (compiled) => emitProgram(compiled, fullDecision(compiled), 0);

/** The field (`out`) and every child's share (`shares`, K per point) at the points. */
export function sharesAt(compiled, X, Y, Z) {
  const N = X.length, K = Math.max(1, compiled.ownerK), out = new Float64Array(N), shares = new Float64Array(N * K);
  if (compiled.ownerRoot >= 0) evalBatchContact(fullProgram(compiled), compiled.textures, X, Y, Z, out, { K, shares });
  else evalBatchContact(fullProgram(compiled), compiled.textures, X, Y, Z, out, { K });
  return { out, shares, K };
}

/** The contact child labelled `label` at the owner root (its child index). */
export function childIndex(compiled, label) {
  const node = compiled.ir.nodes[compiled.ownerRoot];
  const i = node.children.findIndex((id) => compiled.ir.nodes[id].label === label);
  if (i < 0) throw new Error(`no contact child labelled ${label}`);
  return i;
}

/**
 * Triangles whose field steps the wrong way across them: at the centroid c, with unit
 * normal n and ε = 0.03·edge, flipped when f(c + εn) < f(c − εn). f is the share of the
 * owner shared by the triangle's non-crease vertices if there is one, else the field.
 */
export function flippedTriangles(compiled, mesh, edge) {
  const { positions: P, indices: I, vertOwner = null, crease = null } = mesh;
  const T = I.length / 3, eps = 0.03 * edge;
  const X = new Float64Array(2 * T), Y = new Float64Array(2 * T), Z = new Float64Array(2 * T), own = new Int32Array(T).fill(-1);
  for (let t = 0; t < T; t++) {
    const a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const cx = (P[a] + P[b] + P[c]) / 3, cy = (P[a + 1] + P[b + 1] + P[c + 1]) / 3, cz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
    X[2 * t] = cx + eps * nx; Y[2 * t] = cy + eps * ny; Z[2 * t] = cz + eps * nz;
    X[2 * t + 1] = cx - eps * nx; Y[2 * t + 1] = cy - eps * ny; Z[2 * t + 1] = cz - eps * nz;
    if (vertOwner) {
      let o = -1, shared = true;
      for (let k = 0; k < 3; k++) {
        const v = I[3 * t + k];
        if (crease && crease[v]) continue;
        if (o === -1) o = vertOwner[v]; else if (vertOwner[v] !== o) shared = false;
      }
      if (shared) own[t] = o;
    }
  }
  const { out, shares, K } = sharesAt(compiled, X, Y, Z);
  const f = (q, o) => (o >= 0 && compiled.ownerRoot >= 0 ? shares[q * K + o] : out[q]);
  let flipped = 0;
  for (let t = 0; t < T; t++) if (f(2 * t, own[t]) < f(2 * t + 1, own[t])) flipped++;
  return flipped;
}

/**
 * Adjacent triangle pairs whose unit normals turn by more than 150° (dot below −0.866),
 * not counting pairs whose shared edge has both ends flagged in `mesh.crease`.
 */
export function seamFolds(mesh) {
  const { positions: P, indices: I, crease = null } = mesh;
  const T = I.length / 3, N = new Float64Array(3 * T);
  for (let t = 0; t < T; t++) {
    const a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nl > 0) { N[3 * t] = nx / nl; N[3 * t + 1] = ny / nl; N[3 * t + 2] = nz / nl; }
  }
  const byEdge = new Map(), nv = P.length / 3;
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) {
    const a = I[3 * t + k], b = I[3 * t + ((k + 1) % 3)];
    const key = Math.min(a, b) * nv + Math.max(a, b);
    const list = byEdge.get(key);
    if (list) list.push(t); else byEdge.set(key, [t]);
  }
  let folds = 0;
  for (const [key, list] of byEdge) {
    const a = Math.floor(key / nv), b = key - a * nv;
    if (crease && crease[a] && crease[b]) continue;
    for (let p = 0; p < list.length; p++) for (let q = p + 1; q < list.length; q++) {
      const s = list[p], t = list[q];
      if (N[3 * s] * N[3 * t] + N[3 * s + 1] * N[3 * t + 1] + N[3 * s + 2] * N[3 * t + 2] < -0.866) folds++;
    }
  }
  return folds;
}

/**
 * The gap child `a`'s shell keeps from child `b` (labels): over the vertices of the mesh
 * component holding a vertex owned by a, `min` is the least share of b, and
 * `maxFaceError` is max |share_b − gap| over that component's pinned vertices (NaN when
 * it has none, so a vacuous pass is impossible).
 */
export function pieceGapError(compiled, mesh, a, b, gap) {
  const { positions: P, indices: I, vertOwner, pinned } = mesh;
  const ia = childIndex(compiled, a), ib = childIndex(compiled, b), nv = P.length / 3;
  const parent = new Int32Array(nv).map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const used = new Uint8Array(nv);
  for (let t = 0; t < I.length; t += 3) {
    used[I[t]] = used[I[t + 1]] = used[I[t + 2]] = 1;
    const r = find(I[t]);
    for (let k = 1; k < 3; k++) { const s = find(I[t + k]); if (s !== r) parent[s] = r; }
  }
  let seed = -1;
  for (let v = 0; v < nv && seed < 0; v++) if (used[v] && vertOwner[v] === ia) seed = v;
  if (seed < 0) throw new Error(`no vertex owned by ${a}`);
  const root = find(seed), verts = [];
  for (let v = 0; v < nv; v++) if (used[v] && find(v) === root) verts.push(v);
  const X = Float64Array.from(verts, (v) => P[3 * v]), Y = Float64Array.from(verts, (v) => P[3 * v + 1]), Z = Float64Array.from(verts, (v) => P[3 * v + 2]);
  const { shares, K } = sharesAt(compiled, X, Y, Z);
  let min = Infinity, maxFaceError = -Infinity;
  verts.forEach((v, q) => {
    const s = shares[q * K + ib];
    if (s < min) min = s;
    if (pinned[v]) maxFaceError = Math.max(maxFaceError, Math.abs(s - gap));
  });
  return { min, maxFaceError: maxFaceError === -Infinity ? NaN : maxFaceError };
}

/** The weight, at (x, y, z), of the attachment between children X and Y (the largest, 0 if none). */
function pairWeightAt(att, X, Y, x, y, z) {
  let w = 0;
  for (let o = 0; o < att.length; o += ATTACH_STRIDE) {
    if ((att[o] === X && att[o + 1] === Y) || (att[o] === Y && att[o + 1] === X)) w = Math.max(w, attachWeight(att, o, x, y, z));
  }
  return w;
}

/**
 * Where a gap > 0 is held: each vertex's pieces are the children whose shares are within 1e-6 mm
 * of its least share (a blend ties its two pieces). `spans` counts triangles with corners of two
 * pieces that share none and are not attached at the centroid (weight 0): a triangle across a
 * gap outside the attachment zones. `shortfall` is the most any vertex of a single piece X comes
 * nearer than `gap` to another piece Y not attached to X at that vertex (max of gap − share_Y,
 * 0 when every gap holds).
 */
export function gapHolds(compiled, mesh, gap) {
  const P = mesh.positions, I = mesh.indices, nv = P.length / 3;
  const att = compiled.ir.nodes[compiled.ownerRoot].att;
  const X = new Float64Array(nv), Y = new Float64Array(nv), Z = new Float64Array(nv);
  for (let v = 0; v < nv; v++) { X[v] = P[3 * v]; Y[v] = P[3 * v + 1]; Z[v] = P[3 * v + 2]; }
  const { shares, K } = sharesAt(compiled, X, Y, Z);
  const pieces = [];
  for (let v = 0; v < nv; v++) {
    let m = Infinity;
    for (let k = 0; k < K; k++) m = Math.min(m, shares[v * K + k]);
    const s = [];
    for (let k = 0; k < K; k++) if (shares[v * K + k] - m <= 1e-6) s.push(k);
    pieces.push(s);
  }
  let spans = 0, shortfall = 0;
  for (let t = 0; t < I.length; t += 3) {
    const c = [0, 1, 2].map((k) => (P[3 * I[t] + k] + P[3 * I[t + 1] + k] + P[3 * I[t + 2] + k]) / 3);
    let bad = false;
    for (let a = 0; a < 3 && !bad; a++) for (let b = a + 1; b < 3 && !bad; b++) {
      const pa = pieces[I[t + a]], pb = pieces[I[t + b]];
      if (pa.some((x) => pb.includes(x))) continue;
      if (pa.some((x) => pb.some((y) => pairWeightAt(att, x, y, ...c) === 0))) bad = true;
    }
    if (bad) spans++;
  }
  for (let v = 0; v < nv; v++) {
    if (pieces[v].length !== 1) continue;
    const x = pieces[v][0];
    for (let y = 0; y < K; y++) {
      if (y === x || pairWeightAt(att, x, y, X[v], Y[v], Z[v]) > 0) continue;
      shortfall = Math.max(shortfall, gap - shares[v * K + y]);
    }
  }
  return { spans, shortfall };
}
