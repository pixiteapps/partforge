// The inverse-kinematics reference part (src/parts/robot-arm.js): a 6-axis arm posed by
// one goal — tool position plus pitch/yaw/roll — solved in derive from a seed of joint
// angles, with a goal-mode `tool` handle and a `tool` probe that reports the miss.
import { execFileSync } from "node:child_process";
import { beforeAll, expect, test } from "vitest";
import part from "../src/parts/robot-arm.js";
import { bootManifoldKernel, measure } from "../src/testing.js";
import { lintPart } from "../src/lint.js";
import { probePoses } from "../src/framework/pose-probe.js";
import { resolveParams } from "../src/framework/part-model.js";

const JOINTS = ["base", "shoulder", "elbow", "wristPitch", "wristYaw", "wristRoll"];
const solve = (over = {}) => resolveParams(part, over).d.arm;
const goalOf = (arm) => arm.report.goals[0];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

test("a 6-axis limb, a goal-mode tool handle seeded by the six joint params, and a tool probe", () => {
  const arm = solve();
  expect(arm.joints).toEqual(JOINTS.map((j) => `arm.${j}`));
  expect(part.handles.tool).toEqual({
    limb: "arm", at: "tip", mode: "goal",
    params: { position: ["toolX", "toolY", "toolZ"], aim: ["toolPitch", "toolYaw", "toolRoll"] },
    toward: [1, 0, 0],
    seed: JOINTS,
  });
  for (const key of ["gripper", "upperLen", "foreLen", ...JOINTS]) expect(typeof part.defaults[key], key).toBe("number");
  expect(Object.keys(part.probes)).toEqual(["tool"]);
});

test("the default parameters reach the goal", () => {
  const g = goalOf(solve());
  expect(g.status).toBe("reached");
  expect(g.residual).toBeLessThanOrEqual(0.01);
  // The probe is the one-line agent read-out: the same report entry.
  const { p, d } = resolveParams(part, {});
  expect(part.probes.tool(k, p, d)).toEqual(g);
});

test("a longer upper arm still reaches: the goal holds, the tip stays within 0.01 mm", () => {
  const arm = solve({ upperLen: part.defaults.upperLen + 20 });
  expect(goalOf(arm).status).toBe("reached");
  const want = [part.defaults.toolX, part.defaults.toolY, part.defaults.toolZ];
  expect(dist(arm.report.tip, want)).toBeLessThanOrEqual(0.01);
});

test("a goal twice out of reach reports too-far", () => {
  const reach = part.defaults.upperLen + part.defaults.foreLen + 200;
  expect(goalOf(solve({ toolX: 2 * reach, toolY: 0 })).status).toBe("too-far");
});

test("sweeping toolX out past full stretch and back, re-seeding each step, never flips the elbow", () => {
  const seedOf = (arm) => {
    const out = {};
    JOINTS.forEach((j, i) => { out[j] = arm.values[i]; });
    return out;
  };
  let seed = Object.fromEntries(JOINTS.map((j) => [j, part.defaults[j]]));
  let prev = part.defaults.elbow;
  const x0 = part.defaults.toolX, steps = 60, span = 180;
  const xs = [];
  for (let i = 1; i <= steps; i++) xs.push(x0 + (span * i) / steps);      // out, past the reach
  for (let i = steps - 1; i >= 0; i--) xs.push(x0 + (span * i) / steps);  // and back
  const statuses = new Set();
  for (const toolX of xs) {
    const arm = solve({ ...seed, toolX });
    const elbow = arm.values[2];
    expect(Math.abs(elbow - prev), `toolX ${toolX}`).toBeLessThanOrEqual(10);
    statuses.add(goalOf(arm).status);
    prev = elbow;
    seed = seedOf(arm);
  }
  // The sweep did cross out of reach and back.
  expect(statuses.has("reached")).toBe(true);
  expect([...statuses].some((s) => s !== "reached")).toBe(true);
  expect(goalOf(solve({ ...seed, toolX: x0 })).status).toBe("reached");
});

test("posing is matrix-only: every sub-part probe-trusted, one baseHash across two goals", () => {
  const a = probePoses(part, "assembly", {});
  const b = probePoses(part, "assembly", { toolX: part.defaults.toolX - 40, toolZ: part.defaults.toolZ + 30, toolYaw: 20 });
  for (const name of Object.keys(part.parts)) {
    expect(a.get(name).trusted, name).toBe(true);
    expect(b.get(name).baseHash, name).toBe(a.get(name).baseHash);
  }
});

test("lints with no errors", () => {
  const r = lintPart(part);
  expect(r.errors).toEqual([]);
});

test("measure: no interpenetrating sub-parts at the default pose", () => {
  expect(measure(k, part, "assembly").overlaps).toEqual([]);
});

test("npx partforge measure exits 0", () => {
  // execFileSync throws on a non-zero exit.
  const out = execFileSync(process.execPath, ["bin/cli.js", "measure", "src/parts/robot-arm.js"], { encoding: "utf8" });
  expect(out).toMatch(/probes/);
}, 120000);
