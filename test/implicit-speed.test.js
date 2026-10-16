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
// sample / mesh / cleanup / detail on one native session. It must be the native path —
// a refusal would time the JS fallback instead, so a null answer fails the test.
import { expect, test } from "vitest";
import { PACE, cpuMs } from "./helpers/cpu-pace.js";
import { core, setCoreEnabled } from "../src/framework/core/core.js";
import { meshImplicitCore } from "../src/framework/core/implicit-core.js";
import { compileImplicit } from "../src/framework/geometry/implicit/index.js";
import { planLeaves } from "../src/framework/geometry/implicit/sparse.js";
import { handSpec } from "./fixtures/implicit-trees.js";

const SPEC_PREVIEW_MS = 150;
const SPEC_PRINT_MS = 2000;

function nativeHand(edge) {
  const compiled = compileImplicit(handSpec());
  const out = meshImplicitCore(compiled, edge, planLeaves(compiled, edge));
  expect(out, `the native path answered at ${edge} mm`).not.toBeNull();
  return out;
}

// The median of `runs` timings, so one descheduled run under vitest's parallel files
// cannot fail the gate on its own.
function medianMs(edge, runs) {
  const ms = [];
  for (let i = 0; i < runs; i++) {
    const t0 = cpuMs();
    const out = nativeHand(edge);
    ms.push(cpuMs() - t0);
    expect(out.indices.length).toBeGreaterThan(0);
  }
  return ms.sort((a, b) => a - b)[runs >> 1];
}

test("the hand at full detail meshes natively within 3× the spec's targets (preview 1.5 mm, print 0.5 mm)", () => {
  setCoreEnabled(true);
  expect(core(), "the native core is available").toBeTruthy();
  nativeHand(1.4);   // warm-up on another grid: the JS front end tiers up, the core boots
  const preview = medianMs(1.5, 5);
  expect(preview, `hand 1.5 mm: ${preview.toFixed(0)} ms (pace ${PACE.toFixed(2)})`).toBeLessThan(3 * SPEC_PREVIEW_MS);
  const print = medianMs(0.5, 3);
  expect(print, `hand 0.5 mm: ${print.toFixed(0)} ms (pace ${PACE.toFixed(2)})`).toBeLessThan(3 * SPEC_PRINT_MS);
}, 120_000);
