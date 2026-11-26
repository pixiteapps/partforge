// SPIKE (phase 2, design section 4 "Risk to settle first"): where an implicit mesh
// meets a solid's own faces at the border of a changed region, how big is the step?
// node spike/exact-faces/border.mjs [outDir]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootManifoldKernel } from "../../src/testing/manifold.js";
import { renderViewImages } from "../../src/testing/render.js";
import { buildMeshField } from "../../src/framework/geometry/implicit/mesh-field-build.js";
import { meshDistance } from "../../src/framework/geometry/implicit/mesh-field.js";

const out = process.argv[2];
if (out) mkdirSync(out, { recursive: true });
const quality = process.argv[3] ?? "preview";
const k = await bootManifoldKernel({ quality, meshFields: true });

const leaf = (s) => ({ kind: "solid", solid: s });
const creature = () => {
  const c = k.cage({ box: { size: [44, 24, 22], segs: [2, 1, 1] } });
  c.extrude("+x:0,0", { by: 14, scale: 0.55 });
  return k.subdiv(c).at([0, 0, 24]);
};
const CASES = {
  // A box boss blended into the curved side of a cylinder.
  "cylinder-side": { k: 4, a: () => k.cylinder({ r: 12, h: 40 }), b: () => k.box({ min: [8, -4, 16], max: [22, 4, 24] }),
    win: [[3, -9, 11], [28, 9, 29]] },
  // A post blended into the underside of a subdivision body.
  "cage-post": { k: 7, a: creature, b: () => k.cylinder({ r: 5, h: 22 }).at([-6, 0, 0]),
    win: [[-19.5, -13.5, 4.5], [7.5, 13.5, 30.5]] },
  // A boss near a plate's edge: the border crosses the plate's sharp edges.
  "plate-edge": { k: 8, a: () => k.box({ min: [-30, -20, 0], max: [30, 20, 6] }), b: () => k.cylinder({ r: 8, h: 26 }).at([20, 0, 4]),
    win: [[3.5, -17.5, -1.5], [37.5, 17.5, 15.5]] },
};

const triCount = (m) => (m.indices ? m.indices.length : m.positions.length / 3) / 3;
const eachTri = (m, f) => {
  const P = m.positions, I = m.indices;
  const n = triCount(m);
  for (let t = 0; t < n; t++) {
    const v = [0, 1, 2].map((j) => { const i = (I ? I[3 * t + j] : 3 * t + j) * 3; return [P[i], P[i + 1], P[i + 2]]; });
    f(v[0], v[1], v[2]);
  }
};
const inside = (p, [lo, hi], pad = 0) => p.every((c, i) => c > lo[i] - pad && c < hi[i] + pad);
const pct = (xs, q) => { if (!xs.length) return 0; const s = Float64Array.from(xs).sort(); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const mx = (xs) => xs.reduce((m, x) => (x > m ? x : m), 0);
const r4 = (x) => +x.toFixed(4);

const rows = [];
for (const [name, c] of Object.entries(CASES)) {
  if (process.argv[4] && !name.startsWith(process.argv[4])) continue;
  const A = c.a(), B = c.b();
  const exact = A.union(B);
  const field = buildMeshField(exact.toMesh());
  const d = (p) => Math.abs(meshDistance(field, p[0], p[1], p[2]));
  const winBox = k.box({ min: c.win[0], max: c.win[1] });
  for (const e of [0.3, 0.6, 1.0]) {
    const t0 = performance.now();
    const soft = k.implicit({ resolution: e, preview: e, root: { kind: "union", k: c.k, children: [leaf(A), leaf(B)] } });
    const softMs = performance.now() - t0;
    const sm = soft.toMesh();
    // 1. Outside the window the blend changes nothing, so the soft mesh should lie on
    //    the exact surface. Vertices, and triangle centres (a centre shows a chord cut
    //    across a facet crease or a sharp edge).
    const vOut = [], cOut = [];
    eachTri(sm, (p, q, r) => {
      const ctr = [0, 1, 2].map((i) => (p[i] + q[i] + r[i]) / 3);
      if (inside(ctr, c.win, e)) return;
      cOut.push(d(ctr)); vOut.push(d(p), d(q), d(r));
    });
    // 2. On each window face: the soft mesh's section curve against the exact surface.
    const sec = [];
    eachTri(sm, (p, q, r) => {
      for (let a = 0; a < 3; a++) for (const side of [0, 1]) {
        const cut = c.win[side][a], pts = [];
        for (const [u, v] of [[p, q], [q, r], [r, p]]) {
          if ((u[a] - cut) * (v[a] - cut) < 0) { const t = (cut - u[a]) / (v[a] - u[a]); pts.push(u.map((x, i) => x + t * (v[i] - x))); }
        }
        if (pts.length !== 2) continue;
        const mid = pts[0].map((x, i) => (x + pts[1][i]) / 2);
        const b = [0, 1, 2].filter((i) => i !== a);
        if (!b.every((i) => mid[i] > c.win[0][i] && mid[i] < c.win[1][i])) continue;
        sec.push(d(pts[0]), d(pts[1]), d(mid));
      }
    });
    // 3. The hand stitch, as the first spike did it.
    const t1 = performance.now();
    let stitch = null, err = null;
    try { stitch = exact.cut(winBox).union(soft.intersect(winBox)); } catch (x) { err = String(x?.message ?? x).slice(0, 200); }
    const stitchMs = performance.now() - t1;
    let ledgeArea = 0, ledgeTris = 0, stitchTris = 0, minAlt = Infinity, slivers = 0;
    if (stitch) {
      const m = stitch.toMesh(); stitchTris = triCount(m);
      eachTri(m, (p, q, r) => {
        const ab = q.map((x, i) => x - p[i]), ac = r.map((x, i) => x - p[i]);
        const cr = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
        const area = Math.hypot(...cr) / 2;
        const longest = Math.max(Math.hypot(...ab), Math.hypot(...ac), Math.hypot(...q.map((x, i) => x - r[i])));
        const alt = longest > 0 ? 2 * area / longest : 0;
        if (alt < minAlt) minAlt = alt;
        if (alt < 1e-3) slivers++;
        for (let a = 0; a < 3; a++) for (const side of [0, 1]) {
          const cut = c.win[side][a];
          if ([p, q, r].every((v) => Math.abs(v[a] - cut) < 1e-6)) { ledgeArea += area; ledgeTris++; }
        }
      });
    }
    const row = { case: name, quality, edge: e, exactTris: field.tris, softTris: triCount(sm), softMs: Math.round(softMs),
      outVertMax: r4(mx(vOut)), outVertP99: r4(pct(vOut, 0.99)),
      outCentreMax: r4(mx(cOut)), outCentreP99: r4(pct(cOut, 0.99)), outCentreP50: r4(pct(cOut, 0.5)),
      sectionSamples: sec.length, sectionMax: r4(mx(sec)), sectionP99: r4(pct(sec, 0.99)), sectionP50: r4(pct(sec, 0.5)),
      stitchOk: !!stitch, stitchMs: Math.round(stitchMs), stitchTris, ledgeTris, ledgeArea: r4(ledgeArea), slivers, minAlt: +minAlt.toExponential(2),
      volExact: r4(exact.volume()), volSoft: r4(soft.volume()), volStitch: stitch ? r4(stitch.volume()) : null, err };
    rows.push(row); console.log(JSON.stringify(row));
  }
  if (out) {
  const e = 0.6;
    const mk = { soft: () => k.implicit({ resolution: e, preview: e, root: { kind: "union", k: c.k, children: [leaf(c.a()), leaf(c.b())] } }) };
    mk.stitch = () => c.a().union(c.b()).cut(k.box({ min: c.win[0], max: c.win[1] })).union(mk.soft().intersect(k.box({ min: c.win[0], max: c.win[1] })));
    for (const tag of ["soft", "stitch"]) {
      const part = { meta: { title: name, units: "mm", backend: "manifold" }, parameters: [], defaults: {},
        parts: { body: { label: name, views: ["main"], build: () => mk[tag]() } }, views: { main: { label: name } } };
      const imgs = await renderViewImages(k, part, "main", { views: ["iso"], size: [1100, 850] });
      for (const im of imgs) writeFileSync(join(out, `${name}-${tag}.png`), im.png);
    }
  }
}
if (out) writeFileSync(join(out, "rows.json"), JSON.stringify(rows, null, 1));
