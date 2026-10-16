// scripts/bench-implicit.mjs — times each engine stage on the reference fixtures.
// Usage: node scripts/bench-implicit.mjs [--core on|off|both]   (Node 24; default both)
// Times are CPU milliseconds.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compileImplicit } from "../src/framework/geometry/implicit/index.js";
import { planLeaves, evaluateLeaves } from "../src/framework/geometry/implicit/sparse.js";
import { meshStore } from "../src/framework/geometry/implicit/mesher.js";
import { cleanupMesh, CLEANUP } from "../src/framework/geometry/implicit/cleanup.js";
import { applySurfaceDetail, flattenDetail } from "../src/framework/geometry/implicit/detail.js";
import { core, setCoreEnabled } from "../src/framework/core/core.js";
import { NativeSession } from "../src/framework/core/implicit-core.js";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { handSpec, vaseSpec } from "../test/fixtures/implicit-trees.js";

const arg = process.argv.indexOf("--core");
const coreMode = arg >= 0 ? process.argv[arg + 1] : "both";
if (!["on", "off", "both"].includes(coreMode)) { console.error("usage: bench-implicit.mjs [--core on|off|both]"); process.exit(2); }

// A true cold run: a fresh process that boots the kernel and times its first k.implicit.
const root = fileURLToPath(new URL("..", import.meta.url));
const cold = execFileSync(process.execPath, ["--input-type=module", "-e", `
  const { bootManifoldKernel } = await import(${JSON.stringify(root + "src/testing/manifold.js")});
  const { handSpec } = await import(${JSON.stringify(root + "test/fixtures/implicit-trees.js")});
  const k = await bootManifoldKernel();
  const t = process.cpuUsage(); k.implicit({ ...handSpec(), preview: 1.5 });
  const u = process.cpuUsage(t); console.log(((u.user + u.system) / 1000).toFixed(0));
`], { encoding: "utf8" }).trim();
console.log(`k.implicit(hand) end to end, cold (fresh process): ${cold} CPU ms`);

// CPU time, not wall clock: steadier on a loaded machine (every stage is single-threaded).
const cpuMs = (u) => (u.user + u.system) / 1000;
const time = (f) => { const t = process.cpuUsage(); const r = f(); return [r, cpuMs(process.cpuUsage(t))]; };
const { spec: vase, images } = vaseSpec();
// The hand at 0.5 mm is the spec's print-tier target (docs/research/organic-shapes.md §9).
const cases = [["hand preview", handSpec(), 1.5, new Map()], ["hand print", handSpec(), 0.8, new Map()], ["hand 0.5 mm", handSpec(), 0.5, new Map()], ["vase preview", vase, 1.2, images]];

for (const on of coreMode === "both" ? [false, true] : [coreMode === "on"]) {
  console.log(`\ncore ${on ? "on" : "off"}`);
  setCoreEnabled(on);
  if (on && !core()) { console.log("core unavailable"); continue; }
  console.log("case            compile  sample  mesh  cleanup  detail  total   tris     samples  programs");
  for (const [name, spec, edge, imgs] of cases) {
    for (let warm = 0; warm < 2; warm++) {
      const [c, tc] = time(() => compileImplicit(spec, { images: imgs }));
      // sample = planLeaves + evaluation; with the core on, every later stage runs on one
      // native session (meshImplicitCore's sequence; only the final mesh is read back).
      let st, sess = null;
      const [plan, tp] = time(() => planLeaves(c, edge));
      try {
        let ts, tm, tcl, td, d;
        if (on) {
          sess = new NativeSession(core());
          [, ts] = time(() => { plan.textures.forEach((t) => sess.addTexture(t)); plan.programs.forEach((p) => sess.addProgram(p)); sess.sample(plan, { readBack: false }); });
          [, tm] = time(() => sess.mesh({ readBack: false }));
          [d, tcl] = time(() => sess.cleanup(CLEANUP, { readBack: !c.detail.length }));
          if (c.detail.length) [d, td] = time(() => sess.detail(flattenDetail(c)));
          else td = 0;
        } else {
          let s, m, cl;
          [s, ts] = time(() => evaluateLeaves(plan));
          [m, tm] = time(() => meshStore(s));
          [cl, tcl] = time(() => cleanupMesh(s, m));
          [d, td] = time(() => (c.detail.length ? applySurfaceDetail(s, cl, c) : cl));
        }
        st = [tp + ts, tm, tcl, td, d];
      } finally { sess?.destroy(); }
      if (warm === 0) continue;
      const [ts, tm, tcl, td, d] = st;
      const total = tc + ts + tm + tcl + td;
      console.log(`${name.padEnd(15)} ${tc.toFixed(0).padStart(7)} ${ts.toFixed(0).padStart(7)} ${tm.toFixed(0).padStart(5)} ${tcl.toFixed(0).padStart(8)} ${td.toFixed(0).padStart(7)} ${total.toFixed(0).padStart(6)} ${String(d.indices.length / 3).padStart(8)} ${String(plan.samples).padStart(9)} ${String(plan.programs.length).padStart(9)}`);
    }
  }
  // A fresh kernel per mode: the solid cache would otherwise answer the second mode.
  const k = await bootManifoldKernel();
  k.implicit({ ...handSpec(), preview: 1.4 });   // warm-up (a different grid: no cache hit below)
  const [, tk] = time(() => k.implicit({ ...handSpec(), preview: 1.5 }));
  console.log(`k.implicit(hand) end to end, after warm-up: ${tk.toFixed(0)} CPU ms`);
}
setCoreEnabled(true);
