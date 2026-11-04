// Pose mode's solves settled through the drag guard: a dragged piece that meets another
// slides along it instead of stopping dead, and a goal drag (the robot arm) writes the
// goal directly and slides the same way.
//
// Real meshes: hand.js and robot-arm.js built by Manifold at their defaults (buildView),
// placed per params by relativeMatsAt (createPartGuard). Every solve runs inside
// withDeriveMemo, as Pose mode's frames do.
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
import { solveAngles, dofsOf, goalValues, seedValues } from "../src/framework/pose/param-solve.js";
import { createPoseSession, defaultSolve } from "../src/framework/pose/pose-session.js";

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const SLOW = 120_000;

let k;
const worlds = new Map();
/** One collision world per part, over its meshes built at the defaults. */
function worldOf(part) {
  if (!worlds.has(part)) {
    const meshes = new Map(buildView(k, part, "assembly", part.defaults).map((b) => [b.name, b.mesh]));
    worlds.set(part, createCollisionWorld({ meshes, decl: normalizeCollisions(part) }));
  }
  return worlds.get(part);
}
const guardFor = (part, start, moving) => createPartGuard({ part, world: worldOf(part), start, meshAt: part.defaults, moving }).guard;

beforeAll(async () => { k = await bootManifoldKernel(); });

describe("dofsOf", () => {
  it("is exported: a handle's params less a locked handle's", () => {
    const all = Object.values(hand.handles);
    expect(dofsOf(hand.handles.index, all, { ...hand.defaults })).toEqual(hand.handles.index.params);
    expect(dofsOf(hand.handles.index, all, { ...hand.defaults, thumbLock: true })).toEqual(["indexKnuckle", "indexCurl", "indexSpread"]);
  });
});

describe("hand: angles drags", () => {
  const handle = hand.handles.index;
  const allHandles = Object.values(hand.handles);
  const tipAt = (q) => resolveParams(hand, { ...hand.defaults, ...q }).d.index.world("tip").origin;

  it("hand pin pairs leave an open-air drag unchanged", () => {
    // Every pin pair sits at ~0.4 mm from the start, clear of contact: settle takes the
    // solve's whole answer.
    const start = { ...hand.defaults };
    const moving = movingSubParts(hand, "assembly", start, dofsOf(handle, allHandles, start));
    expect(moving).toContain("palm");          // the wrist is a DOF: the pin pairs all move
    const guard = guardFor(hand, start, moving);
    let params = { ...start };
    for (let i = 0; i < 10; i++) {
      // a few mm a frame: a flick past MAX_SUBSTEPS' travel lags by design
      const target = tipAt({ indexKnuckle: start.indexKnuckle + i + 1, indexCurl: start.indexCurl + 0.01 * (i + 1) });
      withDeriveMemo(() => {
        const r = solveAngles({ part: hand, params, handle, grab: "tip", target, allHandles });
        const s = guard.settle(params, r.blend(1), { blend: r.blend });
        expect(s.blocked, `${i}`).toBeNull();
        for (const key of Object.keys(r.values)) expect(s.params[key], `${i} ${key}`).toBe(r.values[key]);
        params = s.params;
      });
    }
  }, SLOW);

  it("a tip pushed into the next finger slides", () => {
    // hand.js's fingers cannot reach the palm at any curl (by design: a fist prints with
    // no collision), so the obstacle is the middle finger: the index is dragged toward
    // the tip of a pose that spreads it 15° into the middle finger while bending it.
    // The wrist is held (a locked thumb freezes every param it lists), so the index's
    // knuckle, curl and spread are the DOFs.
    const start = { ...hand.defaults, thumbLock: true };
    const keys = dofsOf(handle, allHandles, start);
    const moving = movingSubParts(hand, "assembly", start, keys);
    const from = tipAt(start);
    const goal = tipAt({ ...start, indexKnuckle: 50, indexCurl: 0.4, indexSpread: -15 });
    const drag = (opts) => {
      const guard = guardFor(hand, start, moving);
      let params = { ...start }, blocked = null;
      const N = 8;
      for (let i = 1; i <= N; i++) {
        const target = from.map((v, c) => v + ((goal[c] - v) * i) / N);
        withDeriveMemo(() => {
          const r = solveAngles({ part: hand, params, handle, grab: "tip", target, allHandles });
          const s = guard.settle(params, r.blend(1), { blend: r.blend, ...opts });
          params = s.params;
          blocked = s.blocked ?? blocked;
        });
      }
      return { params, guard, blocked };
    };
    // a pinDrift that reads every slide as moving a pin: stop-dead
    const dead = drag({ pinDrift: () => Infinity });
    const slid = drag({});
    expect(dead.blocked).not.toBeNull();       // the drag met the middle finger
    expect(slid.guard.isClear(slid.params)).toBe(true);
    expect(dist(tipAt(slid.params), goal)).toBeLessThan(dist(tipAt(dead.params), goal) - 5);
  }, SLOW);

  it("a tip held against the next finger, pulled mostly along it, slides instead of sticking", () => {
    // The index spread into the middle finger until it stops, then curled toward a point
    // half a degree of spread away from it: nearly tangent. The old per-param retry kept
    // nothing of such a move (a curl alone grazes the rounded neighbour within a sub-step),
    // so the finger stuck. The projected slide lifts it a skin off and moves along it.
    const start = { ...hand.defaults, thumbLock: true };
    const moving = movingSubParts(hand, "assembly", start, dofsOf(handle, allHandles, start));
    const guard = guardFor(hand, start, moving);
    const from = tipAt(start), into = tipAt({ ...start, indexSpread: -15 });
    const frame = (params, target) => {
      let s;
      withDeriveMemo(() => {
        const r = solveAngles({ part: hand, params, handle, grab: "tip", target, allHandles });
        s = guard.settle(params, r.blend(1), { blend: r.blend });
      });
      return s;
    };
    let params = { ...start }, blocked = null;
    for (let i = 1; i <= 10; i++) ({ params, blocked = blocked } = frame(params, from.map((v, c) => v + ((into[c] - v) * i) / 10)));
    expect(blocked).not.toBeNull();
    const held = tipAt(params);
    const away = tipAt({ ...params, indexSpread: params.indexSpread + 0.5, indexKnuckle: 60 });
    for (let i = 1; i <= 15; i++) params = frame(params, held.map((v, c) => v + ((away[c] - v) * i) / 15)).params;
    expect(guard.isClear(params)).toBe(true);
    expect(dist(tipAt(params), away)).toBeLessThan(2);
    expect(dist(tipAt(params), held)).toBeGreaterThan(30);
  }, SLOW);
});

describe("robot arm: goal drags", () => {
  const arm = { ...robotArm, collisions: {} };
  const handle = arm.handles.tool;
  const goalKeys = [...handle.params.position, ...handle.params.aim];
  const tipOf = (q) => resolveParams(arm, { ...arm.defaults, ...q }).d.arm.world("tip").origin;
  const movingOf = (start) => movingSubParts(arm, "assembly", start, goalKeys);

  /** Drag `handleId` by `grab` through the real session: settle and the slid target together. */
  function sessionDrag(part, start, moving, grab, targets) {
    const guard = guardFor(part, start, moving);
    const params = { ...start };
    const s = createPoseSession({ part, getParams: () => params, write: (v) => Object.assign(params, v), commit() {}, restore() {}, collide: () => guard });
    s.begin("tool", grab);
    for (const t of targets) withDeriveMemo(() => s.frame(t));
    s.end();
    return { params, guard };
  }
  const line = (from, goal, n) => Array.from({ length: n }, (_, i) => from.map((v, c) => v + ((goal[c] - v) * (i + 1)) / n));
  const withBlock = (box) => ({ ...arm, parts: { ...arm.parts, block: { label: "Block", build: (kk) => kk.box(box), views: { assembly: (sol) => sol } } } });

  it("goal drags slide on the arm", () => {
    // The arm's own links never come near anything but their pin neighbours (its joint
    // limits stop a goal pushed into the turret or pedestal well short), so the test adds
    // a block on the table under the default tool, top at z = 40, and drags the tool down
    // and back into it: the fingers land on its top and slide along it toward the goal's x.
    const blocked = withBlock({ min: [150, -40, 0], max: [260, 40, 40] });
    const start = { ...blocked.defaults };
    const tip = (q) => resolveParams(blocked, { ...blocked.defaults, ...q }).d.arm.world("tip").origin;
    const { params, guard } = sessionDrag(blocked, start, movingSubParts(blocked, "assembly", start, goalKeys), "tip", line(tip(start), [170, 0, 20], 40));
    expect(guard.isClear(params)).toBe(true);
    // the goal written is the pose on screen: derive reproduces it
    const tool = tip(params);
    expect(dist(tool, [params.toolX, params.toolY, params.toolZ])).toBeLessThan(0.5);
    expect(tool[2]).toBeGreaterThan(40);           // on the block, not in it
    expect(tool[0]).toBeLessThan(180);             // and slid along it toward the goal
  }, SLOW);

  it("a mid-joint grab is guarded too: the elbow stops under a block", () => {
    // A goal limb grabbed by a middle joint solves the seeded joints for the elbow, and
    // settle stops the frame, so the upper arm stops short of a block above it while the
    // unguarded grab lifts it into the block.
    const blocked = withBlock({ min: [-20, -40, 275], max: [140, 40, 320] });
    const start = { ...blocked.defaults };
    const moving = movingSubParts(blocked, "assembly", start, [...goalKeys, ...handle.seed]);
    const elbow = (q) => resolveParams(blocked, { ...blocked.defaults, ...q }).d.arm.world("elbow").origin;
    const from = elbow(start), targets = line(from, [40, 0, 330], 12);
    let free = { ...start };
    for (const target of targets) withDeriveMemo(() => { free = { ...free, ...defaultSolve({ part: blocked, params: free, handle, grab: "elbow", target }).values }; });
    const { params: guarded, guard } = sessionDrag(blocked, start, moving, "elbow", targets);
    expect(guard.isClear(free)).toBe(false);
    expect(guard.isClear(guarded)).toBe(true);
    expect(elbow(guarded)[2]).toBeGreaterThan(from[2] + 5);       // it still rose toward the pointer
    expect(elbow(guarded)[2]).toBeLessThan(elbow(free)[2] - 1);  // but short of the free grab
  }, SLOW);

  it("open-air goal drag writes the goal directly", () => {
    const start = { ...arm.defaults };
    const guard = guardFor(arm, start, movingOf(start));
    const target = [400, 0, 300];   // past the arm's reach
    const r = withDeriveMemo(() => defaultSolve({ part: arm, params: start, handle, grab: "tip", target }));
    const values = goalValues({ handle, point: target, part: arm });
    expect(r.values).toEqual({ ...values, ...seedValues({ part: arm, params: { ...start, ...values }, handle }) });
    expect(withDeriveMemo(() => guard.settle(start, r.blend(1), { blend: r.blend })).blocked).toBeNull();
    const { p, d } = resolveParams(arm, { ...start, ...r.values });
    expect(arm.probes.tool(null, p, d).status).not.toBe("reached");
  }, SLOW);
});
