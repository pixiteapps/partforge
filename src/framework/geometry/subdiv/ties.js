// Ties: each delivered vertex of a k.subdiv body, tied to the smooth surface it lies on
// (docs/superpowers/specs/2026-11-22-cage-pose-drag-design.md, "Spike result (Task 10)",
// layout A). A tie is a limit triangle (an index into the limit mesh's `indices`, triangle
// t being indices[3t .. 3t + 2]) and the vertex's rest position in barycentric
// coordinates of that triangle. A viewer that recomputes the limit mesh from moved cage
// points (subdivPlan / applySubdivPlan, same snapshot, same triangle order) moves every
// vertex with no kernel: x = w0·A + w1·B + (1 − w0 − w1)·C.
//
// The weights are exact for a vertex of a skin triangle: Manifold keeps the input faceID
// (the limit triangle's index) on every piece of a cut triangle, and a piece lies in the
// plane of its source triangle. A vertex of a non-skin triangle (a cut cap) is tied only
// when it sits exactly on a skin vertex (the seam loop), and then takes that vertex's tie.
//
// Pure: no kernel, no DOM.

// Two weights per vertex: for corners A and B of its limit triangle (C's is 1 − w0 − w1).
export const TIE_WEIGHTS = 2;

// A hash of a vertex's three float32 bit patterns (equality is checked after a hit).
const hash3 = (b, i) => (Math.imul(b[i], 73856093) ^ Math.imul(b[i + 1], 19349663) ^ Math.imul(b[i + 2], 83492791)) >>> 0;

/**
 * Ties for a non-indexed delivered mesh.
 * @param {object} a
 * @param {Float32Array} a.positions   the delivered positions, 3 per vertex, 3 vertices per triangle
 * @param {Int32Array} a.faceTri       per delivered triangle: its limit triangle, or -1 when it is not skin
 * @param {ArrayLike<number>} a.limitPositions  the rest limit mesh's positions
 * @param {ArrayLike<number>} a.limitIndices    the rest limit mesh's triangles
 * @returns {{ tri: Uint32Array, w: Float32Array, untied: number }} per delivered vertex
 *   (`n` = positions.length / 3); an untied vertex has tri 0 and weights 0.
 */
export function tiesFor({ positions, faceTri, limitPositions: P, limitIndices: I }) {
  const n = (positions.length / 3) | 0, nTri = (n / 3) | 0, nLimit = (I.length / 3) | 0;
  const tri = new Uint32Array(n), w = new Float32Array(TIE_WEIGHTS * n), tied = new Uint8Array(n);
  let others = 0;
  for (let t = 0; t < nTri; t++) {
    const s = faceTri[t];
    if (!(s >= 0 && s < nLimit)) { others += 3; continue; }
    const a = 3 * I[3 * s], b = 3 * I[3 * s + 1], c = 3 * I[3 * s + 2];
    const ax = P[a], ay = P[a + 1], az = P[a + 2];
    const e1x = P[b] - ax, e1y = P[b + 1] - ay, e1z = P[b + 2] - az;
    const e2x = P[c] - ax, e2y = P[c + 1] - ay, e2z = P[c + 2] - az;
    const d11 = e1x * e1x + e1y * e1y + e1z * e1z, d12 = e1x * e2x + e1y * e2y + e1z * e2z, d22 = e2x * e2x + e2y * e2y + e2z * e2z;
    const den = d11 * d22 - d12 * d12;
    if (!(den > 0)) { others += 3; continue; }   // a degenerate limit triangle ties nothing
    for (let k = 0; k < 3; k++) {
      const v = 3 * t + k, o = 3 * v;
      const px = positions[o] - ax, py = positions[o + 1] - ay, pz = positions[o + 2] - az;
      const p1 = px * e1x + py * e1y + pz * e1z, p2 = px * e2x + py * e2y + pz * e2z;
      const u = (d22 * p1 - d12 * p2) / den, vv = (d11 * p2 - d12 * p1) / den;   // B's and C's weights
      tri[v] = s; w[2 * v] = 1 - u - vv; w[2 * v + 1] = u; tied[v] = 1;
    }
  }
  if (others === 0) return { tri, w, untied: 0 };
  // The seam: a non-skin vertex at exactly a skin vertex's position takes that tie.
  const f = positions instanceof Float32Array ? positions : Float32Array.from(positions);
  const bits = new Uint32Array(f.buffer, f.byteOffset, f.length);
  const waiting = new Map();   // hash -> non-skin vertices with that hash
  // Their box: a skin vertex outside it cannot be one of them (skipped without a hash).
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  let untied = 0;
  for (let v = 0; v < n; v++) {
    if (tied[v]) continue;
    untied++;
    const o = 3 * v, x = f[o], y = f[o + 1], z = f[o + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
    const key = hash3(bits, o);
    const list = waiting.get(key);
    if (list) list.push(v); else waiting.set(key, [v]);
  }
  for (let v = 0; v < n && untied > 0; v++) {
    if (tied[v] !== 1) continue;   // a skin vertex only (2: a seam vertex tied here)
    const o = 3 * v, x = f[o], y = f[o + 1], z = f[o + 2];
    if (x < x0 || x > x1 || y < y0 || y > y1 || z < z0 || z > z1) continue;
    const list = waiting.get(hash3(bits, o));
    if (!list) continue;
    for (let i = list.length - 1; i >= 0; i--) {
      const u = list[i];
      if (bits[3 * u] !== bits[3 * v] || bits[3 * u + 1] !== bits[3 * v + 1] || bits[3 * u + 2] !== bits[3 * v + 2]) continue;
      tri[u] = tri[v]; w[2 * u] = w[2 * v]; w[2 * u + 1] = w[2 * v + 1]; tied[u] = 2;
      list[i] = list[list.length - 1]; list.pop();
      untied--;
    }
  }
  return { tri, w, untied };
}

/**
 * Every vertex placed from its tie on a limit mesh (`limitPositions` at rest or at a new
 * pose; `limitIndices` the same triangles the ties were made against).
 * @returns {Float32Array} 3 per vertex (`out` when given)
 */
export function placeFromTies({ tri, w }, limitPositions, limitIndices, out = new Float32Array(3 * tri.length)) {
  const P = limitPositions, I = limitIndices;
  for (let v = 0; v < tri.length; v++) {
    const s = tri[v], a = 3 * I[3 * s], b = 3 * I[3 * s + 1], c = 3 * I[3 * s + 2];
    const w0 = w[2 * v], w1 = w[2 * v + 1], w2 = 1 - w0 - w1, o = 3 * v;
    out[o] = w0 * P[a] + w1 * P[b] + w2 * P[c];
    out[o + 1] = w0 * P[a + 1] + w1 * P[b + 1] + w2 * P[c + 1];
    out[o + 2] = w0 * P[a + 2] + w1 * P[b + 2] + w2 * P[c + 2];
  }
  return out;
}

/** The largest distance (mm) between a vertex placed from its tie on the rest limit mesh and its delivered position. */
export function tieError({ tri, w }, positions, limitPositions, limitIndices) {
  const P = limitPositions, I = limitIndices;
  let worst = 0;   // squared
  for (let v = 0; v < tri.length; v++) {
    const s = tri[v], a = 3 * I[3 * s], b = 3 * I[3 * s + 1], c = 3 * I[3 * s + 2];
    const w0 = w[2 * v], w1 = w[2 * v + 1], w2 = 1 - w0 - w1, o = 3 * v;
    const dx = w0 * P[a] + w1 * P[b] + w2 * P[c] - positions[o];
    const dy = w0 * P[a + 1] + w1 * P[b + 1] + w2 * P[c + 1] - positions[o + 1];
    const dz = w0 * P[a + 2] + w1 * P[b + 2] + w2 * P[c + 2] - positions[o + 2];
    const d = dx * dx + dy * dy + dz * dz;
    if (!(d <= worst)) { if (Number.isNaN(d)) return Infinity; worst = d; }
  }
  return Math.sqrt(worst);
}
