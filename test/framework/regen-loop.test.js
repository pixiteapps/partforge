// The auto-regenerate state machine, extracted from mount.js. These tests pin the
// behavior mount has always had: builds gate on kernel readiness, slider drags
// debounce into one build, builds never overlap, and a parameter edit that lands
// mid-build marks the finished result stale so it is discarded and redone.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createRegenLoop } from "../../src/framework/regen-loop.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function makeLoop({ missing = ["a"] } = {}) {
  const send = vi.fn();
  const state = { missing };
  const loop = createRegenLoop({ missingParts: () => state.missing, send });
  return { loop, send, state };
}

test("nothing is sent before the kernel is ready", () => {
  const { loop, send } = makeLoop();
  loop.markDirty();
  vi.runAllTimers();
  loop.kick();
  expect(send).not.toHaveBeenCalled();
  loop.ready();
  expect(send).toHaveBeenCalledTimes(1);
});

test("ready() builds the missing parts immediately", () => {
  const { loop, send } = makeLoop({ missing: ["a", "b"] });
  loop.ready();
  expect(send).toHaveBeenCalledWith(["a", "b"]);
});

test("nothing is sent when no parts are missing", () => {
  const { loop, send } = makeLoop({ missing: [] });
  loop.ready();
  loop.kick();
  expect(send).not.toHaveBeenCalled();
});

test("rapid edits debounce into a single build", () => {
  const { loop, send, state } = makeLoop({ missing: [] });
  loop.ready();
  state.missing = ["a"];
  loop.markDirty();
  vi.advanceTimersByTime(100);
  loop.markDirty();
  loop.markDirty();
  vi.advanceTimersByTime(179);
  expect(send).not.toHaveBeenCalled(); // still inside the debounce window
  vi.advanceTimersByTime(1);
  expect(send).toHaveBeenCalledTimes(1);
});

test("builds never overlap: kicks while generating are ignored until buildDone", () => {
  const { loop, send } = makeLoop();
  loop.ready();
  expect(send).toHaveBeenCalledTimes(1);
  loop.kick();
  loop.markDirty();
  vi.runAllTimers();
  expect(send).toHaveBeenCalledTimes(1); // still the one in-flight build
  loop.buildDone();
  loop.kick();
  expect(send).toHaveBeenCalledTimes(2);
});

test("buildDone reports fresh when nothing changed mid-build", () => {
  const { loop } = makeLoop();
  loop.ready();
  expect(loop.buildDone()).toBe(true);
});

test("a mid-build edit makes the result stale; the follow-up kick rebuilds", () => {
  const { loop, send } = makeLoop();
  loop.ready();
  loop.markDirty();          // edit lands while the build is in flight
  vi.runAllTimers();         // its debounce fires but the in-flight build blocks it
  expect(loop.buildDone()).toBe(false); // result is stale — caller must discard it
  loop.kick();
  expect(send).toHaveBeenCalledTimes(2); // rebuilt with the new params
});

test("version() increments once per edit (drives the mesh cache's validity stamps)", () => {
  const { loop } = makeLoop();
  expect(loop.version()).toBe(0);
  loop.markDirty();
  loop.markDirty();
  expect(loop.version()).toBe(2);
});

test("dispose() cancels a pending debounced kick", () => {
  const { loop, send } = makeLoop();
  loop.ready();
  send.mockClear();
  loop.buildDone();
  loop.markDirty();       // queues a debounced kick
  loop.dispose();
  vi.runAllTimers();
  expect(send).not.toHaveBeenCalled();
});

test("after dispose(), ready() and kick() send nothing", () => {
  const { loop, send } = makeLoop();
  loop.dispose();
  loop.ready();
  loop.kick();
  expect(send).not.toHaveBeenCalled();
});

test("markDirty({debounce:false}) bumps the version without arming a timer", () => {
  const { loop, send, state } = makeLoop({ missing: [] });
  loop.ready(); // nothing missing yet, so this doesn't start a build
  state.missing = ["a"];
  loop.markDirty({ debounce: false });
  expect(loop.version()).toBe(1);
  vi.advanceTimersByTime(1000);
  expect(send).not.toHaveBeenCalled(); // no debounced kick was armed
  loop.kick(); // the caller kicks explicitly on this path
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith(["a"]);
});

test("markDirty({debounce:false}) cancels a previously armed debounce", () => {
  const { loop, send, state } = makeLoop({ missing: [] });
  loop.ready();
  state.missing = ["a"];
  loop.markDirty();                    // arms the 180ms timer
  loop.markDirty({ debounce: false }); // animation frame takes over; cancels it
  vi.advanceTimersByTime(1000);
  expect(send).not.toHaveBeenCalled();
});

// --- multi-job dispatch cycles (per-sub-part backend routing) ---------------
// send() may fan a dispatch out to several workers and reports how many jobs it
// posted; the cycle stays in flight until every job has answered via buildDone().

test("a two-job dispatch stays generating until both replies arrive", () => {
  const { loop, send } = makeLoop({ missing: ["a", "b"] });
  send.mockReturnValue(2);
  loop.ready();
  expect(send).toHaveBeenCalledTimes(1);
  expect(loop.buildDone()).toBe(true); // first worker's reply: fresh, but cycle not over
  loop.kick();
  expect(send).toHaveBeenCalledTimes(1); // still generating — no overlapping dispatch
  expect(loop.buildDone()).toBe(true);   // second reply closes the cycle
  loop.kick();
  expect(send).toHaveBeenCalledTimes(2); // now a new cycle may start
});

test("staleness is reported per reply across a split dispatch", () => {
  const { loop, send } = makeLoop({ missing: ["a", "b"] });
  send.mockReturnValue(2);
  loop.ready();
  expect(loop.buildDone()).toBe(true); // reply 1 lands before the edit — fresh
  loop.markDirty();                    // user edit mid-cycle
  expect(loop.buildDone()).toBe(false); // reply 2 is stale
});

test("send() returning 0 jobs ends the cycle immediately", () => {
  const { loop, send, state } = makeLoop({ missing: ["a"] });
  send.mockReturnValue(0);
  loop.ready();
  send.mockReturnValue(1);
  state.missing = ["b"];
  loop.kick(); // not stuck generating — a zero-job dispatch must not wedge the loop
  expect(send).toHaveBeenCalledTimes(2);
});

test("a lone buildDone() outside any cycle does not corrupt the next one", () => {
  const { loop, send } = makeLoop();
  send.mockReturnValue(1);
  loop.buildDone(); // e.g. an export-triggered needs-occt reply
  loop.ready();
  expect(send).toHaveBeenCalledTimes(1);
  loop.kick();
  expect(send).toHaveBeenCalledTimes(1); // still just one — the stray reply didn't pre-close this cycle
});

// A progressive batch is shown only while its build is in flight and current.
test("isFresh is true only while a build is in flight and no edit has overtaken it", () => {
  const { loop } = makeLoop();
  expect(loop.isFresh()).toBe(false); // nothing in flight
  loop.ready();
  expect(loop.isFresh()).toBe(true);
  loop.markDirty();
  expect(loop.isFresh()).toBe(false); // an edit overtook it
  loop.buildDone();
  expect(loop.isFresh()).toBe(false); // settled
});
