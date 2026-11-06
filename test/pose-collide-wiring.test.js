// Pose mode's collision wiring (spec "Pose mode: collision in the solver"): the session
// settles every frame through the drag's guard before it writes, the drag's end names the pair it stopped at, the
// pose ladder hands out rung-1 matrices, and mount's index (pose/pose-collide.js) builds
// in idle time and guards a drag over what it has indexed. No DOM: fakes throughout.
import { describe, it, expect, vi } from "vitest";
import { createPoseSession } from "../src/framework/pose/pose-session.js";
import { createPoseFastPath } from "../src/framework/pose-fast-path.js";
import { createPoseCollide, handleKeys } from "../src/framework/pose/pose-collide.js";
import { placeMatrix } from "../src/framework/collide/place.js";
import { withBlend, linearBlend } from "../src/framework/pose/param-solve.js";
import { withDeriveMemo } from "../src/framework/derive-memo.js";
import * as world from "../src/framework/collide/world.js";
import * as partGuard from "../src/framework/collide/part-guard.js";
import hand from "../src/parts/hand.js";
import { resolveParams } from "../src/framework/part-model.js";
import { collideBar, barMeshes } from "./fixtures/collide-bar.js";

// The bar fixture with a rotary handle on its swing: the handle writes `angle`.
const bar = {
  ...collideBar,
  parameters: collideBar.parameters,
  handles: { swing: { point: () => [20, 0, 0], params: ["angle"], drag: "rotary", axis: { origin: [0, 0, 0], direction: [0, 1, 0] } } },
};

/** A session over a plain params store; solve answers `{ angle: target[0] }` with a linear blend. */
function session({ collide = () => null, solve, blockedChange } = {}) {
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
    ...(blockedChange ? { blockedChange } : {}),
  });
  return { s, params, writes, solves };
}

/** A fake guard whose settle goes half way and records what it was handed. */
function halfGuard({ blocked = null } = {}) {
  const calls = [];
  return {
    calls,
    settle(from, to, opts) {
      calls.push({ from: { ...from }, to: { ...to }, blend: opts?.blend, pinDrift: opts?.pinDrift });
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

  it("a limb drag's target slides along the normal the last stop reported, until the pointer pulls away", () => {
    const params = { ...hand.defaults, thumbLock: true };
    const grab = () => resolveParams(hand, params).d.index.world("tip").origin;
    const targets = [];
    let report = true;
    const guard = {
      release() {},
      settle(from, to) {
        const out = { params: { ...to }, blocked: report ? { a: "indexDistal", b: "middleDistal" } : null };
        if (report) out.contacts = [{ a: "indexDistal", b: "middleDistal", normal: [1, 0, 0] }];
        report = false;
        return out;
      },
    };
    const s = createPoseSession({
      part: hand, getParams: () => params, write: (v) => Object.assign(params, v), commit() {}, restore() {},
      solve: (args) => { targets.push(args.target); return withBlend({ values: {}, error: 0 }, (t) => ({ ...args.params })); },
      collide: () => guard,
    });
    s.begin("index", "tip");
    const g = grab();
    const plus = (d) => g.map((v, i) => v + d[i]);
    s.frame({ point: plus([-5, 3, 0]) });               // the stop: reported after this solve
    expect(targets[0]).toEqual(plus([-5, 3, 0]));
    s.frame({ point: plus([-5, 3, 0]) });               // into the normal: only the sideways part
    targets[1].forEach((v, i) => expect(v).toBeCloseTo(plus([0, 3, 0])[i], 9));
    s.frame({ point: plus([5, 0, 0]) });                // pulled away: as given, the normal dropped
    expect(targets[2]).toEqual(plus([5, 0, 0]));
    s.frame({ point: plus([-5, 0, 0]) });
    expect(targets[3]).toEqual(plus([-5, 0, 0]));
    s.end();
  });

  it("a pinned drag hands settle a pinDrift that reads how far the pins moved; an unpinned one none", () => {
    // `other` is pinned where the bar's angle puts it, so any change of angle moves it
    const pinnedPart = { ...bar, handles: { ...bar.handles, other: { point: (p) => [p.angle, 0, 30], params: ["angle"], drag: "point" } } };
    const drive = (pin) => {
      const params = { ...bar.defaults };
      const guard = halfGuard({ blocked: { a: "bar", b: "palm" } });
      const s = createPoseSession({
        part: pinnedPart, getParams: () => params, write: (v) => Object.assign(params, v), commit() {}, restore() {},
        solve: (args) => withBlend({ values: { angle: args.target.point[0] }, error: 0 }, linearBlend({ ...bar.defaults, ...args.params }, { angle: args.target.point[0] })),
        collide: () => guard,
      });
      if (pin) expect(s.togglePin("other:point")).toBe(true);
      s.begin("swing");
      s.frame({ point: [40, 0, 0] });
      const [call] = guard.calls;
      return call.pinDrift && [call.pinDrift({ ...bar.defaults }), call.pinDrift({ ...bar.defaults, angle: bar.defaults.angle + 20 })];
    };
    expect(drive(false)).toBeUndefined();
    expect(drive(true)).toEqual([0, 20]); // the pin, read where the drag began, and 20 mm along
  });

  it("no collisions block, no guard: the solve's values are written as they are", () => {
    const h = session();
    h.s.begin("swing");
    h.s.frame({ point: [33, 0, 0] });
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

describe("the release snap and a settle that throws", () => {
  // angle's step is 0.1: a drag settled at 59.97 snaps to 60.0 nearest, 59.9 toward the start (0).
  /** A guard whose settle lands on `at` and whose isClear accepts `clear(angle)`. */
  const snapGuard = (at, clear) => ({
    ...halfGuard(),
    settle: (from) => ({ params: { ...from, angle: at }, blocked: null }),
    checked: [],
    isClear(params) { this.checked.push(params.angle); return clear(params.angle); },
  });
  const commitsOf = (g) => {
    const params = { ...bar.defaults }, writes = [], commits = [];
    const s = createPoseSession({
      part: bar, getParams: () => params, write: (v) => { writes.push({ ...v }); Object.assign(params, v); },
      commit: (c) => commits.push(c), restore() {},
      solve: (args) => withBlend({ values: { angle: 90 }, error: 0 }, linearBlend({ ...bar.defaults, ...args.params }, { angle: 90 })),
      collide: () => g,
    });
    return { s, params, writes, commits };
  };

  it("a nearest snap into contact snaps toward the start instead", () => {
    const g = snapGuard(59.97, (a) => a < 59.98);
    const h = commitsOf(g);
    h.s.begin("swing");
    h.s.frame({ point: [90, 0, 0] });
    const ended = h.s.end();
    expect(g.checked.map((a) => +a.toFixed(6))).toEqual([60, 59.9]);
    expect(h.writes.at(-1)).toEqual({ angle: 59.9 });  // not the nearest, 60
    expect(h.params.angle).toBe(59.9);
    expect(ended.changed).toEqual(["angle"]);
    expect(h.commits).toEqual([["angle"]]);
  });

  it("both snaps in contact: the last clear values, unsnapped", () => {
    const g = snapGuard(59.97, (a) => Math.abs(a - 59.97) < 1e-9);
    const h = commitsOf(g);
    h.s.begin("swing");
    h.s.frame({ point: [90, 0, 0] });
    h.s.end();
    expect(h.writes.at(-1)).toEqual({ angle: 59.97 });
    expect(h.commits).toEqual([["angle"]]);
  });

  it("a clear nearest snap is written as before", () => {
    const g = snapGuard(59.97, () => true);
    const h = commitsOf(g);
    h.s.begin("swing");
    h.s.frame({ point: [90, 0, 0] });
    h.s.end();
    expect(h.writes.at(-1)).toEqual({ angle: 60 });
  });

  it("a settle that throws holds that frame and keeps the guard: the next frame settles, one log", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let settles = 0, released = 0;
    const half = halfGuard();
    const g = { ...half, settle(...a) { settles++; if (settles === 1) throw new Error("cannot place"); return half.settle(...a); }, release() { released++; } };
    const h = session({ collide: () => g });
    h.s.begin("swing");
    h.s.frame({ point: [40, 0, 0] });
    expect(h.writes).toEqual([]);                    // held: nothing written on frame 1
    expect(h.params.angle).toBe(0);
    expect(released).toBe(0);                        // the guard is kept
    h.s.frame({ point: [40, 0, 0] });
    expect(settles).toBe(2);                         // frame 2 goes through the guard again
    expect(h.solves.at(-1).collide).not.toBeNull();
    expect(half.calls[0].from.angle).toBe(0);        // from the unchanged lastClear
    expect(h.writes).toEqual([{ angle: 20 }]);       // settled half way
    h.s.frame({ point: [40, 0, 0] });
    expect(h.writes.at(-1)).toEqual({ angle: 30 });
    expect(err).toHaveBeenCalledTimes(1);
    h.s.end();
    expect(released).toBe(1);
    err.mockRestore();
  });

  it("a guard that always throws writes nothing for the whole drag, and release leaves lastClear", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let settles = 0;
    const g = { ...halfGuard(), settle() { settles++; throw new Error("cannot place"); }, isClear() { throw new Error("cannot place"); } };
    const h = session({ collide: () => g });
    h.s.begin("swing");
    for (const x of [40, 30, 20]) h.s.frame({ point: [x, 0, 0] });
    expect(settles).toBe(3);
    expect(h.writes).toEqual([]);
    const out = h.s.end();
    expect(h.writes).toEqual([]);                    // nothing touched: the snapshot (lastClear) stands
    expect(h.params.angle).toBe(0);
    expect(out.changed).toEqual([]);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("a guard that settles, then throws, releases to lastClear when isClear throws too", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let settles = 0;
    const half = halfGuard();
    const g = { ...half, settle(...a) { if (++settles > 1) throw new Error("cannot place"); return half.settle(...a); }, isClear() { throw new Error("cannot place"); } };
    const h = session({ collide: () => g });
    h.s.begin("swing");
    h.s.frame({ point: [40.04, 0, 0] });             // settles to 20.02: lastClear
    h.s.frame({ point: [10, 0, 0] });                // throws: held
    expect(h.writes).toEqual([{ angle: 20.02 }]);
    h.s.end();
    expect(h.writes.at(-1)).toEqual({ angle: 20.02 }); // isClear threw on both snaps: lastClear, unsnapped
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
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
  function rig({ shown = ["palm", "bar"], frames = {} } = {}) {
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
      frameOf: (n) => frames[n] ?? "canonical",
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

  it("a mesh that is not canonical is never indexed (matricesAt places it nowhere)", async () => {
    const frames = { bar: "posed" };
    const r = rig({ frames });
    r.pc.delivered(["palm", "bar"]);
    await r.runIdle();
    expect(r.pc.state().indexed).toEqual(["palm"]);
    frames.bar = "canonical";
    r.pc.delivered(["bar"]);
    await r.runIdle();
    expect(r.pc.state().indexed.sort()).toEqual(["bar", "palm"]);
    frames.bar = "posed";                     // delivered posed again: its index goes
    r.pc.delivered(["bar"]);
    expect(r.pc.state().indexed).toEqual(["palm"]);
    expect(r.worldMod.disposeIndexes).toHaveBeenCalledTimes(1);
    r.pc.dispose();
  });

  it("the same mesh array delivered again is not re-indexed", async () => {
    const r = rig();
    r.pc.delivered(["palm", "bar"]);
    await r.runIdle();
    const build = vi.spyOn(r.worldMod, "buildIndex");
    r.pc.delivered(["palm", "bar"]);
    await r.runIdle();
    expect(build).not.toHaveBeenCalled();
    r.pc.dispose();
  });

  it("refresh prunes an index whose sub-part has no mesh any more; a borrowed one waits for release", async () => {
    const r = rig();
    r.pc.delivered(["palm", "bar"]);
    await r.runIdle();
    const g = r.pc.guardFor({ handle: bar.handles.swing, snapshot: {} });
    r.has.delete("bar");
    r.pc.refresh();
    expect(r.pc.state().indexed).toEqual(["palm"]);
    expect(r.worldMod.disposeIndexes).not.toHaveBeenCalled(); // the drag borrows it
    g.release();
    expect(r.worldMod.disposeIndexes).toHaveBeenCalledTimes(1);
    r.has.add("bar");
    r.pc.refresh();
    await r.runIdle();
    expect(r.pc.state().indexed.sort()).toEqual(["bar", "palm"]);
    r.pc.dispose();
  });

  it("dispose during a drag leaves release() safe, and frees each index once", async () => {
    const r = rig();
    r.pc.delivered(["palm", "bar"]);
    await r.runIdle();
    const g = r.pc.guardFor({ handle: bar.handles.swing, snapshot: {} });
    r.pc.dispose();
    const freed = r.worldMod.disposeIndexes.mock.calls.flatMap((c) => [...c[0]]);
    expect(freed).toHaveLength(2);
    expect(() => g.release()).not.toThrow();
    expect(() => g.release()).not.toThrow();
    expect(r.worldMod.disposeIndexes.mock.calls.flatMap((c) => [...c[0]])).toHaveLength(2);
    expect(r.pc.guardFor({ handle: bar.handles.swing, snapshot: {} })).toBeNull();
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
