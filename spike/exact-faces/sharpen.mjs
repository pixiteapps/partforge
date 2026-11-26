// SPIKE (phase 2): can the implicit mesh keep a solid leaf's sharp edges by itself?
// The JS mesher's stages up to cleanup (test/helpers/implicit-stages.js), then the real stage,
// sharpenMesh (src/framework/geometry/implicit/sharpen.js), measured against the exact union.
// It replaced this spike's own post-pass (Task 3 of the sharpen plan).
// node spike/exact-faces/sharpen.mjs [outDir]   (outDir: the 0.6 mm meshes as STL)
import { bootManifoldKernel } from "../../src/testing/manifold.js";
import { buildMeshField } from "../../src/framework/geometry/implicit/mesh-field-build.js";
import { meshDistance } from "../../src/framework/geometry/implicit/mesh-field.js";
import { implicitDistance } from "../../src/framework/geometry/implicit/distance.js";
import { sharpenMesh } from "../../src/framework/geometry/implicit/sharpen.js";
import { jsStages, meshFieldOf } from "../../test/helpers/implicit-stages.js";

const k = await bootManifoldKernel({ quality: "preview", meshFields: true });
const leaf = (s) => ({ kind: "solid", solid: s });
const H = 1e-4;

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

// A mesh stage's result as the measure's vertex list and triangle list.
const asVT = (m) => ({ V: Array.from({ length: m.positions.length / 3 }, (_, v) => [m.positions[3 * v], m.positions[3 * v + 1], m.positions[3 * v + 2]]),
  T: Array.from(m.indices) });

for (const [name, c] of Object.entries(CASES)) {
  for (const E of [0.6, 1.0]) {
    const A = c.a(), B = c.b();
    const root = { kind: "union", k: c.k, children: [leaf(A), leaf(B)] };
    const exactField = buildMeshField(A.union(B).toMesh());
    const d = (p) => meshDistance(exactField, p[0], p[1], p[2]);
    const f = implicitDistance(root, { meshFieldOf });
    const { store, cleaned } = jsStages({ root }, E, { tier: "preview" });
    console.log(JSON.stringify({ case: name, edge: E, pass: "before", ...measure(asVT(cleaned), d, f, c.reach, E) }));
    const t0 = performance.now(), stats = {};
    const sharp = asVT(sharpenMesh(store, cleaned, { stats }));
    const ms = Math.round(performance.now() - t0);
    const counts = { split: stats.split, moved: stats.moved, corners: stats.corners, again: stats.again?.split ?? 0 };
    console.log(JSON.stringify({ case: name, edge: E, pass: "after", ms, ...counts, ...measure(sharp, d, f, c.reach, E) }));
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
