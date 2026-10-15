// scripts/bench-implicit.mjs — times each engine stage on the reference fixtures.
// Usage: node scripts/bench-implicit.mjs   (Node 24)
import { compileImplicit } from "../src/framework/geometry/implicit/index.js";
import { sampleField } from "../src/framework/geometry/implicit/sparse.js";
import { meshStore } from "../src/framework/geometry/implicit/mesher.js";
import { cleanupMesh } from "../src/framework/geometry/implicit/cleanup.js";
import { applySurfaceDetail } from "../src/framework/geometry/implicit/detail.js";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { handSpec, vaseSpec } from "../test/fixtures/implicit-trees.js";

const time = (f) => { const t = performance.now(); const r = f(); return [r, performance.now() - t]; };
const k = await bootManifoldKernel();
const { spec: vase, images } = vaseSpec();
for (const [name, im] of images) await k._registerImage({ name, ...im });
const cases = [["hand preview", handSpec(), 1.5, new Map()], ["hand print", handSpec(), 0.8, new Map()], ["vase preview", vase, 1.2, images]];
console.log("case            compile  sample  mesh  cleanup  detail  total   tris     samples  programs");
for (const [name, spec, edge, imgs] of cases) {
  for (let warm = 0; warm < 2; warm++) {
    const [c, tc] = time(() => compileImplicit(spec, { images: imgs }));
    const [s, ts] = time(() => sampleField(c, edge));
    const [m, tm] = time(() => meshStore(s));
    const [cl, tcl] = time(() => cleanupMesh(s, m));
    const [d, td] = time(() => (c.detail.length ? applySurfaceDetail(s, cl, c) : cl));
    if (warm === 0) continue;
    const total = tc + ts + tm + tcl + td;
    console.log(`${name.padEnd(15)} ${tc.toFixed(0).padStart(7)} ${ts.toFixed(0).padStart(7)} ${tm.toFixed(0).padStart(5)} ${tcl.toFixed(0).padStart(8)} ${td.toFixed(0).padStart(7)} ${total.toFixed(0).padStart(6)} ${String(d.indices.length / 3).padStart(8)} ${String(s.samples).padStart(9)} ${String(s.programs.length).padStart(9)}`);
  }
}
const [, tk] = time(() => k.implicit({ ...handSpec(), preview: 1.5 }));
console.log(`k.implicit(hand) end to end, cold: ${tk.toFixed(0)} ms`);
