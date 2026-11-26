// SPIKE (phase 2): can the implicit mesh keep a solid leaf's sharp edges by itself?
// A post-pass on the finished mesh, in the shape of crease.js's cut: each mesh edge
// whose two ends have field normals more than ANGLE apart is split at the point where
// the two ends' tangent planes meet (nearest the edge's middle), if the field is zero
// there. Triangles with 1, 2 or 3 split edges become 2, 3 or 4.
// node spike/exact-faces/sharpen.mjs
import { bootManifoldKernel } from "../../src/testing/manifold.js";
import { buildMeshField } from "../../src/framework/geometry/implicit/mesh-field-build.js";
import { meshDistance } from "../../src/framework/geometry/implicit/mesh-field.js";
import { implicitDistance } from "../../src/framework/geometry/implicit/distance.js";

const k = await bootManifoldKernel({ quality: "preview", meshFields: true });
const leaf = (s) => ({ kind: "solid", solid: s });
const ANGLE = 25, TOL = 0.05, MAX_MOVE = 1.5, H = 1e-4;
const cosA = Math.cos(ANGLE * Math.PI / 180);

const CASES = {
  "plate-edge": { k: 8, a: () => k.box({ min: [-30, -20, 0], max: [30, 20, 6] }), b: () => k.cylinder({ r: 8, h: 26 }).at([20, 0, 4]),
    reach: [[4, -16, -8], [36, 16, 38]] },
  "bracket-corner": { k: 6, a: () => k.box({ min: [-30, -20, 0], max: [30, 20, 6] }).union(k.box({ min: [-30, -20, 0], max: [-24, 20, 30] })),
    b: () => k.cylinder({ r: 5, h: 20 }).at([-14, 0, 4]), reach: [[-25, -11, -6], [-3, 11, 30]] },
  "cylinder-side": { k: 4, a: () => k.cylinder({ r: 12, h: 40 }), b: () => k.box({ min: [8, -4, 16], max: [22, 4, 24] }),
    reach: [[3, -9, 11], [28, 9, 29]] },
};
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const mx = (xs) => xs.reduce((m, x) => (x > m ? x : m), 0);
const pct = (xs, q) => { if (!xs.length) return 0; const s = Float64Array.from(xs).sort(); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const r4 = (x) => +x.toFixed(4);

function weld(m) {
  const P = m.positions, I = m.indices, n = (I ? I.length : P.length / 3);
  const key = new Map(), V = [], T = [];
  for (let j = 0; j < n; j++) {
    const i = (I ? I[j] : j) * 3, s = `${P[i] + 0},${P[i + 1] + 0},${P[i + 2] + 0}`;
    let v = key.get(s);
    if (v === undefined) { v = V.length; V.push([P[i], P[i + 1], P[i + 2]]); key.set(s, v); }
    T.push(v);
  }
  return { V, T };
}

// Split every triangle by `cut(a, b)` → new vertex id or −1. Triangles that end with a
// repeated vertex (two cuts merged to one corner point) are dropped.
function subdivide(T, cut) {
  const out = [];
  const push = (...ids) => { for (let i = 0; i < ids.length; i += 3) if (ids[i] !== ids[i + 1] && ids[i + 1] !== ids[i + 2] && ids[i] !== ids[i + 2]) out.push(ids[i], ids[i + 1], ids[i + 2]); };
  for (let t = 0; t < T.length; t += 3) {
    const v = [T[t], T[t + 1], T[t + 2]], s = [cut(v[0], v[1]), cut(v[1], v[2]), cut(v[2], v[0])];
    const n = s.filter((x) => x >= 0).length;
    if (n === 0) { push(...v); continue; }
    if (n === 3) { push(v[0], s[0], s[2], v[1], s[1], s[0], v[2], s[2], s[1], s[0], s[1], s[2]); continue; }
    let r = 0;
    if (n === 1) while (s[r] < 0) r++;
    else while (!(s[r] >= 0 && s[(r + 2) % 3] >= 0)) r++;
    const A = v[r], B = v[(r + 1) % 3], C = v[(r + 2) % 3], sAB = s[r], sCA = s[(r + 2) % 3];
    if (n === 1) push(A, sAB, C, sAB, B, C);
    else push(A, sAB, sCA, sAB, B, C, sAB, C, sCA);
  }
  return out;
}

function sharpen({ V, T }, f, E) {
  const grad = (p) => {
    const g = [f(p[0] + H, p[1], p[2]) - f(p[0] - H, p[1], p[2]), f(p[0], p[1] + H, p[2]) - f(p[0], p[1] - H, p[2]), f(p[0], p[1], p[2] + H) - f(p[0], p[1], p[2] - H)];
    const l = len(g) || 1; return [g[0] / l, g[1] / l, g[2] / l];
  };
  // Each vertex's tangent planes: one for a mesher vertex, two for a crease point.
  const planes = V.map((p) => [{ n: grad(p), p }]);
  const stats = { tried: 0, kept: 0, offField: 0, tooFar: 0, cornerTried: 0, cornerKept: 0 };
  const memo = (fn) => { const m = new Map(); return (a, b) => { const key = a < b ? a * 4194304 + b : b * 4194304 + a; if (!m.has(key)) m.set(key, fn(a, b)); return m.get(key); }; };
  // Pass 1: creases, on edges between two mesher vertices.
  const T1 = subdivide(T, memo((a, b) => {
    const A = planes[a][0], B = planes[b][0], c = dot(A.n, B.n);
    if (c >= cosA) return -1;
    stats.tried++;
    const m = [0, 1, 2].map((i) => (V[a][i] + V[b][i]) / 2);
    const ra = -dot(A.n, sub(m, A.p)), rb = -dot(B.n, sub(m, B.p)), det = 1 - c * c;
    const al = (ra - c * rb) / det, be = (rb - c * ra) / det;
    const p = [0, 1, 2].map((i) => m[i] + al * A.n[i] + be * B.n[i]);
    if (len(sub(p, m)) > MAX_MOVE * E) { stats.tooFar++; return -1; }
    if (Math.abs(f(p[0], p[1], p[2])) > TOL * E) { stats.offField++; return -1; }
    V.push(p); planes.push([A, B]); stats.kept++;
    return V.length - 1;
  }));
  if (process.env.NO_CORNERS) return { V, T: T1, stats };
  // Pass 2: corners. An edge whose two ends see three distinct planes between them is
  // split at the point where the three meet. Corner points are shared by position.
  const corners = new Map();
  const T2 = subdivide(T1, memo((a, b) => {
    const set = [];
    for (const q of [...planes[a], ...planes[b]]) if (!set.some((o) => dot(o.n, q.n) >= cosA)) set.push(q);
    if (set.length !== 3 || planes[a].length + planes[b].length < 3) return -1;
    stats.cornerTried++;
    const [n0, n1, n2] = set.map((q) => q.n), d = set.map((q) => dot(q.n, q.p));
    const c12 = cross(n1, n2), c20 = cross(n2, n0), c01 = cross(n0, n1), det = dot(n0, c12);
    if (Math.abs(det) < 0.05) return -1;
    const p = [0, 1, 2].map((i) => (d[0] * c12[i] + d[1] * c20[i] + d[2] * c01[i]) / det);
    const m = [0, 1, 2].map((i) => (V[a][i] + V[b][i]) / 2);
    if (len(sub(p, m)) > MAX_MOVE * E || Math.abs(f(p[0], p[1], p[2])) > TOL * E) return -1;
    const key = p.map((x) => Math.round(x * 1e5)).join(",");
    if (corners.has(key)) return corners.get(key);
    V.push(p); planes.push(set); stats.cornerKept++;
    corners.set(key, V.length - 1);
    return V.length - 1;
  }));
  return { V, T: T2, stats };
}

function measure({ V, T }, d, f, reach, E) {
  const inBox = (p, g) => p.every((x, i) => x > reach[0][i] - g && x < reach[1][i] + g);
  const far = [], all = [];
  let flipped = 0, slivers = 0;
  for (let t = 0; t < T.length; t += 3) {
    const p = V[T[t]], q = V[T[t + 1]], r = V[T[t + 2]];
    const ctr = [0, 1, 2].map((i) => (p[i] + q[i] + r[i]) / 3);
    const n = cross(sub(q, p), sub(r, p)), area2 = len(n);
    const longest = Math.max(len(sub(q, p)), len(sub(r, p)), len(sub(r, q)));
    if (longest === 0 || area2 / longest < 1e-3) { slivers++; continue; }
    const g = [f(ctr[0] + H, ctr[1], ctr[2]) - f(ctr[0] - H, ctr[1], ctr[2]), f(ctr[0], ctr[1] + H, ctr[2]) - f(ctr[0], ctr[1] - H, ctr[2]), f(ctr[0], ctr[1], ctr[2] + H) - f(ctr[0], ctr[1], ctr[2] - H)];
    if (dot(n, g) < 0) flipped++;
    all.push(Math.abs(f(ctr[0], ctr[1], ctr[2])));
    if (!inBox(ctr, 1.5)) far.push(Math.abs(d(ctr)));   // outside the blend's reach: the truth is the exact surface
  }
  const dir = new Map(); let open = 0;
  for (let t = 0; t < T.length; t += 3) for (let j = 0; j < 3; j++) { const a = T[t + j], b = T[t + (j + 1) % 3]; dir.set(a * 4194304 + b, (dir.get(a * 4194304 + b) ?? 0) + 1); }
  for (const [key, n] of dir) { const a = Math.floor(key / 4194304), b = key % 4194304; if ((dir.get(b * 4194304 + a) ?? 0) !== n) open++; }
  return { tris: T.length / 3, open, slivers, flipped, farCentreMax: r4(mx(far)), farCentreP99: r4(pct(far, 0.99)),
    fieldCentreMax: r4(mx(all)), fieldCentreP99: r4(pct(all, 0.99)), fieldCentreP90: r4(pct(all, 0.9)) };
}

for (const [name, c] of Object.entries(CASES)) {
  for (const E of [0.6, 1.0]) {
    const A = c.a(), B = c.b();
    const root = { kind: "union", k: c.k, children: [leaf(A), leaf(B)] };
    const exactField = buildMeshField(A.union(B).toMesh());
    const d = (p) => meshDistance(exactField, p[0], p[1], p[2]);
    const f = implicitDistance(root, { meshFieldOf: (s) => buildMeshField(s.toMesh()) });
    const soft = k.implicit({ resolution: E, preview: E, root });
    const mesh = weld(soft.toMesh());
    console.log(JSON.stringify({ case: name, edge: E, pass: "before", ...measure(mesh, d, f, c.reach, E) }));
    const t0 = performance.now();
    const sharp = sharpen(mesh, f, E);
    const ms = Math.round(performance.now() - t0);
    console.log(JSON.stringify({ case: name, edge: E, pass: "after", ms, ...sharp.stats, ...measure(sharp, d, f, c.reach, E) }));
    if (process.argv[2] && E === 0.6) {
      const L = ["solid s"];
      for (let t = 0; t < sharp.T.length; t += 3) {
        L.push("facet normal 0 0 0", "outer loop");
        for (let j = 0; j < 3; j++) L.push("vertex " + sharp.V[sharp.T[t + j]].join(" "));
        L.push("endloop", "endfacet");
      }
      L.push("endsolid s");
      (await import("node:fs")).writeFileSync(`${process.argv[2]}/${name}.stl`, L.join("\n"));
    }
  }
}
