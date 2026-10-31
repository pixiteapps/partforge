import { describe, it, expect } from "vitest";
import { createPoseSession } from "../src/framework/pose/pose-session.js";
import hand from "./fixtures/ik-hand-fixture.js";

/**
 * Fake effects that record every call in order. Params live in a plain store that
 * write/restore mutate, the way mount's live params object does.
 */
function harness({ part = hand, solve, stale = () => [] } = {}) {
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
    solve: solve ?? (({ target }) => ({ values: { aCurl: 0.2 + target[0] / 100, aSpread: target[1] }, error: 0 })),
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
      g: { limb: "a", mode: "goal", params: { position: ["gx", "gy", "gz"], aim: ["gPitch", "gYaw"] }, seed: ["aCurl", "aSpread"] },
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
