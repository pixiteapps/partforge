// A CPU clock in the calibration machine's milliseconds, for the timing tests whose
// limits are absolute CPU time (test/arc-fit.test.js, test/sheet-dfm.test.js).
//
// Those limits were set on one desktop with about 2× headroom. CI runs on GitHub's
// ubuntu-latest, typically 1.5–3× slower per core, with vitest running files in
// parallel, and a red `test` check blocks every PR. So this module measures, once per
// test file, how much slower the runner is — PACE — and `cpuMs` is main-thread CPU time
// divided by it. On `cpuMs` every limit is multiplied by PACE (100 ms is 100 × PACE ms of
// this runner's CPU), and so is a real deadline: LASER.facts({ deadline: cpuMs() + 1500,
// now: cpuMs }) gives the meter 1500 × PACE ms. Running the meter itself on the paced
// clock — rather than widening its deadline alone — is what makes a slower runner read
// what the calibration machine reads: the meter prices a step before its own pace is
// known (under 50 ms priced) at 1 × its price, so with only the deadline widened a slow
// runner would START steps the calibration machine withholds. It makes a step's ms per
// price machine-relative too, so `3 × its price` needs no scaling. A lone overrun cannot
// set its own allowance, as a pace taken from the steps under test once did: PACE comes
// from a separate workload, below.
//
// The workload: LASER.facts, no deadline, on one fixed 100 × 60 × 3 plate — rounded
// corners, four M3 holes and two rectangular holes leaving a 1 mm web, drawn as lines
// and exact arcs. It has no cubics, so neither the arc fit nor the slow band's
// flattening — what the timing tests judge — ever runs in it: a regression there cannot
// raise PACE. Twelve warm-up readings, then seven runs of ten readings (about 75 ms a
// run here); the MEDIAN run is the measurement. V8 is still tiering the code up over
// the first few runs, and under parallel load the median follows the contention the
// tests themselves will meet where the fastest run does not.
//
// REFERENCE_MS is the SLOWEST of twenty fresh-process measurements inside vitest on the
// calibration machine (Apple M-series, 10 cores, Node 24.19, desktop background load
// only, 2026-09-29: 72.4–82.2 ms, median 74.5) — not their median, so that machine
// always reads PACE 1 and no limit is loosened there; a runner is credited only with
// slowness past that noise. PACE is clamped to CEILING: a runner more than 6× slower
// fails loudly instead of passing whatever it runs.
//
// PF_CPU_PACE=<n> (1 ≤ n ≤ 6) forces PACE and skips the measurement — to show a test
// still fails on a regression with its limits scaled as a slow runner would scale them,
// or passes on a slow machine only because of the scaling.
//
// Manifold only: OCCT must not boot in the same process, so no OCCT test may import this.
import { bootManifoldKernel } from "../../src/testing.js";
import { sheetPart } from "../../src/framework/geometry/polygon.js";
import { resolveSheet } from "../../src/framework/sheet/resolve.js";
import { LASER } from "../../src/framework/process/laser/descriptor.js";

const REFERENCE_MS = 82.2;
const CEILING = 6;

const threadMs = () => { const u = process.threadCpuUsage(); return (u.user + u.system) / 1000; };

// Lines and exact arcs only (`via` segments): nothing here is a cubic.
function referencePlate() {
  const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const circle = (cx, cy, r) => ({ start: [cx + r, cy], segments: [{ to: [cx - r, cy], via: [cx, cy + r] }, { to: [cx + r, cy], via: [cx, cy - r] }] });
  const r = 4, c = r * (1 - Math.SQRT1_2);
  const outer = { start: [r, 0], segments: [
    { to: [100 - r, 0] }, { to: [100, r], via: [100 - c, c] },
    { to: [100, 60 - r] }, { to: [100 - r, 60], via: [100 - c, 60 - c] },
    { to: [r, 60] }, { to: [0, 60 - r], via: [c, 60 - c] },
    { to: [0, r] }, { to: [r, 0], via: [c, c] }] };
  const holes = [circle(8, 8, 1.7), circle(92, 8, 1.7), circle(92, 52, 1.7), circle(8, 52, 1.7), rect(30, 20, 49.5, 40), rect(50.5, 20, 70, 40)];
  return sheetPart({ views: ["v"], label: "Pace reference", material: "birch plywood", thickness: 3, profile: (kk) => kk.shape2d({ outer, holes }) });
}

async function measurePace() {
  const k = await bootManifoldKernel();
  const plate = referencePlate();
  const read = () => LASER.facts(resolveSheet(k, plate, {}, {}));
  for (let i = 0; i < 12; i++) read();
  const ten = () => { const t0 = threadMs(); for (let i = 0; i < 10; i++) read(); return threadMs() - t0; };
  const ms = Array.from({ length: 7 }, ten).sort((a, b) => a - b)[3];
  return Math.min(CEILING, Math.max(1, ms / REFERENCE_MS));
}

function forcedPace(raw) {
  const n = Number(raw);
  if (!(n >= 1 && n <= CEILING)) throw new Error(`PF_CPU_PACE must be a number from 1 to ${CEILING}, got ${JSON.stringify(raw)}`);
  return n;
}

export const PACE = process.env.PF_CPU_PACE ? forcedPace(process.env.PF_CPU_PACE) : await measurePace();

// Main-thread CPU time in the calibration machine's milliseconds: a clock the machine's
// load cannot stretch, running 1/PACE as fast as this runner's CPU.
export const cpuMs = () => threadMs() / PACE;
