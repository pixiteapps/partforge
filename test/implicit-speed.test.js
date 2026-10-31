// test/implicit-speed.test.js — the native implicit engine's CI speed gates.
//
// The spec's targets (docs/superpowers/specs/2026-10-14-implicit-organic-parts-design.md,
// "Performance targets") on an M-series desktop, Node: the hand at full detail on the
// preview grid (1.5 mm) in 150 ms, and on the 0.5 mm print grid in 2 s. CI holds the
// native path to 3× each, on `cpuMs` — main-thread CPU time in the calibration desktop's
// milliseconds (test/helpers/cpu-pace.js), so a runner PACE times slower gets PACE times
// the allowance and a loaded machine's wall clock never decides it. Measured numbers:
// docs/research/organic-shapes.md §9.
//
// The timed path is what k.implicit runs before Manifold: compile, planLeaves, then
// sample / mesh / cleanup / detail on one native session, each grid with its tier's
// cleanup (the preview grid decimates, PREVIEW_CLEANUP). It must be the native path —
// a refusal would time the JS fallback instead, so a null answer fails the test.
import { expect, test } from "vitest";
import { PACE, cpuMs } from "./helpers/cpu-pace.js";
import { core, setCoreEnabled } from "../src/framework/core/core.js";
import { meshImplicitCore } from "../src/framework/core/implicit-core.js";
import { compileImplicit } from "../src/framework/geometry/implicit/index.js";
import { planLeaves } from "../src/framework/geometry/implicit/sparse.js";
import { CLEANUP, PREVIEW_CLEANUP } from "../src/framework/geometry/implicit/cleanup.js";
import { handSpec, HAND_POSES } from "./fixtures/implicit-trees.js";

const SPEC_PREVIEW_MS = 150;
const SPEC_PRINT_MS = 2000;

// The plain native mesher: the spec's 3x targets are its. The hand is a contact root, so its plan
// drops the owner root (no piece capture while sampling) and it meshes with `owners: false`; the
// owner path is gated separately below.
function nativeHand(edge, opts) {
  const compiled = compileImplicit(handSpec());
  const out = meshImplicitCore(compiled, edge, { ...planLeaves(compiled, edge), ownerRoot: -1, ownerK: 0 }, opts, { owners: false });
  expect(out, `the native path answered at ${edge} mm`).not.toBeNull();
  return out;
}

// The median of `runs` timings, so one descheduled run under vitest's parallel files
// cannot fail the gate on its own.
function medianMs(edge, opts, runs) {
  const ms = [];
  for (let i = 0; i < runs; i++) {
    const t0 = cpuMs();
    const out = nativeHand(edge, opts);
    ms.push(cpuMs() - t0);
    expect(out.indices.length).toBeGreaterThan(0);
  }
  return ms.sort((a, b) => a - b)[runs >> 1];
}

// The hand is one contact node (palm, thumb, fingers): compiling it searches every pair for
// contact regions (regions.js). The default pose touches nowhere; the fist has four pads.
// First in the file: after the meshing test's heap the main thread's GC doubles it.
test("the hand compiles within 20 ms CPU with its contact search, open and in a fist", () => {
  for (const [name, pose] of [["default pose", {}], ["fist", HAND_POSES.fist]]) {
    const spec = handSpec(pose);
    for (let i = 0; i < 5; i++) compileImplicit(spec);   // warm-up: the JIT settles on the search
    const ms = [];
    for (let i = 0; i < 5; i++) { const t0 = cpuMs(); compileImplicit(spec); ms.push(cpuMs() - t0); }
    const med = ms.sort((a, b) => a - b)[2];
    console.log(`hand compile, ${name}: ${med.toFixed(1)} paced CPU ms (pace ${PACE.toFixed(2)})`);
    expect(med, name).toBeLessThanOrEqual(20);
  }
}, 60_000);

test("the hand at full detail meshes natively within 3× the spec's targets (preview 1.5 mm, print 0.5 mm)", () => {
  setCoreEnabled(true);
  expect(core(), "the native core is available").toBeTruthy();
  nativeHand(1.4, PREVIEW_CLEANUP);   // warm-up on another grid: the JS front end tiers up, the core boots
  const preview = medianMs(1.5, PREVIEW_CLEANUP, 5);
  const print = medianMs(0.5, CLEANUP, 5);
  const line = (name, ms, limit) => `${name}: ${ms.toFixed(0)} paced ms, limit ${limit} (pace ${PACE.toFixed(2)}, ${core().simd ? "SIMD" : "scalar"} core)`;
  console.log(`${line("hand 1.5 mm", preview, 3 * SPEC_PREVIEW_MS)}\n${line("hand 0.5 mm", print, 3 * SPEC_PRINT_MS)}`);
  expect(preview, line("hand 1.5 mm", preview, 3 * SPEC_PREVIEW_MS)).toBeLessThan(3 * SPEC_PREVIEW_MS);
  expect(print, line("hand 0.5 mm", print, 3 * SPEC_PRINT_MS)).toBeLessThan(3 * SPEC_PRINT_MS);
}, 120_000);

// The owner path's speed gate lives in test/implicit-speed-owners.test.js: its own file, so the
// load of the meshes above (GC, heap) never decides it.
