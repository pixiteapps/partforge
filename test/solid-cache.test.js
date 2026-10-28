// test/solid-cache.test.js
import { describe, expect, it, test, vi } from "vitest";
import { createSolidCache } from "../src/framework/geometry/solid-cache.js";

const make = (value) => () => ({ value, pin: value, dispose: vi.fn() });

test("a repeated hash within a sub-part is a hit and does not recompute", () => {
  const c = createSolidCache();
  c.begin("a");
  const v1 = c.lookup("h1", make({ id: 1 }));
  c.end();

  c.begin("a");
  const second = vi.fn(() => ({ value: { id: 99 }, pin: {}, dispose: vi.fn() }));
  const v2 = c.lookup("h1", second);
  c.end();

  expect(v2).toBe(v1);            // carried over from the previous round
  expect(second).not.toHaveBeenCalled();
  expect(c.stats()).toEqual({ hits: 1, misses: 1 });
});

test("an entry not re-used next round is disposed (evicted)", () => {
  const c = createSolidCache();
  const dispose = vi.fn();
  c.begin("a");
  c.lookup("old", () => ({ value: {}, pin: {}, dispose }));
  c.end();

  c.begin("a");
  c.lookup("new", make({}));      // different hash → "old" not re-used
  c.end();

  expect(dispose).toHaveBeenCalledTimes(1);
});

test("sub-parts are isolated — A's eviction never touches B", () => {
  const c = createSolidCache();
  const disposeB = vi.fn();
  c.begin("b"); c.lookup("hb", () => ({ value: {}, pin: {}, dispose: disposeB })); c.end();
  c.begin("a"); c.lookup("ha", make({})); c.end();      // rebuild A only
  c.begin("a"); c.lookup("ha2", make({})); c.end();     // A changes; evicts A's old
  expect(disposeB).not.toHaveBeenCalled();              // B untouched
});

test("isPinned reflects live cached pins", () => {
  const c = createSolidCache();
  const pin = { id: 1 };
  c.begin("a");
  c.lookup("h1", () => ({ value: {}, pin, dispose: vi.fn() }));
  expect(c.isPinned(pin)).toBe(true);
  c.end();
  expect(c.isPinned(pin)).toBe(true);   // still cached after commit
});

test("lookup outside a bracket computes without caching", () => {
  const c = createSolidCache();
  const v = c.lookup("h1", make({ id: 7 }));
  expect(v).toEqual({ id: 7 });
  expect(c.isPinned({ id: 7 })).toBe(false);
  expect(c.stats()).toEqual({ hits: 0, misses: 0 });
});

describe("sweep (rebind-generation eviction)", () => {
  function makeEntry(value, disposed) {
    return { value, pin: value, dispose: () => disposed.push(value) };
  }

  it("evicts partitions idle for >= 3 generations, keeps recently built ones", () => {
    const c = createSolidCache();
    const disposed = [];
    c.begin("stale"); c.lookup("h1", () => makeEntry("s1", disposed)); c.end();
    c.sweep(); // stale idle 1
    c.begin("fresh"); c.lookup("h2", () => makeEntry("f1", disposed)); c.end();
    c.sweep(); // stale idle 2, fresh idle 1
    expect(disposed).toEqual([]);
    c.sweep(); // stale idle 3 -> evicted; fresh idle 2 -> kept
    expect(disposed).toEqual(["s1"]);
  });

  it("building a partition re-stamps it (never evicted while in use)", () => {
    const c = createSolidCache();
    const disposed = [];
    for (let i = 0; i < 5; i++) {
      c.begin("live"); c.lookup("h", () => makeEntry("v", disposed)); c.end();
      c.sweep();
    }
    expect(disposed).toEqual([]);
  });

  it("unpins evicted entries", () => {
    const c = createSolidCache();
    const disposed = [];
    c.begin("a"); c.lookup("h", () => makeEntry("v", disposed)); c.end();
    expect(c.isPinned("v")).toBe(true);
    c.sweep(); c.sweep(); c.sweep();
    expect(c.isPinned("v")).toBe(false);
    expect(disposed).toEqual(["v"]);
  });
});

describe("cross-sub-part sharing", () => {
  it("an identical hash in another sub-part is a hit, not a recompute", () => {
    const c = createSolidCache();
    c.begin("row_0");
    const v1 = c.lookup("cell", make({ id: 1 }));
    c.end();

    const second = vi.fn(() => ({ value: { id: 99 }, pin: {}, dispose: vi.fn() }));
    c.begin("row_1");
    const v2 = c.lookup("cell", second);
    c.end();

    expect(v2).toBe(v1);                      // the row_0 solid, reused
    expect(second).not.toHaveBeenCalled();    // never rebuilt
  });

  it("a solid two sub-parts share survives one of them dropping it", () => {
    const c = createSolidCache();
    const dispose = vi.fn();
    c.begin("row_0"); c.lookup("cell", () => ({ value: {}, pin: {}, dispose })); c.end();
    c.begin("row_1"); c.lookup("cell", make({})); c.end();   // adopts row_0's entry

    c.begin("row_0"); c.lookup("other", make({})); c.end();  // row_0 stops using "cell"

    expect(dispose).not.toHaveBeenCalled();                  // row_1 still holds it
  });
});

test("a disposed solid is dropped from the shared index, never handed out again", () => {
  const c = createSolidCache();
  const dispose = vi.fn();
  const stale = { id: "freed" };
  c.begin("row_0"); c.lookup("cell", () => ({ value: stale, pin: stale, dispose })); c.end();
  c.begin("row_0"); c.lookup("other", make({})); c.end();  // sole holder drops it
  expect(dispose).toHaveBeenCalledTimes(1);                // freed

  const rebuilt = { id: "fresh" };
  c.begin("row_1");
  const v = c.lookup("cell", () => ({ value: rebuilt, pin: rebuilt, dispose: vi.fn() }));
  c.end();

  expect(v).toBe(rebuilt);   // rebuilt, NOT the disposed WASM object
});

test("sweeping an idle partition keeps a solid another partition still shares", () => {
  const c = createSolidCache();
  const dispose = vi.fn();
  c.begin("gone"); c.lookup("cell", () => ({ value: {}, pin: {}, dispose })); c.end();
  c.begin("live"); c.lookup("cell", make({})); c.end();     // adopts the same entry

  for (let i = 0; i < 3; i++) {                             // "gone" goes idle and is swept
    c.begin("live"); c.lookup("cell", make({})); c.end();
    c.sweep();
  }

  expect(dispose).not.toHaveBeenCalled();                   // "live" still holds it
});

describe("nested brackets", () => {
  it("an inner begin/end does not close the outer bracket", () => {
    const c = createSolidCache();
    c.begin("outer");
    c.lookup("a", make({ id: "a" }));
    c.begin("inner");          // a nested build (buildView inside an open bracket)
    c.lookup("b", make({ id: "b" }));
    c.end();                   // must NOT commit/close "outer"
    const v = c.lookup("a", () => { throw new Error("outer bracket was closed"); });
    expect(v).toEqual({ id: "a" });
    c.end();
  });

  it("an inner round does not evict the outer round's entries", () => {
    const c = createSolidCache();
    const dispose = vi.fn();
    c.begin("outer");
    c.lookup("keep", () => ({ value: {}, pin: {}, dispose }));
    c.begin("inner"); c.lookup("other", make({})); c.end();
    c.end();
    expect(dispose).not.toHaveBeenCalled();
  });
});

test("clear() disposes every entry exactly once — a shared one too — and leaves the cache cold", () => {
  const c = createSolidCache();
  const own = vi.fn(), shared = vi.fn();
  c.begin("a"); c.lookup("own", () => ({ value: {}, pin: "own", dispose: own })); c.lookup("shared", () => ({ value: {}, pin: "shared", dispose: shared })); c.end();
  c.begin("b"); c.lookup("shared", make({})); c.end(); // adopted by a second partition
  c.clear();
  expect(own).toHaveBeenCalledTimes(1);
  expect(shared).toHaveBeenCalledTimes(1);
  expect(c.isPinned("own")).toBe(false);
  expect(c.isPinned("shared")).toBe(false);
  c.resetStats();
  c.begin("a"); c.lookup("own", make({})); c.end();
  expect(c.stats()).toEqual({ hits: 0, misses: 1 }); // nothing survived to be adopted
});
