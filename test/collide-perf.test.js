// Frame-time pins for Pose mode's collision layer: a drag frame's solve and its settle, on the hand's and the robot arm's real Manifold meshes.
//
// Timed in CPU milliseconds of the calibration machine (test/helpers/cpu-pace.js: a slower
// runner's time is divided by its measured pace), median over a drag in fine steps —
// about 1-3 mm of tip travel a frame, what a pointer drag produces — after one warm-up
// pass of the same drag (the first posed query per mesh builds its slabs and planes, and
// V8 tiers the code up). Each limit is twice its target: the pins catch a lever lost, not
// a noisy runner. PF_PERF_LOG=1 prints the medians.
//
// Targets (vitest wall clock, desktop) and what this desktop reads: hand solve 12 ms (open
// air 10); settle 4 ms for a frame that moves a few mm in open air (4.5-4.7), 10 ms for one
// that bisects to contact and slides; arm goal frame through the session, 15 ms (8: the
// frames that meet the block cost about 25, the next ones slide the target along it and
// are cheap). A settle pushed straight at the block every frame, with no target sliding,
// is the worst case and has no target to meet: it reads 20-27 here, and a CI runner 40,
// each frame paying for finite differences through derive's IK. It is pinned at 60.
import { beforeAll, describe, expect, it } from "vitest";
import hand from "../src/parts/hand.js";
import robotArm from "../src/parts/robot-arm.js";
import { bootManifoldKernel } from "../src/testing.js";
import { buildView } from "../src/framework/oracle/build.js";
import { resolveParams } from "../src/framework/part-model.js";
import { withDeriveMemo } from "../src/framework/derive-memo.js";
import { createCollisionWorld } from "../src/framework/collide/world.js";
import { normalizeCollisions } from "../src/framework/collide/declaration.js";
import { createPartGuard, movingSubParts } from "../src/framework/collide/part-guard.js";
import { solveAngles, dofsOf } from "../src/framework/pose/param-solve.js";
import { createPoseSession, defaultSolve } from "../src/framework/pose/pose-session.js";
import { cpuMs } from "./helpers/cpu-pace.js";

const SLOW = 180_000;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

let k, handWorld, armWorld;
const allHandles = Object.values(hand.handles);
const tipAt = (q) => resolveParams(hand, { ...hand.defaults, ...q }).d.index.world("tip").origin;
const worldOf = (part) => createCollisionWorld({ meshes: new Map(buildView(k, part, "assembly", part.defaults).map((b) => [b.name, b.mesh])), decl: normalizeCollisions(part) });
// the arm drag's block under the tool, as in pose-param-solve-collide.test.js
const blocked = { ...robotArm, collisions: {}, parts: { ...robotArm.parts, block: { label: "Block", build: (kk) => kk.box({ min: [150, -40, 0], max: [260, 40, 40] }), views: { assembly: (sol) => sol } } } };

beforeAll(async () => {
  k = await bootManifoldKernel();
  handWorld = worldOf(hand);
  armWorld = worldOf(blocked);
}, SLOW);

/**
 * One drag: `targets` frame by frame, each solved (`solve(params, target)`) and
 * settled, twice over — the first pass warms up, the second is timed. Returns the timed
 * pass's per-frame solve and settle CPU times, and what each frame settled on.
 */
function drag({ part, world, start, moving, targets, solve }) {
  let out = null;
  for (let pass = 0; pass < 2; pass++) {
    const { guard } = createPartGuard({ part, world, start, meshAt: part.defaults, moving });
    let params = { ...start };
    const solveMs = [], settleMs = [], blocked = [];
    for (const target of targets) {
      withDeriveMemo(() => {
        let t = cpuMs();
        const r = solve(params, target);
        solveMs.push(cpuMs() - t);
        t = cpuMs();
        const s = guard.settle(params, r.blend(1), { blend: r.blend });
        settleMs.push(cpuMs() - t);
        blocked.push(s.blocked);
        params = s.params;
      });
    }
    out = { solveMs, settleMs, blocked, guard, params };
  }
  if (process.env.PF_PERF_LOG) console.log(JSON.stringify({ solve: median(out.solveMs), settle: median(out.settleMs), frame: median(out.solveMs.map((v, i) => v + out.settleMs[i])), bisected: median(out.settleMs.filter((_, i) => out.blocked[i])) }));
  return out;
}

describe("collision frame times", () => {
  it("hand, open air: a solve and its settle", () => {
    // the wrist is free, so every piece moves: the hand's 21 pins all ride along
    const start = { ...hand.defaults };
    const handle = hand.handles.index;
    const moving = movingSubParts(hand, "assembly", start, dofsOf(handle, allHandles, start));
    const targets = Array.from({ length: 30 }, (_, i) => tipAt({ indexKnuckle: (30 * (i + 1)) / 30, indexCurl: (0.3 * (i + 1)) / 30 }));
    const r = drag({
      part: hand, world: handWorld, start, moving, targets,
      solve: (params, target) => solveAngles({ part: hand, params, handle, grab: "tip", target, allHandles }),
    });
    expect(r.blocked.every((b) => b === null)).toBe(true);
    expect(median(r.solveMs)).toBeLessThan(24);  // target 12
    expect(median(r.settleMs)).toBeLessThan(8);  // target 4
  }, SLOW);

  it("hand, pushed into the next finger: settle bisects to contact and slides", () => {
    // the solve walks the tip into the middle finger; settle stops it at contact
    const start = { ...hand.defaults, thumbLock: true };
    const handle = hand.handles.index;
    const moving = movingSubParts(hand, "assembly", start, dofsOf(handle, allHandles, start));
    const from = tipAt(start), goal = tipAt({ ...start, indexKnuckle: 50, indexCurl: 0.4, indexSpread: -15 });
    const targets = Array.from({ length: 30 }, (_, i) => from.map((v, c) => v + ((goal[c] - v) * (i + 1)) / 30));
    const r = drag({
      part: hand, world: handWorld, start, moving, targets,
      solve: (params, target) => solveAngles({ part: hand, params, handle, grab: "tip", target, allHandles }),
    });
    const bisected = r.settleMs.filter((_, i) => r.blocked[i]);
    expect(bisected.length).toBeGreaterThan(5);
    // target 10: the bisection to contact, then the slide's contact read and projected walk
    expect(median(bisected)).toBeLessThan(20);
  }, SLOW);

  describe("robot arm, onto a block", () => {
    const handle = blocked.handles.tool;
    const goalKeys = [...handle.params.position, ...handle.params.aim];
    const start = { ...blocked.defaults };
    const tip = (q) => resolveParams(blocked, { ...blocked.defaults, ...q }).d.arm.world("tip").origin;
    const from = tip(start), goal = [170, 0, 20];
    const targets = Array.from({ length: 12 }, (_, i) => from.map((v, c) => v + ((goal[c] - v) * (i + 1)) / 12));
    const movingNow = () => movingSubParts(blocked, "assembly", start, goalKeys);

    it("a goal frame, as a drag runs it: through the session", () => {
      // settle plus the session's target sliding along the contact, warmed up as drag() is
      const moving = movingNow();
      let ms, guard, params;
      for (let pass = 0; pass < 2; pass++) {
        ({ guard } = createPartGuard({ part: blocked, world: armWorld, start, meshAt: blocked.defaults, moving }));
        params = { ...start };
        ms = [];
        const session = createPoseSession({ part: blocked, getParams: () => params, write: (v) => Object.assign(params, v), commit() {}, restore() {}, collide: () => guard });
        session.begin("tool", "tip");
        for (const target of targets) withDeriveMemo(() => { const t = cpuMs(); session.frame(target); ms.push(cpuMs() - t); });
        session.end();
      }
      if (process.env.PF_PERF_LOG) console.log(JSON.stringify({ sessionFrame: median(ms) }));
      expect(guard.isClear(params)).toBe(true);
      expect(median(ms)).toBeLessThan(30); // target 15
    }, SLOW);

    it("the worst case: settle pushed at the block every frame", () => {
      const r = drag({
        part: blocked, world: armWorld, start, moving: movingNow(), targets,
        solve: (params, target) => defaultSolve({ part: blocked, params, handle, grab: "tip", target }),
      });
      expect(r.guard.isClear(r.params)).toBe(true);
      expect(median(r.solveMs.map((v, i) => v + r.settleMs[i]))).toBeLessThan(60); // see the header
    }, SLOW);
  });
});
