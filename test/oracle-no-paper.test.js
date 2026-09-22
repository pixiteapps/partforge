import { expect, test, vi } from "vitest";

// The oracle's shape summariser (shape-probe.js, new in 0.120.0) used to import
// arcCenterAndSweep/cubicAt/profileCorners from paper-bridge.js/contour-ops.js, which both
// pull in "paper/dist/paper-core.js" — a module that builds a PaperScope and probes a canvas
// at IMPORT TIME, not lazily. Because measure.js imports shape-probe.js statically, every
// consumer of measure() (the geometry worker, partforge/testing, the CLI) paid paper-core's
// boot at module load, which crashed a DOM-less worker environment (partforge-cloud's fake
// worker has no `navigator`) and broke the CLI's `ingest` verb (paper-core must load AFTER
// ingest's installNodeDom() runs, never before).
//
// This mock makes paper-core throw the moment anything imports it, so importing measure.js/
// shape-probe.js must resolve WITHOUT ever reaching that import — proving the oracle's own
// arc/corner math is paper-free (arc-math.js, contour-corners.js).
vi.mock("paper/dist/paper-core.js", () => {
  throw new Error("paper-core loaded eagerly by the oracle");
});

test("oracle/measure.js imports without loading paper-core", async () => {
  await expect(import("../src/framework/oracle/measure.js")).resolves.toBeTruthy();
});

test("oracle/shape-probe.js imports without loading paper-core", async () => {
  await expect(import("../src/framework/oracle/shape-probe.js")).resolves.toBeTruthy();
});
