// The subdivision surface: a cage snapshot turned into a smooth, closed triangle mesh by
// Catmull-Clark subdivision, every vertex then moved to its limit position. Plain
// JavaScript, no kernel. The cage is closed and all quads, so there are no boundary or
// crease rules, and every level after the first is all quads with only the cage's own
// points extraordinary.
//
// Point order is stable across levels: a step keeps the previous points at the same
// indices, then adds one point per face, then one per edge. So the cage's own points are
// indices 0..n-1 at every level, and their limit positions do not depend on the level.
// Face order is stable too: face f's four children are 4f..4f+3, so the cage face a
// level-L quad q comes from is q >> 2L.
//
// All levels lie on the same limit surface; a level changes only the facet size.

export const MIN_SUBDIV_LEVEL = 1;
export const MAX_SUBDIV_LEVEL = 5;
// The most triangles levelFor will choose a level for.
export const MAX_SUBDIV_TRIANGLES = 1_500_000;
// Chord error targets in mm: how far a facet may sit from the limit surface. With the
// estimate counting each triangle's diagonal, 0.02 mm put a 20 mm cube at the top level
// and left an ordinary extruded cage unmet; 0.05 mm is at or under a fine FDM layer's
// positional accuracy and typical STL export tolerances, and 0.2 mm keeps previews light.
// Measured starting values, to be revisited against the whale reference part.
export const SUBDIV_TOLERANCE = Object.freeze({ preview: 0.2, print: 0.05 });

const fail = (msg) => { throw new Error(`subdiv: ${msg}`); };

function checkLevel(levels) {
  if (!Number.isInteger(levels) || levels < MIN_SUBDIV_LEVEL || levels > MAX_SUBDIV_LEVEL) {
    fail(`level must be an integer from ${MIN_SUBDIV_LEVEL} to ${MAX_SUBDIV_LEVEL}, got ${levels}`);
  }
}

// A level's mesh. pos: 3V coordinates. faceVerts / faceEdges: 4F; edge k of a face joins
// its corners k and k+1. edgeVerts / edgeFaces: 2E (the cage is closed, so every edge has
// exactly two faces).
function fromSnapshot(snapshot) {
  const { points, faces } = snapshot ?? {};
  if (!Array.isArray(points) || !Array.isArray(faces) || faces.length === 0) {
    fail("expected a cage snapshot { points, faces }");
  }
  const V = points.length, F = faces.length;
  const pos = new Float64Array(3 * V);
  points.forEach((p, i) => {
    if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) fail(`point ${i} is not [x, y, z]`);
    pos.set(p, 3 * i);
  });
  const faceVerts = new Uint32Array(4 * F);
  const faceEdges = new Uint32Array(4 * F);
  const edgeIndex = new Map();
  const edgeVerts = [];
  faces.forEach((f, i) => {
    if (!Array.isArray(f) || f.length !== 4) fail(`face ${i} is not a quad`);
    for (let k = 0; k < 4; k++) {
      const v = f[k];
      if (!Number.isInteger(v) || v < 0 || v >= V) fail(`face ${i} names a missing point`);
      faceVerts[4 * i + k] = v;
    }
    for (let k = 0; k < 4; k++) {
      const a = f[k], b = f[(k + 1) % 4];
      if (a === b) fail(`face ${i} repeats a point`);
      const key = Math.min(a, b) * V + Math.max(a, b);
      let e = edgeIndex.get(key);
      if (e === undefined) {
        e = edgeVerts.length / 2;
        edgeIndex.set(key, e);
        edgeVerts.push(a, b);
      }
      faceEdges[4 * i + k] = e;
    }
  });
  const mesh = { V, F, E: edgeVerts.length / 2, pos, faceVerts, faceEdges, edgeVerts: Uint32Array.from(edgeVerts) };
  mesh.edgeFaces = edgeFacesOf(mesh, true);
  return mesh;
}

// The two faces of every edge, from faceEdges. `check` refuses an edge with other than two.
function edgeFacesOf({ F, E, faceEdges }, check) {
  const edgeFaces = new Uint32Array(2 * E);
  const count = new Uint8Array(E);
  for (let q = 0; q < 4 * F; q++) {
    const e = faceEdges[q];
    if (count[e] >= 2) fail("the cage is not a closed surface (an edge has more than two faces)");
    edgeFaces[2 * e + count[e]++] = q >> 2;
  }
  if (check) for (let e = 0; e < E; e++) if (count[e] !== 2) fail("the cage is not closed (an edge has one face)");
  return edgeFaces;
}

// One Catmull-Clark step.
function step(m) {
  const { V, F, E, pos, faceVerts, faceEdges, edgeVerts, edgeFaces } = m;
  const nV = V + F + E, nF = 4 * F, nE = 2 * E + 4 * F;
  const out = new Float64Array(3 * nV);

  // Face points.
  for (let f = 0; f < F; f++) {
    const o = 3 * (V + f);
    for (let k = 0; k < 4; k++) {
      const p = 3 * faceVerts[4 * f + k];
      out[o] += pos[p]; out[o + 1] += pos[p + 1]; out[o + 2] += pos[p + 2];
    }
    out[o] *= 0.25; out[o + 1] *= 0.25; out[o + 2] *= 0.25;
  }
  // Edge points: the mean of the two ends and the two face points.
  for (let e = 0; e < E; e++) {
    const o = 3 * (V + F + e);
    const a = 3 * edgeVerts[2 * e], b = 3 * edgeVerts[2 * e + 1];
    const f0 = 3 * (V + edgeFaces[2 * e]), f1 = 3 * (V + edgeFaces[2 * e + 1]);
    for (let c = 0; c < 3; c++) out[o + c] = (pos[a + c] + pos[b + c] + out[f0 + c] + out[f1 + c]) * 0.25;
  }
  // Vertex points: ((n - 2) v) / n + (Σ edge neighbours + Σ face points) / n².
  const valence = new Uint32Array(V);
  const acc = new Float64Array(3 * V);
  for (let e = 0; e < E; e++) {
    const a = edgeVerts[2 * e], b = edgeVerts[2 * e + 1];
    valence[a]++; valence[b]++;
    for (let c = 0; c < 3; c++) { acc[3 * a + c] += pos[3 * b + c]; acc[3 * b + c] += pos[3 * a + c]; }
  }
  for (let f = 0; f < F; f++) {
    const o = 3 * (V + f);
    for (let k = 0; k < 4; k++) {
      const v = 3 * faceVerts[4 * f + k];
      acc[v] += out[o]; acc[v + 1] += out[o + 1]; acc[v + 2] += out[o + 2];
    }
  }
  for (let v = 0; v < V; v++) {
    const n = valence[v];
    if (n === 0) fail(`point ${v} is used by no face`);
    const w = (n - 2) / n, s = 1 / (n * n);
    for (let c = 0; c < 3; c++) out[3 * v + c] = w * pos[3 * v + c] + s * acc[3 * v + c];
  }

  // Topology. Old edge e splits into 2e (from its first end) and 2e + 1 (to its second);
  // face f adds the inner edges 2E + 4f + k, from its point to the point of its edge k.
  const nEdgeVerts = new Uint32Array(2 * nE);
  for (let e = 0; e < E; e++) {
    const mid = V + F + e;
    nEdgeVerts[4 * e] = edgeVerts[2 * e]; nEdgeVerts[4 * e + 1] = mid;
    nEdgeVerts[4 * e + 2] = mid; nEdgeVerts[4 * e + 3] = edgeVerts[2 * e + 1];
  }
  const nFaceVerts = new Uint32Array(4 * nF);
  const nFaceEdges = new Uint32Array(4 * nF);
  for (let f = 0; f < F; f++) {
    const fp = V + f;
    for (let k = 0; k < 4; k++) {
      nEdgeVerts[2 * (2 * E + 4 * f + k)] = fp;
      nEdgeVerts[2 * (2 * E + 4 * f + k) + 1] = V + F + faceEdges[4 * f + k];
    }
    for (let k = 0; k < 4; k++) {
      const km = (k + 3) & 3;
      const v = faceVerts[4 * f + k], e = faceEdges[4 * f + k], ep = faceEdges[4 * f + km];
      const q = 4 * (4 * f + k);
      nFaceVerts[q] = v; nFaceVerts[q + 1] = V + F + e; nFaceVerts[q + 2] = fp; nFaceVerts[q + 3] = V + F + ep;
      nFaceEdges[q] = edgeVerts[2 * e] === v ? 2 * e : 2 * e + 1;
      nFaceEdges[q + 1] = 2 * E + 4 * f + k;
      nFaceEdges[q + 2] = 2 * E + 4 * f + km;
      nFaceEdges[q + 3] = edgeVerts[2 * ep] === v ? 2 * ep : 2 * ep + 1;
    }
  }
  const next = { V: nV, F: nF, E: nE, pos: out, faceVerts: nFaceVerts, faceEdges: nFaceEdges, edgeVerts: nEdgeVerts };
  next.edgeFaces = edgeFacesOf(next, false);
  return next;
}

// Limit positions: (n² v + 4 Σ edge neighbours + Σ face-diagonal neighbours) / (n (n + 5)).
// For valence 4 this is the bicubic B-spline mask 16, 4, 1 over 36.
function limit({ V, F, E, pos, faceVerts, edgeVerts }) {
  const valence = new Uint32Array(V);
  const edgeSum = new Float64Array(3 * V);
  const diagSum = new Float64Array(3 * V);
  for (let e = 0; e < E; e++) {
    const a = edgeVerts[2 * e], b = edgeVerts[2 * e + 1];
    valence[a]++; valence[b]++;
    for (let c = 0; c < 3; c++) { edgeSum[3 * a + c] += pos[3 * b + c]; edgeSum[3 * b + c] += pos[3 * a + c]; }
  }
  for (let f = 0; f < F; f++) {
    for (let k = 0; k < 4; k++) {
      const v = 3 * faceVerts[4 * f + k], d = 3 * faceVerts[4 * f + ((k + 2) & 3)];
      diagSum[v] += pos[d]; diagSum[v + 1] += pos[d + 1]; diagSum[v + 2] += pos[d + 2];
    }
  }
  const out = new Float64Array(3 * V);
  for (let v = 0; v < V; v++) {
    const n = valence[v], s = 1 / (n * (n + 5));
    for (let c = 0; c < 3; c++) out[3 * v + c] = (n * n * pos[3 * v + c] + 4 * edgeSum[3 * v + c] + diagSum[3 * v + c]) * s;
  }
  return out;
}

const dist2 = (p, a, b) => {
  const x = p[3 * a] - p[3 * b], y = p[3 * a + 1] - p[3 * b + 1], z = p[3 * a + 2] - p[3 * b + 2];
  return x * x + y * y + z * z;
};

export function subdivide(snapshot, levels) {
  checkLevel(levels);
  let m = fromSnapshot(snapshot);
  for (let l = 0; l < levels; l++) m = step(m);
  const positions = limit(m);
  const { F, faceVerts } = m;
  const indices = new Uint32Array(6 * F);
  const triFace = new Uint32Array(2 * F);
  const shift = 2 * levels;
  for (let f = 0; f < F; f++) {
    const a = faceVerts[4 * f], b = faceVerts[4 * f + 1], c = faceVerts[4 * f + 2], d = faceVerts[4 * f + 3];
    const o = 6 * f;
    if (dist2(positions, a, c) <= dist2(positions, b, d)) {
      indices[o] = a; indices[o + 1] = b; indices[o + 2] = c;
      indices[o + 3] = a; indices[o + 4] = c; indices[o + 5] = d;
    } else {
      indices[o] = a; indices[o + 1] = b; indices[o + 2] = d;
      indices[o + 3] = b; indices[o + 4] = c; indices[o + 5] = d;
    }
    triFace[2 * f] = triFace[2 * f + 1] = f >>> shift;
  }
  return { positions, indices, triFace };
}

// The chord error estimate at level L: how far the level-L triangles sit from the limit
// surface, measured along the surface normal at two kinds of sample:
//   - each edge: its limit midpoint against the limit of the edge's point at level L + 1;
//   - each quad: the midpoint of the diagonal `subdivide` splits it along (the shorter
//     one, on the limit positions) against the limit of the face's point at level L + 1.
//     The diagonal is the longest chord of the shipped triangles, so leaving it out
//     understates the error by about 1.4-1.7x.
// Only the normal part is surface error; the tangential part is the sample drifting
// along the surface, which near extraordinary points shrinks only with the subdominant
// eigenvalue. The normal at a fine face or edge point (both valence 4) is the sum of its
// four adjacent limit quads' normals (each the cross product of the quad's diagonals, so
// area-weighted), normalized. `next` is the level-L mesh stepped once.
function errorBetween(m, next) {
  const lim = limit(m), fine = limit(next);
  const { V, F, E, faceVerts, edgeVerts } = m;
  // In `next`, face points are V .. V + F - 1 and edge points V + F .. V + F + E - 1;
  // `normal` is indexed by (point - V).
  const count = F + E;
  const normal = new Float64Array(3 * count);
  const fv = next.faceVerts;
  for (let q = 0; q < next.F; q++) {
    const a = 3 * fv[4 * q], b = 3 * fv[4 * q + 1], c = 3 * fv[4 * q + 2], d = 3 * fv[4 * q + 3];
    const ux = fine[c] - fine[a], uy = fine[c + 1] - fine[a + 1], uz = fine[c + 2] - fine[a + 2];
    const vx = fine[d] - fine[b], vy = fine[d + 1] - fine[b + 1], vz = fine[d + 2] - fine[b + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (let k = 0; k < 4; k++) {
      const i = fv[4 * q + k] - V;
      if (i < 0 || i >= count) continue;
      normal[3 * i] += nx; normal[3 * i + 1] += ny; normal[3 * i + 2] += nz;
    }
  }
  // Normal distance from the midpoint of lim[a], lim[b] to fine point V + i.
  const deviation = (a, b, i) => {
    const nx = normal[3 * i], ny = normal[3 * i + 1], nz = normal[3 * i + 2];
    const nl = Math.hypot(nx, ny, nz);
    if (nl === 0) return 0;
    const p = 3 * (V + i);
    const dx = (lim[a] + lim[b]) * 0.5 - fine[p];
    const dy = (lim[a + 1] + lim[b + 1]) * 0.5 - fine[p + 1];
    const dz = (lim[a + 2] + lim[b + 2]) * 0.5 - fine[p + 2];
    return Math.abs(dx * nx + dy * ny + dz * nz) / nl;
  };
  let worst = 0;
  for (let e = 0; e < E; e++) {
    const d = deviation(3 * edgeVerts[2 * e], 3 * edgeVerts[2 * e + 1], F + e);
    if (d > worst) worst = d;
  }
  for (let f = 0; f < F; f++) {
    const a = faceVerts[4 * f], b = faceVerts[4 * f + 1], c = faceVerts[4 * f + 2], d = faceVerts[4 * f + 3];
    // The same diagonal choice as subdivide, ties to a-c.
    const diag = dist2(lim, a, c) <= dist2(lim, b, d) ? [a, c] : [b, d];
    const dev = deviation(3 * diag[0], 3 * diag[1], f);
    if (dev > worst) worst = dev;
  }
  return worst;
}

// An estimate that is not measured is extrapolated from the two before it with their own
// measured fall, clamped to 2..4 (a clean normal error falls about 4x per level, slower
// before the mesh settles): e[L] = e[L-1] / clamp(e[L-2] / e[L-1], 2, 4). With only one
// earlier value the fall is taken as 2, the cautious end.
const MIN_FALL = 2, MAX_FALL = 4;
function extrapolate(errors) {
  const last = errors[errors.length - 1];
  if (errors.length < 2 || !(last > 0)) return last / MIN_FALL;
  const fall = Math.min(MAX_FALL, Math.max(MIN_FALL, errors[errors.length - 2] / last));
  return last / fall;
}

// The estimates at levels 1, 2, ..., MAX_SUBDIV_LEVEL, one at a time so a caller can stop
// early. Measuring level L builds level L + 1. Level L is measured only when level L + 1
// may be built: L + 1 <= MAX_SUBDIV_LEVEL (never level 6) and its triangle count (2 x its
// quads) <= 4 x maxTriangles, i.e. at most one level past the highest level the triangle
// limit allows. From the first level that cannot be measured on, every level is
// extrapolated. Level 1 is always measured (level 2 of a cage of at most MAX_CAGE_FACES
// is 32,000 quads). For a 2,000-face cage at the default limit the largest mesh built is
// level 5, 2,048,000 quads.
function* estimates(snapshot, maxTriangles) {
  let m = step(fromSnapshot(snapshot));
  const errors = [];
  for (let level = MIN_SUBDIV_LEVEL; level <= MAX_SUBDIV_LEVEL; level++) {
    const canBuild = m !== null && (level === MIN_SUBDIV_LEVEL ||
      (level + 1 <= MAX_SUBDIV_LEVEL && triangleCount(snapshot, level + 1) <= 4 * maxTriangles));
    if (canBuild) {
      const next = step(m);
      errors.push(errorBetween(m, next));
      m = next;
    } else {
      m = null;
      errors.push(extrapolate(errors));
    }
    yield errors[level - 1];
  }
}

const triangleCount = (snapshot, level) => snapshot.faces.length * 2 * 4 ** level;

// The level's estimate; the value at MAX_SUBDIV_LEVEL is extrapolated, not measured.
export function chordError(snapshot, level) {
  checkLevel(level);
  fromSnapshot(snapshot);   // validates before snapshot.faces is read
  let l = 0;
  for (const error of estimates(snapshot, Infinity)) if (++l === level) return error;
  return fail("unreachable");
}

export function levelFor(snapshot, tolerance, { maxTriangles = MAX_SUBDIV_TRIANGLES } = {}) {
  if (typeof tolerance !== "number" || !(tolerance > 0)) fail(`tolerance must be a positive number of mm, got ${tolerance}`);
  if (typeof maxTriangles !== "number" || !(maxTriangles > 0)) fail(`maxTriangles must be a positive number, got ${maxTriangles}`);
  fromSnapshot(snapshot);   // validates before snapshot.faces is read
  // The highest level the triangle limit allows, at least MIN_SUBDIV_LEVEL.
  let cap = MIN_SUBDIV_LEVEL;
  while (cap < MAX_SUBDIV_LEVEL && triangleCount(snapshot, cap + 1) <= maxTriangles) cap++;
  let level = 0, error = 0;
  for (error of estimates(snapshot, maxTriangles)) {
    level++;
    if (error <= tolerance && triangleCount(snapshot, level) <= maxTriangles) return { level, error, met: true };
    if (level === cap) break;
  }
  return { level: cap, error, met: false };
}
