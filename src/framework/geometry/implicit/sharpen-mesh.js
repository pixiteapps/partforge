// src/framework/geometry/implicit/sharpen-mesh.js
// The sharpen pass's mesh tools (sharpen.js): field reads, adjacency, subdivision and the
// checks every change passes. Native-portable arithmetic only (js-math.js), for the core port.
import { evalBatch } from "./program.js";
import { hypot3 } from "../js-math.js";
import { DIFF, FLIP_NEAR, MIN_ALTITUDE } from "./sharpen.js";

// The field at the points, each evaluated with its leaf's program (crease.js's evalPoints).
export function evalField(store, pts, leafOf) {
  const n = pts.length / 3, d = new Float64Array(n), groups = new Map();
  for (let q = 0; q < n; q++) {
    const g = groups.get(leafOf[q]);
    if (g) g.push(q); else groups.set(leafOf[q], [q]);
  }
  for (const [L, qs] of groups) {
    const m = qs.length, X = new Float64Array(m), Y = new Float64Array(m), Z = new Float64Array(m), out = new Float64Array(m);
    qs.forEach((q, i) => { X[i] = pts[3 * q]; Y[i] = pts[3 * q + 1]; Z[i] = pts[3 * q + 2]; });
    evalBatch(store.leaves[L].prog, store.textures, X, Y, Z, out);
    qs.forEach((q, i) => { d[q] = out[i]; });
  }
  return d;
}

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const det3 = (a, b, c) => a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
export const unit = (v) => { const l = hypot3(v[0], v[1], v[2]); return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : null; };

// The mesh's adjacency, from one counting sort: `fan.get(v)`, v's triangles in index order;
// `byEdge.get(key)`, the triangles on an edge (those of its lower end's fan that hold the other
// end; key as ekey's, lo·nv + hi); `first(t, lo, hi)`, whether triangle t is the first to name
// that edge (no earlier triangle of lo's fan holds hi).
export function adjacency(T, nv) {
  const nt = T.length / 3, off = new Int32Array(nv + 1), tri = new Int32Array(T.length), memo = new Map();
  for (let i = 0; i < T.length; i++) off[T[i] + 1]++;
  for (let v = 0; v < nv; v++) off[v + 1] += off[v];
  const at = off.slice(0, nv);
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) tri[at[T[3 * t + k]]++] = t;
  const holds = (t, v) => T[3 * t] === v || T[3 * t + 1] === v || T[3 * t + 2] === v;
  const fan = { get: (v) => tri.subarray(off[v], off[v + 1]) };
  const byEdge = {
    get: (key) => {
      let r = memo.get(key);
      if (r) return r;
      // PORTED: a 64-bit integer key and integer division in the core.
      const lo = Math.floor(key / nv), hi = key - lo * nv;
      r = [];
      for (let i = off[lo]; i < off[lo + 1]; i++) if (holds(tri[i], hi)) r.push(tri[i]);
      memo.set(key, r);
      return r;
    },
  };
  const first = (t, lo, hi) => {
    for (let i = off[lo]; i < off[lo + 1] && tri[i] < t; i++) if (holds(tri[i], hi)) return false;
    return true;
  };
  return { fan, byEdge, first };
}

// Triangle t of T, split at `splitOf`'s points, appended to `out`: 1, 2, 3 or 4 triangles. One
// left with a repeated vertex (two of its edges split at one shared corner point) is dropped.
export function subdivide(T, t, splitOf, ekey, out) {
  const cut = (a, b) => { const v = splitOf.get(ekey(a, b)); return v === undefined ? -1 : v; };
  const v = [T[3 * t], T[3 * t + 1], T[3 * t + 2]], s = [cut(v[0], v[1]), cut(v[1], v[2]), cut(v[2], v[0])];
  const n = (s[0] >= 0) + (s[1] >= 0) + (s[2] >= 0);
  const put = (a, b, c) => { if (a !== b && b !== c && c !== a) out.push(a, b, c); };
  if (n === 0) { out.push(v[0], v[1], v[2]); return; }
  if (n === 3) { put(v[0], s[0], s[2]); put(v[1], s[1], s[0]); put(v[2], s[2], s[1]); put(s[0], s[1], s[2]); return; }
  let r = 0;
  if (n === 1) while (s[r] < 0) r++;
  else while (!(s[r] >= 0 && s[(r + 2) % 3] >= 0)) r++;
  const A = v[r], B = v[(r + 1) % 3], C = v[(r + 2) % 3], sAB = s[r], sCA = s[(r + 2) % 3];
  if (n === 1) { put(A, sAB, C); put(sAB, B, C); }
  else { put(A, sAB, sCA); put(sAB, B, C); put(sAB, C, sCA); }
}

// "flip" (a triangle against the sum of its corners' normals), "sliver" (an altitude under
// MIN_ALTITUDE) or null, over the triangles `tris` of T become when split at `splitOf`.
export function checkTris(T, tris, splitOf, ekey, P, N) {
  const out = [];
  for (const t of tris) subdivide(T, t, splitOf, ekey, out);
  for (let i = 0; i < out.length; i += 3) {
    const n = triNormal(P, out[i], out[i + 1], out[i + 2]);
    if (n === null) return "sliver";
    const a = 3 * out[i], b = 3 * out[i + 1], c = 3 * out[i + 2];
    if (n[0] * (N[a] + N[b] + N[c]) + n[1] * (N[a + 1] + N[b + 1] + N[c + 1]) + n[2] * (N[a + 2] + N[b + 2] + N[c + 2]) < 0) return "flip";
  }
  return null;
}

// The triangle's (unnormalized) normal, or null when an altitude is under MIN_ALTITUDE.
function triNormal(P, i, j, k) {
  const a = 3 * i, b = 3 * j, c = 3 * k;
  const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], w = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
  const x = [P[c] - P[b], P[c + 1] - P[b + 1], P[c + 2] - P[b + 2]];
  const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const longest = Math.sqrt(Math.max(dot(u, u), dot(w, w), dot(x, x)));
  return longest > 0 && hypot3(n[0], n[1], n[2]) >= MIN_ALTITUDE * longest ? n : null;
}

// The changed triangles (ids in T) one of whose parts faces against the field at its centre:
// the field falls from FLIP_NEAR·edge behind the part to FLIP_NEAR·edge in front of it, or from
// DIFF·edge behind to DIFF·edge in front, read with its first corner's leaf program. The near
// pair sees a centre that sits on a crease of a rough field (a knurl), where a face just past
// the crease runs the other way; the far pair sees past noise in the field.
// With `memo` (a Map kept across a commit loop's rounds) and `S.how`, a triangle changed by the
// same candidates, each in the same way (`S.how`: the end it moved, or −1 for a split), as in an
// earlier round has the same final form and is not read again.
export function fieldFlips(store, S, tris, { VL0, T, ekey, edge }, memo = null) {
  const e = DIFF * edge, en = FLIP_NEAR * edge, owner = [], pts = [], lf = [], fresh = [], known = new Set();
  const same = (x, y) => x.length === y.length && x.every((c, i) => c === y[i]);
  for (const t of tris) {
    const by = S.touched.get(t), m = S.how ? memo?.get(t) : null;
    if (m && same(m.by, by) && same(m.how, S.how.get(t))) { if (m.bad) known.add(t); continue; }
    fresh.push(t);
    const out = [], P = S.P;
    subdivide(T, t, S.splitOf, ekey, out);
    for (let i = 0; i < out.length; i += 3) {
      const n = triNormal(P, out[i], out[i + 1], out[i + 2]), u = n && unit(n);
      if (!u) continue;
      const a = 3 * out[i], b = 3 * out[i + 1], c = 3 * out[i + 2];
      const cx = (P[a] + P[b] + P[c]) / 3, cy = (P[a + 1] + P[b + 1] + P[c + 1]) / 3, cz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
      pts.push(cx + e * u[0], cy + e * u[1], cz + e * u[2], cx - e * u[0], cy - e * u[1], cz - e * u[2]);
      pts.push(cx + en * u[0], cy + en * u[1], cz + en * u[2], cx - en * u[0], cy - en * u[1], cz - en * u[2]);
      for (let k = 0; k < 4; k++) lf.push(VL0[T[3 * t]]);
      owner.push(t);
    }
  }
  const d = evalField(store, Float64Array.from(pts), lf), flipped = new Set();
  owner.forEach((t, q) => { if (d[4 * q] - d[4 * q + 1] < 0 || d[4 * q + 2] - d[4 * q + 3] < 0) flipped.add(t); });
  if (memo && S.how) for (const t of fresh) memo.set(t, { by: S.touched.get(t).slice(), how: S.how.get(t).slice(), bad: flipped.has(t) });
  return tris.filter((t) => known.has(t) || flipped.has(t));
}
