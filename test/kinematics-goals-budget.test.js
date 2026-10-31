// The goal solve's cost budget: a met goal stops the DLS (goals.js SOLVED) instead of
// running all 64 iterations. A pose drag derives the robot arm twice per frame, each a
// goal solve warm-started from the last frame's angles, so this is the drag's frame rate.
import { describe, it, expect, vi } from "vitest";

const calls = { residuals: 0 };
vi.mock("../src/framework/solve/dls.js", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    solveDLS: (opts) => real.solveDLS({ ...opts, residuals: (x) => { calls.residuals++; return opts.residuals(x); } }),
  };
});

const { default: arm } = await import("../src/parts/robot-arm.js");
const { resolveParams } = await import("../src/framework/part-model.js");

const JOINTS = arm.handles.tool.seed;
const FULL = 64 * (2 * JOINTS.length + 1); // every iteration: 2 probes per DOF and a step

describe("goal solve budget", () => {
  it("a reachable goal stops well short of the iteration cap, and a warm start in a few", () => {
    calls.residuals = 0;
    const { d } = resolveParams(arm, {});
    expect(d.arm.report.goals[0].status).toBe("reached");
    expect(calls.residuals).toBeLessThan(FULL / 4);
    // Warm start: the seed is the solution, so the solve is all but done on entry.
    const solved = Object.fromEntries(JOINTS.map((k, i) => [k, d.arm.values[i]]));
    calls.residuals = 0;
    const again = resolveParams(arm, solved).d;
    expect(calls.residuals).toBeLessThanOrEqual(2 * (2 * JOINTS.length + 1) + 1);
    expect(again.arm.report.goals).toEqual(d.arm.report.goals);
  });
});
