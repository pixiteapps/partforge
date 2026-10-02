// Offline: OCCT's volume change for each general-chain fixture × case, the ground
// truth test/mesh-fillet-general.test.js compares the mesh fillet against. OCCT must
// not share a process with Manifold, hence a script. A change of exactly 0 means
// OCCT's safeOp SKIPPED the feature — recorded as null, never as a reference.
// Usage: node scripts/fillet-general-reference.mjs
import { writeFileSync } from "node:fs";
import { bootOcctKernel } from "../src/testing/occt.js";
import { FIXTURES, CASES, SMALL_CASES, RIM_FIXTURES, RIM_CASES } from "../test/fixtures/fillet-general-fixtures.js";

const k = await bootOcctKernel({});
const out = {};
for (const [name, make] of Object.entries(FIXTURES)) {
  const base = make(k);
  const v0 = base.volume();
  out[name] = {};
  for (const [mode, m] of [...CASES, ...SMALL_CASES]) {
    let dV = null;
    try {
      const s = mode === "fillet" ? base.fillet(m) : base.chamfer(m);
      const d = s.volume() - v0;
      dV = Math.abs(d) > 1e-6 ? +d.toFixed(4) : null;
    } catch { dV = null; }
    out[name][`${mode}${m}`] = dV;
  }
}
// selected-edge rims (RIM_FIXTURES): the same record for the edges they name
for (const [name, { make, edges }] of Object.entries(RIM_FIXTURES)) {
  const base = make(k);
  const v0 = base.volume();
  out[name] = {};
  for (const [mode, m] of RIM_CASES) {
    let dV = null;
    try {
      const s = mode === "fillet" ? base.fillet({ r: m, edges }) : base.chamfer({ d: m, edges });
      const d = s.volume() - v0;
      dV = Math.abs(d) > 1e-6 ? +d.toFixed(4) : null;
    } catch { dV = null; }
    out[name][`${mode}${m}`] = dV;
  }
}
const path = new URL("../test/fixtures/fillet-general-reference.json", import.meta.url);
writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out));
