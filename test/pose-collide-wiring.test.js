// Pose mode's collision wiring (spec "Pose mode: collision in the solver"): the session
// settles every frame through the drag's guard before it writes, the solve gets the
// guard's rows under a frame budget, the drag's end names the pair it stopped at, the
// pose ladder hands out rung-1 matrices, and mount's index (pose/pose-collide.js) builds
// in idle time and guards a drag over what it has indexed. No DOM: fakes throughout.
import { describe, it, expect, vi } from "vitest";
import { createPoseSession } from "../src/framework/pose/pose-session.js";
import { createPoseFastPath } from "../src/framework/pose-fast-path.js";
import { createPoseCollide, handleKeys } from "../src/framework/pose/pose-collide.js";
import { budgetFrame, COLLIDE_FRAME_BUDGET_MS, COLLIDE_IN_SOLVE } from "../src/framework/collide/guard.js";
import { placeMatrix } from "../src/framework/collide/place.js";
import { withBlend, linearBlend } from "../src/framework/pose/param-solve.js";
import { withDeriveMemo } from "../src/framework/derive-memo.js";
import * as world from "../src/framework/collide/world.js";
import * as partGuard from "../src/framework/collide/part-guard.js";
import hand from "../src/parts/hand.js";
import { collideBar, barMeshes } from "./fixtures/collide-bar.js";

// The bar fixture with a rotary handle on its swing: the handle writes `angle`.
const bar = {
  ...collideBar,
  parameters: collideBar.parameters,
  handles: { swing: { point: () => [20, 0, 0], params: ["angle"], drag: "rotary", axis: { origin: [0, 0, 0], direction: [0, 1, 0] } } },
};

/** A session over a plain params store; solve answers `{ angle: target[0] }` with a linear blend. */
function session({ collide = () => null, solve, blockedChange, collideBudget, collideInSolve = true } = {}) {
  const params = { ...bar.defaults };
  const writes = [];
  const solves = [];
  const s = createPoseSession({
    part: bar,
    getParams: () => params,
    write: (v) => { writes.push({ ...v }); Object.assign(params, v); },
    commit: () => {},
    restore: (v) => Object.assign(params, v),
    solve: solve ?? ((args) => {
      solves.push(args);
      const values = { angle: args.target.point[0] };
      return withBlend({ values, error: 0 }, linearBlend({ ...bar.defaults, ...args.params }, values));
    }),
    collide,
    collideInSolve,
    ...(blockedChange ? { blockedChange } : {}),
    ...(collideBudget ? { collideBudget } : {}),
  });
  return { s, params, writes, solves };
}

/** A fake guard whose settle goes half way and records what it was handed. */
function halfGuard({ blocked = null } = {}) {
  const calls = [];
  return {
    calls,
    rowCount: 0,
    active: false,
    beginFrame() {}, linearise() {}, rows: () => new Float64Array(0),
    settle(from, to, opts) {
      calls.push({ from: { ...from }, to: { ...to }, blend: opts?.blend });
      const t = 0.5;
      const params = opts?.blend ? opts.blend(t) : { ...to, angle: from.angle + t * (to.angle - from.angle) };
      return { params, blocked };
    },
    released: 0,
    release() { this.released++; },
  };
}

describe("pose-session with a drag guard", () => {
  it("apply settles before write: write gets settle's values, and the solve's blend reached settle", () => {
    const guard = halfGuard();
    const h = session({ collide: () => guard });
    h.s.begin("swing");
    h.s.frame({ point: [40, 0, 0] });
    expect(guard.calls).toHaveLength(1);
    expect(typeof guard.calls[0].blend).toBe("function");
    expect(guard.calls[0].from.angle).toBe(0);         // lastClear starts at the snapshot
    expect(guard.calls[0].to.angle).toBe(40);          // blend(1): the solve's answer
    expect(h.writes).toEqual([{ angle: 20 }]);         // half way: settle's, not the solve's
    h.s.frame({ point: [40, 0, 0] });
    expect(guard.calls[1].from.angle).toBe(20);        // and lastClear is what was written
    expect(h.writes[1]).toEqual({ angle: 30 });
  });

  it("the solve gets the guard's rows under a frame budget; COLLIDE_IN_SOLVE off gets none", () => {
    const guard = halfGuard();
    const on = session({ collide: () => guard });
    on.s.begin("swing");
    on.s.frame({ point: [10, 0, 0] });
    const passed = on.solves[0].collide;
    expect(passed).not.toBeNull();
    expect(passed).not.toBe(guard);                   // the budget wrapper, fresh per frame
    expect(passed.rowCount).toBe(0);
    on.s.frame({ point: [12, 0, 0] });
    expect(on.solves[1].collide).not.toBe(passed);

    const params = { ...bar.defaults };
    const solves = [];
    const off = createPoseSession({
      part: bar, getParams: () => params, write: (v) => Object.assign(params, v), commit() {}, restore() {},
      solve: (args) => { solves.push(args); return withBlend({ values: { angle: 5 }, error: 0 }, linearBlend(params, { angle: 5 })); },
      collide: () => guard, collideInSolve: false,
    });
    off.begin("swing");
    off.frame({ point: [5, 0, 0] });
    expect(solves[0].collide).toBeNull();
    expect(guard.calls.at(-1).to.angle).toBe(5);       // settle still runs
  });

  it("by default the solve gets rows exactly when COLLIDE_IN_SOLVE is on (the shipped mode)", () => {
    const params = { ...bar.defaults };
    const solves = [];
    const s = createPoseSession({
      part: bar, getParams: () => params, write: (v) => Object.assign(params, v), commit() {}, restore() {},
      solve: (args) => { solves.push(args); return withBlend({ values: { angle: 5 }, error: 0 }, linearBlend(params, { angle: 5 })); },
      collide: () => halfGuard(),
    });
    s.begin("swing");
    s.frame({ point: [5, 0, 0] });
    expect(solves[0].collide !== null).toBe(COLLIDE_IN_SOLVE);
  });

  it("no collisions block, no guard: the solve gets collide null and its values are written as they are", () => {
    const h = session();
    h.s.begin("swing");
    h.s.frame({ point: [33, 0, 0] });
    expect(h.solves[0].collide).toBeNull();
    expect(h.writes).toEqual([{ angle: 33 }]);
    expect(h.s.end().blocked).toBeNull();
  });

  it("end reports the blocking pair, tints it while held, and lets the guard go", () => {
    const guard = halfGuard({ blocked: { a: "bar", b: "palm" } });
    const changes = [];
    const h = session({ collide: () => guard, blockedChange: (p) => changes.push(p) });
    h.s.begin("swing");
    h.s.frame({ point: [90, 0, 0] });
    h.s.frame({ point: [90, 0, 0] });
    expect(changes).toEqual([{ a: "bar", b: "palm" }]); // once: the pair did not change
    const ended = h.s.end();
    expect(ended.blocked).toEqual({ a: "bar", b: "palm" });
    expect(changes.at(-1)).toBeNull();                 // the tint goes with the drag
    expect(guard.released).toBe(1);
  });

  it("a cancel lets the guard go too", () => {
    const guard = halfGuard();
    const h = session({ collide: () => guard });
    h.s.begin("swing");
    h.s.frame({ point: [10, 0, 0] });
    h.s.cancel();
    expect(guard.released).toBe(1);
  });

  it("settle reads blend off the solve's own result: a spread copy (which drops it) is not what reaches it", () => {
    // withBlend's blend is non-enumerable: a solve that returns a spread copy of a result
    // has lost it, and settle walks its own linear blend. The session must hand on the
    // blend of the result the solve returned, never one read off a copy of its own.
    const guard = halfGuard();
    const marker = (t) => ({ ...bar.defaults, angle: 100 * t });
    const h = session({
      collide: () => guard,
      solve: () => withBlend({ values: { angle: 100 }, error: 0 }, marker),
    });
    h.s.begin("swing");
    h.s.frame({ point: [100, 0, 0] });
    expect(guard.calls[0].blend).toBe(marker);
    expect({ ...withBlend({ values: {} }, marker) }.blend).toBeUndefined(); // the trap itself

    const copied = session({
      collide: () => guard,
      solve: () => ({ ...withBlend({ values: { angle: 100 }, error: 0 }, marker) }),
    });
    copied.s.begin("swing");
    copied.s.frame({ point: [100, 0, 0] });
    expect(guard.calls.at(-1).blend).toBeUndefined(); // no blend: settle's own linear one
  });
});

describe("budgetFrame", () => {
  const fakeGuard = (cost, clock) => ({
    rowCount: 2, active: true, linearised: 0,
    beginFrame() { clock.t += cost; },
    linearise() { this.linearised++; clock.t += cost; },
    rows() { clock.t += cost / 10; return Float64Array.of(1, 2); },
  });

  it("drops the rows at the first iteration start past the budget; zeros from then on", () => {
    const clock = { t: 0 };
    const g = fakeGuard(5, clock);
    const b = budgetFrame(g, { budgetMs: 8, now: () => clock.t });
    b.beginFrame({});                           // 5 ms
    expect([...b.rows({})]).toEqual([1, 2]);
    b.linearise({});                            // 5.5 < 8: runs (10.5 ms)
    expect(g.linearised).toBe(1);
    expect(b.dropped).toBe(false);
    expect([...b.rows({})]).toEqual([1, 2]);    // mid-iteration: still the rows
    b.linearise({});                            // past 8: dropped, not run
    expect(g.linearised).toBe(1);
    expect(b.dropped).toBe(true);
    expect([...b.rows({})]).toEqual([0, 0]);
    expect(b.rowCount).toBe(2);                 // the residual keeps its length
    expect(b.active).toBe(true);
  });

  it("a cheap frame never drops; the default budget is the named constant", () => {
    const clock = { t: 0 };
    const g = fakeGuard(0.1, clock);
    const b = budgetFrame(g, { now: () => clock.t });
    b.beginFrame({});
    for (let i = 0; i < 20; i++) { b.linearise({}); b.rows({}); }
    expect(b.dropped).toBe(false);
    expect(COLLIDE_FRAME_BUDGET_MS).toBeGreaterThan(0);
  });

  it("a session frame gets a fresh budget: one frame's overrun does not drop the next", () => {
    const clock = { t: 0 };
    const g = fakeGuard(6, clock);
    const seen = [];
    const h = session({
      collide: () => ({ ...halfGuard(), get rowCount() { return g.rowCount; }, beginFrame: g.beginFrame.bind(g), linearise: g.linearise.bind(g), rows: g.rows.bind(g) }),
      collideBudget: { budgetMs: 8, now: () => clock.t },
      solve: (args) => {
        args.collide.beginFrame({}); args.collide.linearise({}); args.collide.linearise({});
        seen.push(args.collide.dropped);
        return withBlend({ values: { angle: 1 }, error: 0 }, linearBlend(args.params, { angle: 1 }));
      },
    });
    h.s.begin("swing");
    h.s.frame({ point: [1, 0, 0] });
    h.s.frame({ point: [1, 0, 0] });
    expect(seen).toEqual([true, true]);
    expect(g.linearised).toBe(2); // one per frame ran before each budget ran out
  });
});

describe("fastPath.matricesAt", () => {
  // Three sub-parts: `a` canonical and current, `b` posed, `c` canonical but its place()
  // queries geometry (untrusted); `d` canonical and stale.
  const part = {
    defaults: { x: 0 },
    parameters: [{ id: "g", title: "G", controls: [{ key: "x", min: -10, max: 10, step: 1 }] }],
    parts: {
      a: { build: (k) => k.box({ min: [0, 0, 0], max: [1, 1, 1] }), views: { assembly: (s, p) => s.translate([p.x, 0, 0]) } },
      b: { build: (k) => k.box({ min: [0, 0, 0], max: [1, 1, 1] }), views: { assembly: (s, p) => s.translate([p.x, 0, 0]) } },
      c: { build: (k) => k.box({ min: [0, 0, 0], max: [1, 1, 1] }), views: { assembly: (s) => s.translate([s.boundingBox().max[0], 0, 0]) } },
      d: { build: (k) => k.box({ min: [0, 0, 0], max: [1, 1, 1] }), views: { assembly: (s) => s } },
    },
    views: { assembly: { label: "A" } },
  };
  const frames = { a: "canonical", b: "posed", c: "canonical", d: "canonical" };
  const viewer = { setSubPose: vi.fn(), hasSubMesh: () => true };
  const cache = { frameOf: (n) => frames[n], isCurrent: (n) => n !== "d", forget() {}, readsOf: () => null, record() {} };

  it("rung-1 matrices for current canonical names; null for posed, stale and untrusted; no viewer call", () => {
    const fp = createPoseFastPath(part, viewer, cache, { params: { ...part.defaults }, getView: () => "assembly", getParamsVersion: () => 0 });
    const m = fp.matricesAt({ x: 3 }, {});
    expect(m.get("a")).toEqual(placeMatrix(part.parts.a, "assembly", { x: 3 }, {}));
    expect(m.get("a")[12]).toBe(3);
    expect(m.get("b")).toBeNull();
    expect(m.get("c")).toBeNull();
    expect(m.get("d")).toBeNull();
    expect(viewer.setSubPose).not.toHaveBeenCalled();
    expect([...fp.matricesAt({ x: 1 }, {}, ["a"]).keys()]).toEqual(["a"]);
  });
});

describe("pose-collide: mount's idle index", () => {
  /** A fake viewer over the bar's meshes, an idle queue the test runs, and a rung-1 fast path. */
  function rig({ shown = ["palm", "bar"] } = {}) {
    const meshes = barMeshes(collideBar);
    const has = new Set(shown);
    const viewer = {
      hasSubMesh: (n) => has.has(n),
      getSubMeshLocal: (n) => (has.has(n) ? meshes.get(n) : null),
      _subMeshes: {},
    };
    const fastPath = { matricesAt: (p, d, only) => new Map((only ?? Object.keys(bar.parts)).map((n) => [n, placeMatrix(bar.parts[n], "assembly", p, d)])) };
    const idle = [];
    const worldMod = { ...world, disposeIndexes: vi.fn(world.disposeIndexes) };
    const pc = createPoseCollide({
      part: bar, viewer, fastPath, getView: () => "assembly",
      schedule: (cb) => { idle.push(cb); return () => {}; },
      loadModules: async () => ({ world: worldMod, partGuard }),
    });
    const runIdle = async () => { while (idle.length) await idle.shift()({ timeRemaining: () => 0 }); };
    return { pc, viewer, has, meshes, runIdle, idle, worldMod };
  }

  it("indexes in idle time, one sub-part per slice when the slice has no time left", async () => {
    const r = rig();
    r.pc.delivered(["palm", "bar"]);
    expect(r.pc.state().indexed).toEqual([]);   // nothing on the critical path
    expect(r.idle).toHaveLength(1);
    await r.idle.shift()({ timeRemaining: () => 0 });
    expect(r.pc.state().indexed).toEqual(["palm"]);
    await r.runIdle();
    expect(r.pc.state().indexed.sort()).toEqual(["bar", "palm"]);
    r.pc.dispose();
  });

  it("a drag before the index is ready runs with no guard, or guarded over the indexed names only", async () => {
    const r = rig();
    expect(r.pc.guardFor({ handle: bar.handles.swing, snapshot: {} })).toBeNull(); // nothing loaded
    r.pc.delivered(["palm", "bar"]);
    await r.idle.shift()({ timeRemaining: () => 0 });                            // palm only
    expect(r.pc.guardFor({ handle: bar.handles.swing, snapshot: {} })).toBeNull(); // one piece: no pair
    await r.runIdle();
    const g = r.pc.guardFor({ handle: bar.handles.swing, snapshot: {} });
    expect(g).not.toBeNull();
    expect(g.moving).toEqual(["bar"]);
    g.release();
    r.pc.dispose();
  });

  it("a guard that stops the swing at the slab, oriented with b the piece it stopped against", async () => {
    const r = rig();
    r.pc.delivered(["palm", "bar"]);
    await r.runIdle();
    const g = r.pc.guardFor({ handle: bar.handles.swing, snapshot: {} });
    const s = withDeriveMemo(() => g.settle({ angle: 0 }, { angle: 90 }));
    expect(s.params.angle).toBeGreaterThan(59);
    expect(s.params.angle).toBeLessThan(60.01);
    expect(s.blocked).toEqual({ a: "bar", b: "palm" });
    g.release();
    r.pc.dispose();
  });

  it("a replaced mesh's index is stale: not used, re-queued; a borrowed one is freed only on release", async () => {
    const r = rig();
    r.pc.delivered(["palm", "bar"]);
    await r.runIdle();
    const g = r.pc.guardFor({ handle: bar.handles.swing, snapshot: {} });
    const spy = r.worldMod.disposeIndexes;
    r.meshes.set("bar", { ...r.meshes.get("bar"), positions: Float64Array.from(r.meshes.get("bar").positions) });
    expect(r.pc.state().indexed).toEqual(["palm"]);       // the old bar index no longer counts
    r.pc.delivered(["bar"]);
    await r.runIdle();
    expect(r.pc.state().indexed.sort()).toEqual(["bar", "palm"]);
    expect(spy).not.toHaveBeenCalled();                    // the drag still borrows the old one
    g.release();
    expect(spy).toHaveBeenCalledTimes(1);
    r.pc.dispose();
  });

  it("a part without collisions, or with pose: false, indexes nothing", () => {
    for (const part of [{ ...bar, collisions: undefined }, { ...bar, collisions: { pose: false } }]) {
      const idle = [];
      const pc = createPoseCollide({ part, viewer: { hasSubMesh: () => true, getSubMeshLocal: () => null }, fastPath: {}, getView: () => "assembly", schedule: (cb) => { idle.push(cb); } });
      pc.delivered(["palm", "bar"]);
      expect(pc.enabled).toBe(false);
      expect(idle).toHaveLength(0);
      expect(pc.guardFor({ handle: bar.handles.swing, snapshot: {} })).toBeNull();
    }
  });

  it("the tint shows both pieces of the pair and clears", () => {
    const shown = [];
    const viewer = { _subMeshes: { bar: { geometry: {} }, palm: { geometry: {} } } };
    const pc = createPoseCollide({
      part: bar, viewer, fastPath: {}, getView: () => "assembly", schedule: () => () => {},
      createHighlight: () => ({ show: (hit) => shown.push(hit.subPart), clear: () => shown.push("clear"), dispose() {} }),
    });
    pc.tint({ a: "bar", b: "palm" });
    expect(shown.filter((x) => x !== "clear")).toEqual(["bar", "palm"]);
    expect(pc.state().tinted).toEqual({ a: "bar", b: "palm" });
    pc.tint(null);
    expect(pc.state().tinted).toBeNull();
    pc.dispose();
  });
});

describe("handleKeys", () => {
  it("an angles handle: its DOFs, its rings' params; a lock freezes them", () => {
    const all = Object.values(hand.handles);
    expect(handleKeys(hand.handles.index, all, hand.defaults).sort()).toEqual(["indexCurl", "indexKnuckle", "indexSpread", "wristPitch", "wristYaw"]);
    expect(handleKeys(hand.handles.index, all, { ...hand.defaults, thumbLock: true }).sort()).toEqual(["indexCurl", "indexKnuckle", "indexSpread"]);
  });
  it("a goal handle: position, aim and seed", () => {
    const h = { on: "arm", drag: "goal", params: { position: ["x", "y", "z"], aim: ["p", "q"] }, seed: ["j1", "j2"] };
    expect(handleKeys(h, [h], {}).sort()).toEqual(["j1", "j2", "p", "q", "x", "y", "z"]);
  });
});
