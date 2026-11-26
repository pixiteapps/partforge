// SPIKE (phase 2): the notch where a changed region's border crosses a sharp edge.
// Compares two hand stitches of a smooth union over two solids:
//   cut: exact − window, plus soft ∩ window   (the design's section 4)
//   add: exact, plus soft ∩ window            (a smooth union only adds material)
// node spike/exact-faces/notch.mjs <outDir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootManifoldKernel } from "../../src/testing/manifold.js";
import { renderViewImages } from "../../src/testing/render.js";
import { buildMeshField } from "../../src/framework/geometry/implicit/mesh-field-build.js";
import { meshDistance } from "../../src/framework/geometry/implicit/mesh-field.js";

const out = process.argv[2]; mkdirSync(out, { recursive: true });
const k = await bootManifoldKernel({ quality: "preview", meshFields: true });
const leaf = (s) => ({ kind: "solid", solid: s });
const E = 0.6;

// `reach` is the box the blend can change: the boss's bounds grown by k, cut to where
// the bodies are. `win(pad)` is reach grown by pad (negative: shrunk).
const CASES = {
  // Convex edge: a boss near a plate's edge.
  "plate-edge": { k: 8, a: () => k.box({ min: [-30, -20, 0], max: [30, 20, 6] }), b: () => k.cylinder({ r: 8, h: 26 }).at([20, 0, 4]),
    reach: [[4, -16, -8], [36, 16, 38]] },
  // Concave edge: a boss in the inside corner of an L bracket.
  "bracket-corner": { k: 6, a: () => k.box({ min: [-30, -20, 0], max: [30, 20, 6] }).union(k.box({ min: [-30, -20, 0], max: [-24, 20, 30] })),
    b: () => k.cylinder({ r: 5, h: 20 }).at([-14, 0, 4]), reach: [[-25, -11, -6], [-3, 11, 30]] },
};
const win = (c, pad) => [c.reach[0].map((x) => x - pad), c.reach[1].map((x) => x + pad)];
const triCount = (m) => (m.indices ? m.indices.length : m.positions.length / 3) / 3;
const eachTri = (m, f) => {
  const P = m.positions, I = m.indices, n = triCount(m);
  for (let t = 0; t < n; t++) {
    const v = [0, 1, 2].map((j) => { const i = (I ? I[3 * t + j] : 3 * t + j) * 3; return [P[i], P[i + 1], P[i + 2]]; });
    f(v[0], v[1], v[2]);
  }
};
const mx = (xs) => xs.reduce((m, x) => (x > m ? x : m), 0);
const r4 = (x) => +x.toFixed(4);
const build = (c, mode, pad) => {
  const A = c.a(), B = c.b(), w = win(c, pad);
  const soft = k.implicit({ resolution: E, preview: E, root: { kind: "union", k: c.k, children: [leaf(A), leaf(B)] } });
  const exact = A.union(B), box = k.box({ min: w[0], max: w[1] });
  if (mode === "soft") return soft;
  if (mode === "cut") return exact.cut(box).union(soft.intersect(box));
  return exact.union(soft.intersect(box));
};

const rows = [];
for (const [name, c] of Object.entries(CASES)) {
  for (const [mode, pad] of [["soft", 0], ["cut", 1.5], ["add", 1.5], ["add", -0.5], ["add", -1]]) {
    const field = buildMeshField(c.a().union(c.b()).toMesh());
    const d = (p) => meshDistance(field, p[0], p[1], p[2]);
    const w = win(c, pad);
    const t0 = performance.now();
    const s = build(c, mode, pad);
    const ms = performance.now() - t0;
    const m = s.toMesh();
    // Near the border (within one cell of a window face, on either side) the blend is
    // almost nothing, so the result should sit on the exact surface. `under` is how far
    // it cuts into the exact body (a chamfered convex edge), `over` how far it stands
    // proud (a filled concave edge, or the blend's own small bump).
    const under = [], over = [];
    let slivers = 0;
    eachTri(m, (p, q, r) => {
      const ab = q.map((x, i) => x - p[i]), ac = r.map((x, i) => x - p[i]);
      const cr = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      const longest = Math.max(Math.hypot(...ab), Math.hypot(...ac), Math.hypot(...q.map((x, i) => x - r[i])));
      if (longest === 0 || Math.hypot(...cr) / longest < 1e-3) slivers++;
      const ctr = [0, 1, 2].map((i) => (p[i] + q[i] + r[i]) / 3);
      const inBox = (pt, g) => pt.every((x, i) => x > w[0][i] - g && x < w[1][i] + g);
      if (!(inBox(ctr, E) && !inBox(ctr, -E))) return;
      for (const pt of [p, q, r, ctr]) { const v = d(pt); if (v < 0) under.push(-v); else over.push(v); }
    });
    const row = { case: name, mode, pad, ms: Math.round(ms), tris: triCount(m), slivers, borderSamples: under.length + over.length,
      underMax: r4(mx(under)), overMax: r4(mx(over)), volume: r4(s.volume()) };
    rows.push(row); console.log(JSON.stringify(row));
  }
  for (const [mode, pad] of [["cut", 1.5], ["add", -0.5]]) {
    const part = { meta: { title: name, units: "mm", backend: "manifold" }, parameters: [], defaults: {},
      parts: { body: { label: name, views: ["main"], build: () => build(c, mode, pad) } }, views: { main: { label: name } } };
    const imgs = await renderViewImages(k, part, "main", { views: ["iso"], size: [1100, 850] });
    for (const im of imgs) writeFileSync(join(out, `${name}-${mode}.png`), im.png);
  }
}
writeFileSync(join(out, "rows.json"), JSON.stringify(rows, null, 1));
