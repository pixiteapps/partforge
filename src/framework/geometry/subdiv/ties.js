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

// How far a weight may stray outside [0, 1] (float rounding at a triangle's edge).
export const TIE_WEIGHT_SLACK = 1e-4;
// How far (mm) a vertex placed from its tie on the rest limit mesh may be from where it was delivered.
export const TIE_TOLERANCE = 1e-3;
// How far outside its triangle a vertex may lie, in float32 steps (ulps) of its largest
// coordinate. The delivered positions are float32: a vertex Manifold delivers at a corner or
// on an edge of its triangle can be rounded up to about 0.87 of a step outside it (half a
// step on each axis), and the plan's rest surface on the viewer side rounds as well. On a
// sliver triangle (a 0.06 mm edge on the cage hand's fingertips) that rounding alone is a
// weight about 1.1e-4 outside [0, 1], past TIE_WEIGHT_SLACK, though the vertex is less than
// 1e-5 mm from the triangle.
export const TIE_ROUNDING_ULPS = 2;
// The rounding allowance widens the weight slack only a little. A vertex it passes has a
// weight excess of at most TIE_ROUNDING_MAX_EXCESS, and that excess times its triangle's
// longest rest edge is at most TIE_ROUNDING_MAX_REACH (mm). Without both, a nearly
// degenerate triangle (a height near 1e-8 mm) could carry a weight near 1e3 within two steps,
// and a pose that fattens it would put the vertex millimetres away. At a new pose a vertex
// passed this way lies at most TIE_ROUNDING_MAX_REACH × (posed longest edge / rest longest
// edge) outside its triangle. Measured on the cage hand (each digit's curl over its whole
// range in 1° steps, 425 poses; 81 vertices in 10 poses take this rule): the worst excess
// is 1.259e-4, the worst excess × longest edge 1.043e-4 mm (pinky curl 90°), the worst
// distance outside 0.457 of a float32 step. The reach cap is 2.4 times that worst case, and
// tighter than what TIE_WEIGHT_SLACK alone already allows on a triangle over 2.5 mm.
export const TIE_ROUNDING_MAX_EXCESS = 1e-2;
export const TIE_ROUNDING_MAX_REACH = TIE_TOLERANCE / 4;

// One float32 step at magnitude `m` (the smallest normal step at 0).
const ulp32 = (m) => {
  const a = Math.fround(Math.abs(m));
  if (!(a >= 2 ** -126)) return 2 ** -149;
  return 2 ** (Math.floor(Math.log2(a)) - 23);
};

/**
 * Whether ties may be sent: every vertex placed from its tie on the rest limit mesh lands
 * within TIE_TOLERANCE of its delivered position, and the vertex lies in its triangle: all
 * three of its weights (w0, w1, 1 − w0 − w1) are within [−TIE_WEIGHT_SLACK,
 * 1 + TIE_WEIGHT_SLACK], or it lies outside the triangle by no more than float32 rounding
 * (TIE_ROUNDING_ULPS steps of its largest coordinate; the distance a weight puts it past an
 * edge is that weight's excess times the triangle's height over that edge), with its excess
 * at most TIE_ROUNDING_MAX_EXCESS and its excess times the longest rest edge at most
 * TIE_ROUNDING_MAX_REACH. A vertex
 * genuinely outside its triangle can still reproduce the rest position (a vertex Manifold
 * left on a near-coplanar neighbour of its triangle) but would extrapolate at a new pose.
 */
export function tiesHold(ties, positions, limitPositions, limitIndices) {
  const { w } = ties, lo = -TIE_WEIGHT_SLACK, hi = 1 + TIE_WEIGHT_SLACK;
  for (let v = 0; v < ties.tri.length; v++) {
    const w0 = w[2 * v], w1 = w[2 * v + 1], w2 = 1 - w0 - w1;
    if (w0 >= lo && w0 <= hi && w1 >= lo && w1 <= hi && w2 >= lo && w2 <= hi) continue;
    if (!withinRounding(ties.tri[v], [w0, w1, w2], positions, 3 * v, limitPositions, limitIndices)) return false;
  }
  return tieError(ties, positions, limitPositions, limitIndices) <= TIE_TOLERANCE;
}

// Is a vertex with weights `ws` on limit triangle `s` outside it by float32 rounding at most?
function withinRounding(s, ws, positions, o, P, I) {
  const c = [3 * I[3 * s], 3 * I[3 * s + 1], 3 * I[3 * s + 2]];
  const e1x = P[c[1]] - P[c[0]], e1y = P[c[1] + 1] - P[c[0] + 1], e1z = P[c[1] + 2] - P[c[0] + 2];
  const e2x = P[c[2]] - P[c[0]], e2y = P[c[2] + 1] - P[c[0] + 1], e2z = P[c[2] + 2] - P[c[0] + 2];
  const twoArea = Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
  if (!(twoArea > 0)) return false;
  const d01 = Math.hypot(e1x, e1y, e1z), d02 = Math.hypot(e2x, e2y, e2z);
  const d12 = Math.hypot(P[c[2]] - P[c[1]], P[c[2] + 1] - P[c[1] + 1], P[c[2] + 2] - P[c[1] + 2]);
  const edges = [d12, d02, d01];   // the edge opposite each corner
  const longest = Math.max(d01, d02, d12);
  const tol = TIE_ROUNDING_ULPS * ulp32(Math.max(Math.abs(positions[o]), Math.abs(positions[o + 1]), Math.abs(positions[o + 2])));
  for (let i = 0; i < 3; i++) {
    const excess = Math.max(-ws[i], ws[i] - 1);
    if (!(excess <= 0)) {
      if (!(excess <= TIE_ROUNDING_MAX_EXCESS) || !(excess * longest <= TIE_ROUNDING_MAX_REACH)) return false;
      // The triangle's height over the edge opposite corner i.
      const edge = edges[i];
      if (!(edge > 0) || !(excess * (twoArea / edge) <= tol)) return false;
    }
  }
  return true;
}
