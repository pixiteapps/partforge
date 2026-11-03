// Collision rows in Pose mode's parameter solves (spec "Pose mode: collision in the
// solver"): the drag guard's rows ride beside the target's, so a dragged piece that meets
// another slides along it instead of stopping dead; goal drags (the robot arm) switch to
// the joint-space solve near an obstacle and write the goal directly in open air.
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
import { defaultSolve } from "../src/framework/pose/pose-session.js";

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

  it("hand pin pairs leave an open-air solve unchanged", () => {
    // Every pin pair sits at ~0.4 mm, inside the band, from the start: guard-only, no rows.
    const start = { ...hand.defaults };
    const moving = movingSubParts(hand, "assembly", start, dofsOf(handle, allHandles, start));
    expect(moving).toContain("palm");          // the wrist is a DOF: the pin pairs all move
    const guard = guardFor(hand, start, moving);
    let plain = { ...start }, guarded = { ...start };
    for (let i = 0; i < 10; i++) {
      const target = tipAt({ indexKnuckle: 10 * i, indexCurl: 0.1 * i });
      withDeriveMemo(() => {
        const a = solveAngles({ part: hand, params: plain, handle, grab: "tip", target, allHandles });
        const b = solveAngles({ part: hand, params: guarded, handle, grab: "tip", target, allHandles, collide: guard });
        for (const key of Object.keys(a.values)) expect(Math.abs(b.values[key] - a.values[key]), `${i} ${key}`).toBeLessThan(1e-9);
        plain = { ...plain, ...a.values };
        guarded = { ...guarded, ...b.values };
      });
    }
  }, SLOW);

  it("a tip pushed into the next finger slides", () => {
    // hand.js's fingers cannot reach the palm at any curl (by design: a fist prints with
    // no collision), so the obstacle is the middle finger: the index is dragged toward
    // the tip of a pose that spreads it 15° into the middle finger while bending it.
    // The wrist is held (a locked thumb freezes every param it lists), so the index's
    // knuckle, curl and spread are the DOFs. Stop-dead: the plain solve, settled.
    const start = { ...hand.defaults, thumbLock: true };
    const keys = dofsOf(handle, allHandles, start);
    const moving = movingSubParts(hand, "assembly", start, keys);
    const from = tipAt(start);
    const goal = tipAt({ ...start, indexKnuckle: 50, indexCurl: 0.4, indexSpread: -15 });
    const drag = (collided) => {
      const guard = guardFor(hand, start, moving);
      let params = { ...start }, blocked = null;
      const N = 8;
      for (let i = 1; i <= N; i++) {
        const target = from.map((v, c) => v + ((goal[c] - v) * i) / N);
        withDeriveMemo(() => {
          const r = solveAngles({ part: hand, params, handle, grab: "tip", target, allHandles, collide: collided ? guard : null });
          const s = guard.settle(params, r.blend(1), { blend: r.blend });
          params = s.params;
          blocked = s.blocked ?? blocked;
        });
      }
      return { params, guard, blocked };
    };
    const dead = drag(false);
    const slid = drag(true);
    expect(dead.blocked).not.toBeNull();       // the plain drag met the middle finger
    expect(slid.guard.isClear(slid.params)).toBe(true);
    const deadMiss = dist(tipAt(dead.params), goal), slidMiss = dist(tipAt(slid.params), goal);
    expect(slidMiss).toBeLessThan(deadMiss - 5);
  }, SLOW);
});

describe("robot arm: goal drags", () => {
  const arm = { ...robotArm, collisions: {} };
  const handle = arm.handles.tool;
  const goalKeys = [...handle.params.position, ...handle.params.aim];
  const tipOf = (q) => resolveParams(arm, { ...arm.defaults, ...q }).d.arm.world("tip").origin;
  const movingOf = (start) => movingSubParts(arm, "assembly", start, goalKeys);

  it("goal drags slide on the arm", () => {
    // From the default pose, the tool is dragged toward a point inside the turret post.
    const start = { ...arm.defaults };
    const guard = guardFor(arm, start, movingOf(start));
    const from = tipOf(start), goal = [-26, 0, 80];
    let params = { ...start }, last = null, rows = 0;
    const N = 12;
    for (let i = 1; i <= N; i++) {
      const target = from.map((v, c) => v + ((goal[c] - v) * i) / N);
      withDeriveMemo(() => {
        last = defaultSolve({ part: arm, params, handle, grab: "tip", target, collide: guard });
        rows = guard.rowCount;
        params = guard.settle(params, last.blend(1), { blend: last.blend }).params;
      });
    }
    expect(rows).toBeGreaterThan(0);              // the last frame took the joint-space path
    expect(guard.isClear(params)).toBe(true);
    for (const key of [...handle.seed, ...goalKeys]) expect(Object.keys(last.values)).toContain(key);
    // the goal written is the pose on screen: derive reproduces it
    const tool = tipOf(params);
    expect(dist(tool, [params.toolX, params.toolY, params.toolZ])).toBeLessThan(0.5);
    expect(dist(tool, goal)).toBeGreaterThan(5);  // it stayed out of the turret
  }, SLOW);

  it("open-air goal drag writes the goal directly", () => {
    const start = { ...arm.defaults };
    const guard = guardFor(arm, start, movingOf(start));
    const target = [400, 0, 300];   // past the arm's reach
    const r = withDeriveMemo(() => defaultSolve({ part: arm, params: start, handle, grab: "tip", target, collide: guard }));
    expect(guard.rowCount).toBe(0);
    const values = goalValues({ handle, point: target, part: arm });
    expect(r.values).toEqual({ ...values, ...seedValues({ part: arm, params: { ...start, ...values }, handle }) });
    expect(r.values).toEqual(defaultSolve({ part: arm, params: start, handle, grab: "tip", target }).values);
    const { p, d } = resolveParams(arm, { ...start, ...r.values });
    expect(arm.probes.tool(null, p, d).status).not.toBe("reached");
  }, SLOW);
});
