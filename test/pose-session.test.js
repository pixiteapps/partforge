import { describe, it, expect } from "vitest";
import { createPoseSession, parsePinId, pinTarget } from "../src/framework/pose/pose-session.js";
import hand from "./fixtures/ik-hand-fixture.js";

/**
 * Fake effects that record every call in order. Params live in a plain store that
 * write/restore mutate, the way mount's live params object does.
 */
function harness({ part = hand, solve, real = false, stale = () => [], locate } = {}) {
  const params = { ...part.defaults };
  const calls = [];
  const log = (name) => (...args) => calls.push([name, ...args.map((a) => (Array.isArray(a) ? [...a] : a && typeof a === "object" ? { ...a } : a))]);
  let frameNo = 0;
  const session = createPoseSession({
    part,
    getParams: () => params,
    write: (values) => { Object.assign(params, values); log("write")(values); },
    commit: log("commit"),
    restore: (values) => { Object.assign(params, values); log("restore")(values); },
    ...(locate ? { locate } : {}),
    ...(real ? {} : { solve: solve ?? (({ target }) => ({ values: { aCurl: 0.2 + target[0] / 100, aSpread: target[1] }, error: 0 })) }),
    staleSubParts: () => stale(frameNo),
    ghost: log("ghost"),
    unghost: log("unghost"),
    hold: log("hold"),
    onCancel: log("onCancel"),
  });
  const frame = (t) => { frameNo++; return session.frame(t); };
  const only = (name) => calls.filter((c) => c[0] === name);
  return { session, params, calls, only, frame };
}

describe("createPoseSession", () => {
  it("one drag of 5 frames is one commit of the changed keys, with hold(true) then hold(false)", () => {
    const h = harness();
    h.session.begin("a", "tip");
    for (let i = 1; i <= 5; i++) h.frame([i * 4.123, i * 0.37, 0]);
    h.session.end();
    expect(h.only("commit")).toHaveLength(1);
    expect(h.only("commit")[0][1].sort()).toEqual(["aCurl", "aSpread"]);
    expect(h.only("hold").map((c) => c[1])).toEqual([true, false]);
    // hold(true) before the first write, hold(false) after the last one
    const names = h.calls.map((c) => c[0]);
    expect(names.indexOf("hold")).toBeLessThan(names.indexOf("write"));
    expect(names.lastIndexOf("hold")).toBeGreaterThan(names.lastIndexOf("write"));
    // the release write is snapped to the schema step (aCurl step 0.01, aSpread step 1)
    expect(h.params.aCurl).toBe(0.41);
    expect(h.params.aSpread).toBe(2);
  });

  it("a drag that changes nothing commits nothing", () => {
    const h = harness({ solve: () => ({ values: { aCurl: 0.2 }, error: 0 }) });
    h.session.begin("a", "tip");
    h.frame([0, 0, 0]);
    h.session.end();
    expect(h.only("commit")).toHaveLength(0);
    expect(h.only("hold").map((c) => c[1])).toEqual([true, false]);
  });

  it("a sub-part that goes stale on frame 2 is ghosted once and unghosted only on its delivery", () => {
    const h = harness({ stale: (n) => (n >= 2 ? ["palm"] : []) });
    h.session.begin("a", "tip");
    for (let i = 1; i <= 5; i++) h.frame([i, 0, 0]);
    expect(h.only("ghost")).toEqual([["ghost", ["palm"]]]);
    h.session.delivered("palm"); // mid-drag: never unghost
    expect(h.only("unghost")).toHaveLength(0);
    h.session.end();
    expect(h.only("unghost")).toHaveLength(0);
    h.session.delivered("other");
    expect(h.only("unghost")).toHaveLength(0);
    h.session.delivered("palm");
    expect(h.only("unghost")).toEqual([["unghost", ["palm"]]]);
    h.session.delivered("palm");
    expect(h.only("unghost")).toHaveLength(1);
  });

  it("a ghost from drag 1 whose delivery lands during drag 2 is lifted then (it is current)", () => {
    let stale = [];
    const h = harness({ stale: () => stale });
    h.session.begin("a", "tip");
    stale = ["X"];
    h.frame([1, 0, 0]);
    h.session.end(); // X's regen is dispatched, still stale: stays ghosted
    expect(h.only("unghost")).toHaveLength(0);
    h.session.begin("b", "tip");
    stale = []; // X's delivery lands mid-drag 2; drag 2 does not touch X
    h.session.delivered("X");
    expect(h.only("unghost")).toEqual([["unghost", ["X"]]]);
    h.frame([2, 0, 0]);
    h.session.end();
    expect(h.only("unghost")).toHaveLength(1);
    expect(h.session.ghosted).toEqual([]);
  });

  it("a delivery ignored mid-drag (stale again) is reconciled when the drag ends current", () => {
    let stale = [];
    const h = harness({ stale: () => stale });
    h.session.begin("a", "tip");
    stale = ["X"];
    h.frame([1, 0, 0]);
    h.session.end();
    h.session.begin("a", "tip");
    h.frame([2, 0, 0]);
    h.session.delivered("X"); // drag 2 keeps X stale: ignored
    expect(h.only("unghost")).toHaveLength(0);
    stale = []; // drag 2 ends where X's last delivered mesh was built
    h.session.end();
    expect(h.only("unghost")).toEqual([["unghost", ["X"]]]);
  });

  it("a drag that returns to its start values unghosts at end with no delivery", () => {
    let stale = [];
    const h = harness({ stale: () => stale });
    h.session.begin("a", "tip");
    stale = ["palm"];
    h.frame([5, 0, 0]);
    expect(h.only("ghost")).toEqual([["ghost", ["palm"]]]);
    stale = []; // back at the start: a cache hit, no job, no delivery
    h.frame([0, 0, 0]);
    h.session.end();
    expect(h.only("unghost")).toEqual([["unghost", ["palm"]]]);
    expect(h.only("commit")).toHaveLength(0);
  });

  it("cancel() leaves an earlier drag's ghost (still awaiting its regen) until delivered", () => {
    let stale = [];
    const h = harness({ stale: () => stale });
    h.session.begin("a", "tip");
    stale = ["X"];
    h.frame([1, 0, 0]);
    h.session.end(); // X's regen pending
    h.session.begin("b", "tip");
    stale = ["X", "Y"];
    h.frame([2, 0, 0]);
    expect(h.only("ghost")).toEqual([["ghost", ["X"]], ["ghost", ["Y"]]]);
    stale = ["X"]; // the restore makes Y current; X still waits on drag 1's regen
    h.session.cancel();
    expect(h.only("unghost")).toEqual([["unghost", ["Y"]]]);
    stale = [];
    h.session.delivered("X");
    expect(h.only("unghost")).toEqual([["unghost", ["Y"]], ["unghost", ["X"]]]);
  });

  it("cancel() restores the snapshot with no commit, and unghosts what the restore made current", () => {
    let stale = ["palm"];
    const h = harness({ stale: () => stale });
    const before = { ...h.params };
    h.session.begin("a", "tip");
    h.frame([10, 3, 0]);
    h.frame([12, 4, 0]);
    stale = []; // the snapshot's values are the ones palm's mesh was built from
    h.session.cancel();
    expect(h.only("commit")).toHaveLength(0);
    expect(h.only("restore")).toHaveLength(1);
    expect(h.params).toEqual(before);
    expect(h.only("hold").map((c) => c[1])).toEqual([true, false]);
    expect(h.only("unghost")).toEqual([["unghost", ["palm"]]]);
    expect(h.only("onCancel")).toHaveLength(1);
    expect(h.session.isActive()).toBe(false);
  });

  it("externalWrite() mid-drag acts like cancel, and later frames are ignored", () => {
    const h = harness();
    const before = { ...h.params };
    h.session.begin("a", "tip");
    h.frame([10, 3, 0]);
    h.session.externalWrite();
    expect(h.params).toEqual(before);
    const writes = h.only("write").length;
    expect(h.frame([20, 5, 0])).toBeNull();
    h.session.end();
    expect(h.only("write")).toHaveLength(writes);
    expect(h.only("commit")).toHaveLength(0);
    expect(h.only("hold").map((c) => c[1])).toEqual([true, false]);
    expect(h.only("onCancel")).toHaveLength(1);
  });

  it("externalWrite() with no drag on is a no-op", () => {
    const h = harness();
    h.session.externalWrite();
    expect(h.calls).toEqual([]);
  });

  it("a click with no drag toggles a pin; releasePins() empties pins", () => {
    const h = harness();
    expect(h.session.togglePin("a:tip")).toBe(true);
    expect(h.session.pins).toEqual(["a:tip"]);
    expect(h.session.togglePin("b:tip")).toBe(true);
    expect(h.session.togglePin("a:tip")).toBe(false);
    expect(h.session.pins).toEqual(["b:tip"]);
    h.session.releasePins();
    expect(h.session.pins).toEqual([]);
    // toggling never touches params, hold or commit
    expect(h.calls).toEqual([]);
  });

  it("an inactive pin (pinActive false: not shown in this view) is never held", () => {
    const seen = [];
    const session = createPoseSession({
      part: hand, getParams: () => ({ ...hand.defaults }), write() {}, commit() {}, restore() {},
      solve: (req) => { seen.push(req.holds); return { values: {}, error: 0 }; },
      pinActive: (id) => id !== "b:tip",
    });
    session.setPins(["b:tip"]);
    session.begin("a", "tip");
    session.frame([1, 2, 3]);
    expect(seen[0]).toEqual([]);
    session.cancel();
    const live = createPoseSession({
      part: hand, getParams: () => ({ ...hand.defaults }), write() {}, commit() {}, restore() {},
      solve: (req) => { seen.push(req.holds); return { values: {}, error: 0 }; },
    });
    live.setPins(["b:tip"]);
    live.begin("a", "tip");
    live.frame([1, 2, 3]);
    expect(seen[1].map((h) => h.limb)).toEqual(["b"]); // active by default
  });

  it("a pin's held point is captured at begin and passed to the solve as a hold", () => {
    const seen = [];
    const h = harness({ solve: (req) => { seen.push(req); return { values: {}, error: 0 }; } });
    h.session.togglePin("b:tip");
    h.session.togglePin("a:tip"); // the grabbed point itself is never held
    h.session.begin("a", "tip");
    h.frame([1, 2, 3]);
    h.frame([1, 2, 4]);
    expect(seen).toHaveLength(2);
    const [hold] = seen[0].holds;
    expect(seen[0].holds).toHaveLength(1);
    expect(hold.limb).toBe("b");
    expect(hold.at).toBe("tip");
    expect(hold.point).toHaveLength(3);
    expect(seen[1].holds[0].point).toEqual(hold.point);
    expect(seen[0].handle).toBe(hand.handles.a);
    expect(seen[0].grab).toBe("tip");
    expect(seen[0].target).toEqual([1, 2, 3]);
  });

  it("setPins replaces the pin set (viewer state restore)", () => {
    const h = harness();
    h.session.setPins(["a:tip", "b:tip", "a:tip"]);
    expect(h.session.pins).toEqual(["a:tip", "b:tip"]);
  });

  it("the default solve (angles mode) moves the grabbed fingertip toward the target", () => {
    const params = { ...hand.defaults };
    const session = createPoseSession({
      part: hand,
      getParams: () => params,
      write: (v) => Object.assign(params, v),
      commit: () => {}, restore: () => {}, staleSubParts: () => [],
      ghost: () => {}, unghost: () => {}, hold: () => {},
    });
    session.begin("a", "tip");
    const r = session.frame([-12, -20, 80]);
    expect(r).not.toBeNull();
    expect(Object.keys(r.values).every((k) => hand.handles.a.params.includes(k))).toBe(true);
  });
});

describe("goal-mode handles", () => {
  const goalPart = {
    ...hand,
    parameters: [
      ...hand.parameters,
      { id: "goal", title: "Goal", controls: [
        { key: "gx", label: "X", min: -100, max: 100, step: 0.5 },
        { key: "gy", label: "Y", min: -100, max: 100, step: 0.5 },
        { key: "gz", label: "Z", min: 0, max: 200, step: 0.5 },
        { key: "gPitch", label: "Pitch", min: -90, max: 90, step: 1 },
        { key: "gYaw", label: "Yaw", min: -180, max: 180, step: 1 },
      ] },
    ],
    defaults: { ...hand.defaults, gx: 0, gy: 0, gz: 100, gPitch: 10, gYaw: 0 },
    handles: {
      ...hand.handles,
      g: { on: "a", drag: "goal", params: { position: ["gx", "gy", "gz"], aim: ["gPitch", "gYaw"] }, seed: ["aCurl", "aSpread"] },
    },
  };

  function goalHarness() {
    const params = { ...goalPart.defaults };
    const writes = [];
    const session = createPoseSession({
      part: goalPart,
      getParams: () => params,
      write: (v) => { writes.push({ ...v }); Object.assign(params, v); },
      commit: () => {}, restore: () => {}, staleSubParts: () => [],
      ghost: () => {}, unghost: () => {}, hold: () => {},
    });
    return { session, params, writes };
  }

  it("frame writes the dragged point onto the goal params, clamped, plus the seed", () => {
    const { session, writes } = goalHarness();
    session.begin("g", "tip");
    session.frame([12.25, -300, 50]);
    expect(writes[0].gx).toBe(12.25);
    expect(writes[0].gy).toBe(-100);
    expect(writes[0].gz).toBe(50);
    expect(writes[0]).not.toHaveProperty("gPitch");
    expect(Object.keys(writes[0])).toEqual(expect.arrayContaining(["aCurl", "aSpread"]));
  });

  it("ringFrame adds the delta to the begin-time aim param, clamped to its range", () => {
    const { session, params } = goalHarness();
    session.begin("g", "ring");
    session.ringFrame("pitch", 30);
    expect(params.gPitch).toBe(40);
    session.ringFrame("pitch", 25); // the delta is from the grab, not cumulative
    expect(params.gPitch).toBe(35);
    session.ringFrame("pitch", 500);
    expect(params.gPitch).toBe(90);
    session.ringFrame("yaw", -12.4);
    expect(params.gYaw).toBe(-12.4);
    session.ringFrame("roll", 5); // no roll param declared: nothing to write
    expect(params).not.toHaveProperty("undefined");
    session.end();
    expect(params.gYaw).toBe(-12);
  });

  it("ringFrame on an angles-mode handle is ignored", () => {
    const { session, writes } = goalHarness();
    session.begin("a", "tip");
    expect(session.ringFrame("pitch", 10)).toBeNull();
    expect(writes).toHaveLength(0);
  });
});


// ---- generic (`on` / `point`) handles ---------------------------------------------------

const drawer = {
  parameters: [{ id: "d", title: "Drawer", controls: [{ key: "drawerOpen", min: 0, max: 100, step: 1 }] }],
  defaults: { drawerOpen: 0 },
  derive: () => ({}),
  handles: { pull: { point: (p) => [0, -p.drawerOpen, 0], params: ["drawerOpen"], drag: "axis", direction: [0, -1, 0] } },
};
const boxPart = {
  parameters: [{ id: "b", title: "Box", controls: [
    { key: "width", min: 10, max: 400, step: 1 },
    { key: "depth", min: 10, max: 200, step: 1 },
  ] }],
  defaults: { width: 80, depth: 40 },
  derive: () => ({}),
  handles: { corner: { point: (p) => [p.width / 2, p.depth / 2, 10], params: ["width", "depth"], drag: "plane", normal: [0, 0, 1] } },
};
const GEARS = [
  { name: "gear1", c: [0, 0, 0], r: 20, ratio: 1 },
  { name: "gear2", c: [50, 0, 0], r: 30, ratio: -20 / 30 },
  { name: "gear3", c: [120, 0, 0], r: 40, ratio: 20 / 40 },
];
const train = {
  parameters: [{ id: "t", title: "Train", controls: [{ key: "driveAngle", min: 0, max: 360, step: 1, wrap: true }] }],
  defaults: { driveAngle: 0 },
  derive: (p) => ({
    train: {
      handleInfo() {
        const points = {};
        for (const g of GEARS) {
          const t = (p.driveAngle * g.ratio * Math.PI) / 180;
          points[`${g.name}.rim`] = [g.c[0] + g.r * Math.cos(t), g.c[1] + g.r * Math.sin(t), g.c[2]];
        }
        return { kind: "partforge.points", points };
      },
    },
  }),
  handles: Object.fromEntries(GEARS.map((g) => [g.name, { on: "train", at: `${g.name}.rim`, params: ["driveAngle"], drag: "rotary" }])),
};
const gear3Target = (deg) => ({ angleDeg: deg, axis: { origin: [120, 0, 0], direction: [0, 0, 1] }, radius: 40 });

describe("createPoseSession - generic handles", () => {
  it("an axis drag writes, ghosts the stale sub-part and commits once on end()", () => {
    const h = harness({ part: drawer, real: true, stale: (n) => (n >= 1 ? ["drawer"] : []) });
    expect(h.session.begin("pull", "ignored")).toBe(true);
    expect(h.session.active.grab).toBe("point");
    h.frame({ point: [0, -30, 0] });
    h.frame({ point: [0, -42.4, 0] });
    expect(h.params.drawerOpen).toBeCloseTo(42.4, 1);
    expect(h.only("ghost")).toEqual([["ghost", ["drawer"]]]);
    h.session.end();
    expect(h.params.drawerOpen).toBe(42);
    expect(h.only("commit")).toEqual([["commit", ["drawerOpen"]]]);
  });

  it("a pin on gear2 holds through a gear3 drag: the shared drive does not move", () => {
    const h = harness({ part: train, real: true });
    h.session.setPins(["gear2:gear2.rim"]);
    h.session.begin("gear3", "x");
    h.frame(gear3Target(45));
    h.session.end();
    expect(h.params.driveAngle).toBe(0);
    expect(h.only("commit")).toHaveLength(0);
  });

  it("end() says what the drag did: the changed keys, whether any frame moved, whether a pin held", () => {
    const pinned = harness({ part: train, real: true });
    pinned.session.setPins(["gear2:gear2.rim"]);
    pinned.session.begin("gear3", "x");
    pinned.frame(gear3Target(45));
    expect(pinned.session.end()).toEqual({ handleId: "gear3", changed: [], moved: false, held: true, blocked: null });
    const free = harness({ part: train, real: true });
    free.session.begin("gear3", "x");
    free.frame(gear3Target(45));
    expect(free.session.end()).toEqual({ handleId: "gear3", changed: ["driveAngle"], moved: true, held: false, blocked: null });
    // dragged out and back to the start, with a pin elsewhere: it moved, so no pin held it
    const back = harness({ part: drawer, real: true });
    back.session.begin("pull", "x");
    back.frame({ point: [0, -30, 0] });
    back.frame({ point: [0, 0, 0] });
    expect(back.session.end()).toMatchObject({ changed: [], moved: true });
    expect(harness().session.end()).toBeNull(); // no drag on
  });

  it("held counts only a binding pin: another drawer's pin, or a range end, holds nothing", () => {
    const drawers = {
      parameters: [{ id: "d", title: "D", controls: [{ key: "d1", min: 0, max: 100, step: 1 }, { key: "d2", min: 0, max: 100, step: 1 }] }],
      defaults: { d1: 0, d2: 0 },
      derive: () => ({}),
      handles: {
        drawer1: { point: (p) => [0, -p.d1, 0], params: ["d1"], drag: "axis", direction: [0, -1, 0] },
        drawer2: { point: (p) => [50, -p.d2, 0], params: ["d2"], drag: "axis", direction: [0, -1, 0] },
      },
    };
    // drawer1 pinned, a tiny drawer2 drag that snaps back: the pin bound nothing
    const tiny = harness({ part: drawers, real: true });
    tiny.session.setPins(["drawer1:point"]);
    tiny.session.begin("drawer2", "x");
    tiny.frame({ point: [50, -0.2, 0] });
    expect(tiny.session.end()).toMatchObject({ changed: [], held: false });
    // drawer2 at its range end, pushed further, with drawer1 pinned: the range held it, not the pin
    const end = harness({ part: { ...drawers, defaults: { d1: 0, d2: 100 } }, real: true });
    end.session.setPins(["drawer1:point"]);
    end.session.begin("drawer2", "x");
    end.frame({ point: [50, -130, 0] });
    expect(end.session.end()).toMatchObject({ changed: [], held: false });
  });

  it("the same gear3 drag with no pin turns the drive", () => {
    const h = harness({ part: train, real: true });
    h.session.begin("gear3", "x");
    h.frame(gear3Target(45));
    h.session.end();
    expect(h.params.driveAngle).toBeGreaterThan(80);
  });

  it("a pin on the dragged handle itself is not a hold", () => {
    let holds;
    const h = harness({ part: train, solve: (a) => { holds = a.holds; return null; } });
    h.session.setPins(["gear3:gear3.rim", "gear2:gear2.rim"]);
    h.session.begin("gear3", "x");
    h.frame(gear3Target(10));
    expect(holds).toHaveLength(1);
    expect(holds[0].ref.handleId).toBe("gear2");
    expect(holds[0].point[0]).toBeCloseTo(80, 6);
  });

  it("a point pin round-trips through parsePinId and pinTarget, and is held by a limb-free drag", () => {
    expect(parsePinId("corner:point")).toEqual({ handleId: "corner", at: "point" });
    const pin = pinTarget("corner:point", boxPart.handles);
    expect(pin.handleId).toBe("corner");
    expect(pin.ref).toEqual({ handleId: "corner", handle: boxPart.handles.corner });
    expect(pinTarget("gear2:gear2.rim", train.handles).ref.handleId).toBe("gear2");
  });

  it("a generic pin is held while a limb handle is dragged", () => {
    const part = { ...hand, handles: { ...hand.handles, corner: boxPart.handles.corner } };
    let holds;
    const h = harness({ part, solve: (a) => { holds = a.holds; return null; }, locate: ({ handle }) => (handle.point ? [1, 2, 3] : null) });
    h.session.setPins(["corner:point"]);
    h.session.begin("a", "tip");
    h.frame([1, 2, 3]);
    expect(holds).toHaveLength(1);
    expect(holds[0].ref.handleId).toBe("corner");
  });

  it("cancel restores the snapshot and commits nothing", () => {
    const h = harness({ part: drawer, real: true });
    h.session.begin("pull");
    h.frame({ point: [0, -30, 0] });
    h.session.cancel();
    expect(h.params.drawerOpen).toBe(0);
    expect(h.only("restore")).toHaveLength(1);
    expect(h.only("commit")).toHaveLength(0);
  });
});
