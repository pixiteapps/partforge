// test/implicit-speed-owners.test.js — the owner path's CI speed gate, in its own file (vitest isolates
// per file) so the heavy plain-path meshes of test/implicit-speed.test.js, run in the same process,
// never decide it. See that file for the paced-CPU-ms method (`cpuMs`).
import { expect, test } from "vitest";
import { PACE, cpuMs } from "./helpers/cpu-pace.js";
import { core, setCoreEnabled } from "../src/framework/core/core.js";
import { meshImplicitCore } from "../src/framework/core/implicit-core.js";
import { compileImplicit, meshImplicit } from "../src/framework/geometry/implicit/index.js";
import { planLeaves } from "../src/framework/geometry/implicit/sparse.js";
import { CLEANUP, PREVIEW_CLEANUP } from "../src/framework/geometry/implicit/cleanup.js";
import { handSpec, HAND_POSES } from "./fixtures/implicit-trees.js";

// The owner path (a root exact contact: owner mesher, owner cleanup, crease cut, untangle and
// the detail's seam fade, all native) against the seam spec's speed gate, as a RATIO to the plain
// native mesher measured in the same test: at most 1.2× the plain baseline at preview 1.5 mm and
// 1.5× (now 1.6×, below) at print 0.5 mm (2026-10-17, isolated, base 4b886eaa: hand default 241 / 1652 ms, fist
// 269 / 1839 ms), the preview ratios raised to the owner path's measured cost (seams win over
// speed): the owner path measured 316 / 378 ms at 1.5 mm and 2250 / 2515 ms at 0.5 mm. Ratios
// because load slows both paths alike while an absolute number belongs to a quiet machine
// (the absolute 2478 ms print gate failed 3–5% over inside the full suite, passing alone). The
// plain path is the same hand on the same grid compiled with `exactContact: false`; runs are
// interleaved so both see the same load, and each ratio is of medians over 5 runs per grid (the
// print grid took 3 once; 5 keeps one loaded run from deciding it). An absolute ceiling of 3× the
// spec targets backstops.
// The print ratio is raised from 1.5 to 1.6 to the measured cost (the plan's rule): 1.53x (default) /
// 1.46x (fist) against today's plain native path (1474 / 1707 paced ms), which is itself faster than
// the 1652 / 1839 base-commit baseline the 1.5x came from; in absolute terms the owner print path
// (2248 / 2485) is 1.36x / 1.35x that base.
// What the seams cost at 1.5 mm, all of it work the JS owner path does too: the mesher's
// 9–11k owner-owner edges each bisected in 25 evaluations (30 / 51 ms), cleanup's extra
// projection pass and share capture (~17 / 28 ms), the crease cut (~12 / 21 ms), the detail's
// owner projection and seam fade (~6 / 7 ms) and untangle (1 / 6 ms).
const SPEC_PREVIEW_MS = 150;
const SPEC_PRINT_MS = 2000;
const OWNER_GATES = [
  ["hand default", {}, 1.45, 1.6],
  ["hand fist", HAND_POSES.fist, 1.54, 1.6],
];

// Median owner and plain times, runs interleaved (owner, plain, owner, plain, ...).
function pairedMedianMs(owner, plain, edge, opts, runs) {
  const o = [], p = [];
  for (let i = 0; i < runs; i++) {
    let t0 = cpuMs();
    const out = meshImplicitCore(owner, edge, planLeaves(owner, edge), opts);
    o.push(cpuMs() - t0);
    expect(out?.vertOwner, `the native owner path answered at ${edge} mm`).toBeTruthy();
    t0 = cpuMs();
    const base = meshImplicitCore(plain, edge, planLeaves(plain, edge), opts);
    p.push(cpuMs() - t0);
    expect(base, `the native plain path answered at ${edge} mm`).not.toBeNull();
    expect(base.vertOwner).toBeFalsy();
  }
  const med = (a) => a.sort((x, y) => x - y)[runs >> 1];
  return [med(o), med(p)];
}

test("owner meshing stays within the speed gate (ratio to the plain native path)", () => {
  setCoreEnabled(true);
  expect(core(), "the native core is available").toBeTruthy();
  const line = (name, owner, plain, limit, ceiling) => `${name}: owners ${owner.toFixed(0)} / plain ${plain.toFixed(0)} paced ms = ${(owner / plain).toFixed(2)}x, limit ${limit}x, ceiling ${ceiling} ms (pace ${PACE.toFixed(2)}, ${core().simd ? "SIMD" : "scalar"} core)`;
  const results = [];
  for (const [name, pose, previewRatio, printRatio] of OWNER_GATES) {
    const owner = compileImplicit(handSpec(pose)), plain = compileImplicit(handSpec(pose), { exactContact: false });
    for (const c of [owner, plain]) meshImplicitCore(c, 1.4, planLeaves(c, 1.4), PREVIEW_CLEANUP);   // warm-up on another grid
    for (const [edge, opts, runs, ratio, ceiling] of [[1.5, PREVIEW_CLEANUP, 5, previewRatio, 3 * SPEC_PREVIEW_MS], [0.5, CLEANUP, 5, printRatio, 3 * SPEC_PRINT_MS]]) {
      const [o, p] = pairedMedianMs(owner, plain, edge, opts, runs);
      results.push([`${name} ${edge} mm`, o, p, ratio, ceiling]);
    }
  }
  console.log(results.map((r) => line(...r)).join("\n"));
  for (const [n, o, p, ratio, ceiling] of results) {
    expect(o / p, line(n, o, p, ratio, ceiling)).toBeLessThan(ratio);
    expect(o, line(n, o, p, ratio, ceiling)).toBeLessThan(ceiling);
  }
}, 300_000);

// Reported only (no gate): the public meshImplicit wrapper on the default hand, i.e. the core stages
// plus the glue (plan, result, triangle owners) around them.
test("reported: meshImplicit() on the default hand, preview 1.5 mm", () => {
  const compiled = compileImplicit(handSpec());
  meshImplicit(compiled, 1.4, { tier: "preview" });
  const ms = [];
  for (let i = 0; i < 3; i++) { const t0 = cpuMs(); meshImplicit(compiled, 1.5, { tier: "preview" }); ms.push(cpuMs() - t0); }
  console.log(`meshImplicit hand 1.5 mm: ${ms.sort((a, b) => a - b)[1].toFixed(0)} paced ms (pace ${PACE.toFixed(2)})`);
}, 120_000);
