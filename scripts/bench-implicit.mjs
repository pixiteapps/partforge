// scripts/bench-implicit.mjs — times each engine stage on the reference fixtures.
// Usage: node scripts/bench-implicit.mjs [--core on|off|both]   (Node 24; default both)
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compileImplicit } from "../src/framework/geometry/implicit/index.js";
import { sampleField } from "../src/framework/geometry/implicit/sparse.js";
import { meshStore } from "../src/framework/geometry/implicit/mesher.js";
import { cleanupMesh } from "../src/framework/geometry/implicit/cleanup.js";
import { applySurfaceDetail } from "../src/framework/geometry/implicit/detail.js";
import { setCoreEnabled } from "../src/framework/core/core.js";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { handSpec, vaseSpec } from "../test/fixtures/implicit-trees.js";

const arg = process.argv.indexOf("--core");
const coreMode = arg >= 0 ? process.argv[arg + 1] : "both";
if (!["on", "off", "both"].includes(coreMode)) { console.error("usage: bench-implicit.mjs [--core on|off|both]"); process.exit(2); }
const CORE_WIRED = false;   // the implicit engine has no native path yet (PR 2 Task 9 wires it)

// A true cold run: a fresh process that boots the kernel and times its first k.implicit.
const root = fileURLToPath(new URL("..", import.meta.url));
const cold = execFileSync(process.execPath, ["--input-type=module", "-e", `
  const { bootManifoldKernel } = await import(${JSON.stringify(root + "src/testing/manifold.js")});
  const { handSpec } = await import(${JSON.stringify(root + "test/fixtures/implicit-trees.js")});
  const k = await bootManifoldKernel();
  const t = performance.now(); k.implicit({ ...handSpec(), preview: 1.5 });
  console.log((performance.now() - t).toFixed(0));
`], { encoding: "utf8" }).trim();
console.log(`k.implicit(hand) end to end, cold (fresh process): ${cold} ms`);

const time = (f) => { const t = performance.now(); const r = f(); return [r, performance.now() - t]; };
const k = await bootManifoldKernel();
const { spec: vase, images } = vaseSpec();
for (const [name, im] of images) await k._registerImage({ name, ...im });
const cases = [["hand preview", handSpec(), 1.5, new Map()], ["hand print", handSpec(), 0.8, new Map()], ["vase preview", vase, 1.2, images]];

for (const on of coreMode === "both" ? [false, true] : [coreMode === "on"]) {
  console.log(`\ncore ${on ? "on" : "off"}`);
  if (on && !CORE_WIRED) { console.log("core path not wired"); continue; }
  setCoreEnabled(on);
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
  console.log(`k.implicit(hand) end to end, after warm-up: ${tk.toFixed(0)} ms`);
}
setCoreEnabled(true);
