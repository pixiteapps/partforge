// OCCT scaling gate for extruding ONE Shape2D made of many disjoint regions (a
// lattice of small triangles). Run: node --max-old-space-size=2048 scripts/bench-occt-multi-region-extrude.mjs [N ...]
// Reports wall time per N (the build is synchronous, so a heap sampler can't run; use
// `node --max-old-space-size=<MB>` as the pass/fail heap gate, or /usr/bin/time -l for RSS). A left-fold fuse of the regions
// was O(N^2): ~1,500 triangles peaked at ~2.6 GB heap. Not part of `npm test` (slow).
import { bootOcctKernel } from "../src/testing/occt.js";

const k = await bootOcctKernel();
const sizes = process.argv.slice(2).map(Number);
if (!sizes.length) sizes.push(250, 500, 1000, 1500);

const lattice = (n) => {
  const cols = Math.ceil(Math.sqrt(n)), regs = [];
  for (let i = 0; i < n; i++) {
    const x = (i % cols) * 3, y = Math.floor(i / cols) * 3;
    regs.push({ outer: [[x, y], [x + 2, y], [x + 1, y + 1.7]], holes: [] });
  }
  return k.shape2d(regs);
};

for (const n of sizes) {
  const shape = lattice(n);
  global.gc?.();
  const t0 = performance.now();
  const solid = k.extrude({ profile: shape, h: 2 });
  const ms = performance.now() - t0;
  console.log(`N=${n}: ${ms.toFixed(0)} ms, volume ${solid.volume().toFixed(2)}`);
}
