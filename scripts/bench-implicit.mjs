// scripts/bench-implicit.mjs — times each engine stage on the reference fixtures.
// Usage: node scripts/bench-implicit.mjs [--core on|off|both]   (Node 24; default both)
// Times are CPU milliseconds.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compileImplicit } from "../src/framework/geometry/implicit/index.js";
import { planLeaves, evaluateLeaves } from "../src/framework/geometry/implicit/sparse.js";
import { meshStore } from "../src/framework/geometry/implicit/mesher.js";
import { meshStoreOwners } from "../src/framework/geometry/implicit/mesher-owners.js";
import { cutCreases, untangle } from "../src/framework/geometry/implicit/crease.js";
import { cleanupMesh, CLEANUP, PREVIEW_CLEANUP } from "../src/framework/geometry/implicit/cleanup.js";
import { applySurfaceDetail, flattenDetail } from "../src/framework/geometry/implicit/detail.js";
import { core, loadFullCore, setCoreEnabled } from "../src/framework/core/core.js";

import { loadMeshFieldBuilder } from "../src/framework/geometry/implicit/mesh-field-loader.js";

await loadFullCore(); // the implicit engine is the core's full build, loaded on demand
await loadMeshFieldBuilder(); // the solid cases' mesh fields (compileImplicit's buildMeshField), loaded on demand
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
// Each case cleans up as its tier does: the preview grids decimate (PREVIEW_CLEANUP).
// The solid leaves (the MESH op, test/core-parity.test.js's fixtures): the plate and boss join
// (a blended union of two solids) at both tiers and the blob shrink (offset −2), at 0.6 mm.
// Their solids come from a preview kernel, as a forge's would; compile includes buildMeshField.
const sk = await bootManifoldKernel();
const solidLeaf = (solid) => ({ kind: "solid", solid });
const solidJoin = { root: { kind: "union", k: 8, children: [
  solidLeaf(sk.box({ min: [-30, -20, 0], max: [30, 20, 6] })), solidLeaf(sk.cylinder({ r: 8, h: 26 }).at([0, 0, 4])),
] } };
const solidShrink = { root: { kind: "offset", d: -2, child: solidLeaf(sk.sphere(16)
  .union(sk.box({ min: [-8, -8, -22], max: [8, 8, 0] })).union(sk.cylinder({ r: 6, h: 44 }).rotateY(90).at([-22, 0, 4]))) } };
const cases = [["hand preview", handSpec(), 1.5, new Map(), PREVIEW_CLEANUP], ["hand print", handSpec(), 0.8, new Map(), CLEANUP],
  ["hand 0.5 mm", handSpec(), 0.5, new Map(), CLEANUP], ["vase preview", vase, 1.2, images, PREVIEW_CLEANUP],
  ["join preview", solidJoin, 0.6, new Map(), PREVIEW_CLEANUP], ["join print", solidJoin, 0.6, new Map(), CLEANUP],
  ["shrink preview", solidShrink, 0.6, new Map(), PREVIEW_CLEANUP]];

for (const on of coreMode === "both" ? [false, true] : [coreMode === "on"]) {
  console.log(`\ncore ${on ? "on" : "off"}`);
  setCoreEnabled(on);
  if (on && !core()) { console.log("core unavailable"); continue; }
  // A contact root (the hand) runs meshImplicit's owner path: the owner mesher, then `seam`
  // (the crease cut and untangle) between cleanup and detail. Other cases have no seam stage.
  console.log("case            compile  sample  mesh  cleanup  seam  detail  total   tris     samples  programs");
  for (const [name, spec, edge, imgs, cleanupOpts] of cases) {
    for (let warm = 0; warm < 2; warm++) {
      const [c, tc] = time(() => compileImplicit(spec, { images: imgs }));
      // sample = planLeaves + evaluation; with the core on, every later stage runs on one
      // native session (meshImplicitCore's sequence; only the final mesh is read back).
      let st, sess = null;
      const [plan, tp] = time(() => planLeaves(c, edge));
      const owner = c.ownerRoot >= 0 ? c.ir.nodes[c.ownerRoot] : null;
      try {
        let ts, tm, tcl, tse = 0, td = 0, d;
        if (on) {
          sess = new NativeSession(core());
          [, ts] = time(() => {
            plan.textures.forEach((t) => sess.addTexture(t)); (plan.textures.meshes ?? []).forEach((f) => sess.addMesh(f));
            plan.programs.forEach((p) => sess.addProgram(p));
            if (owner) sess.setContact(owner);
            sess.sample(plan, { readBack: false });
          });
          [, tm] = time(() => (owner ? sess.meshOwners({ readBack: false }) : sess.mesh({ readBack: false })));
          [d, tcl] = time(() => sess.cleanup(cleanupOpts, { readBack: !owner && !c.detail.length }));
          if (owner) [d, tse] = time(() => { sess.crease({ readBack: false }); return sess.untangle({ readBack: !c.detail.length }); });
          if (c.detail.length) [d, td] = time(() => sess.detail(flattenDetail(c)));
        } else {
          let s, m;
          [s, ts] = time(() => evaluateLeaves(plan));
          [m, tm] = time(() => (owner ? meshStoreOwners(s, { gap: owner.gap }) : meshStore(s)));
          [d, tcl] = time(() => cleanupMesh(s, m, cleanupOpts));
          if (owner) [d, tse] = time(() => untangle(s, cutCreases(s, d, owner.attWorld)));
          if (c.detail.length) [d, td] = time(() => applySurfaceDetail(s, d, c));
        }
        st = [tp + ts, tm, tcl, tse, td, d];
      } finally { sess?.destroy(); }
      if (warm === 0) continue;
      const [ts, tm, tcl, tse, td, d] = st;
      const total = tc + ts + tm + tcl + tse + td;
      console.log(`${name.padEnd(15)} ${tc.toFixed(0).padStart(7)} ${ts.toFixed(0).padStart(7)} ${tm.toFixed(0).padStart(5)} ${tcl.toFixed(0).padStart(8)} ${tse.toFixed(0).padStart(5)} ${td.toFixed(0).padStart(7)} ${total.toFixed(0).padStart(6)} ${String(d.indices.length / 3).padStart(8)} ${String(plan.samples).padStart(9)} ${String(plan.programs.length).padStart(9)}`);
    }
  }
  // A fresh kernel per mode: the solid cache would otherwise answer the second mode.
  const k = await bootManifoldKernel();
  k.implicit({ ...handSpec(), preview: 1.4 });   // warm-up (a different grid: no cache hit below)
  const [, tk] = time(() => k.implicit({ ...handSpec(), preview: 1.5 }));
  console.log(`k.implicit(hand) end to end, after warm-up: ${tk.toFixed(0)} CPU ms`);
}
setCoreEnabled(true);

// The shrink body both ways, on one preview kernel with the core on: the solid's triangle
// count, k.implicit's offset −2 end to end at a 0.6 mm grid (a fresh kernel, so no cache),
// and Solid.offset(−2) (Manifold's Minkowski difference) on the same solid.
{
  const body = solidShrink.root.child.solid;
  const m = body.toMesh(), tris = m.indices ? m.indices.length / 3 : m.positions.length / 9;
  const k = await bootManifoldKernel({ meshFields: true });
  const [, tf] = time(() => k.implicit({ ...solidShrink, preview: 0.6 }));
  const [, to] = time(() => body.offset(-2));
  console.log(`\nshrink body (${tris} triangles), preview kernel, core on:`);
  console.log(`  k.implicit offset -2 at 0.6 mm, end to end: ${tf.toFixed(0)} CPU ms`);
  console.log(`  Solid.offset(-2): ${to.toFixed(0)} CPU ms`);
}
