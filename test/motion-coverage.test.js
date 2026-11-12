import { describe, expect, test, vi } from "vitest";
import { motionParams, coveredParams, readSweeps, uncoveredMotions, MOTION_HINT, motionFinding } from "../src/framework/collide/motion-coverage.js";
import { MOTION_SAMPLES, scanMotion } from "../src/framework/collide/sweep-targets.js";
import { poseMatrices } from "../src/framework/collide/place.js";
import { resolveParams } from "../src/framework/part-model.js";
import { probePoses } from "../src/framework/pose-probe.js";
import hand from "../src/parts/hand.js";

// Pass-through spies, so the hand test below can count the work a scan does rather than
// time it: every other test sees the real functions.
vi.mock("../src/framework/collide/sweep-targets.js", async (orig) => {
  const m = await orig();
  return { ...m, scanMotion: vi.fn(m.scanMotion) };
});
vi.mock("../src/framework/pose-probe.js", async (orig) => {
  const m = await orig();
  return { ...m, probePoses: vi.fn(m.probePoses) };
});
vi.mock("../src/framework/collide/place.js", async (orig) => {
  const m = await orig();
  return { ...m, poseMatrices: vi.fn(m.poseMatrices) };
});

const ctl = (key, min, max, extra = {}) => ({ key, label: key, min, max, step: 1, description: key, ...extra });
const box = (k) => k.box({ size: [10, 10, 10] });

/** Two boxes in one `assembly` view; `lid` and `base` are each sub-part's assembly pose. */
const twoBox = ({ controls, defaults, lid = (s) => s, base = (s) => s, baseBuild = box, extra = {} }) => ({
  meta: { title: "T" },
  parameters: [{ id: "g", title: "G", description: "d", controls }],
  defaults,
  parts: {
    base: { views: { assembly: base }, build: baseBuild },
    lid: { views: { assembly: lid }, build: box },
  },
  views: { assembly: { label: "Assembly" } },
  ...extra,
});

const hinge = (extra = {}) => twoBox({
  controls: [ctl("open", 0, 110)],
  defaults: { open: 0 },
  lid: (s, p) => s.rotateAbout({ axis: "X", deg: p.open, through: [0, 5, 10] }),
  extra,
});
const motions = (part, view = "assembly") => motionParams(part, view, part.defaults);
const brief = (list) => list.map(({ param, moving, against }) => ({ param, moving, against }));

describe("motionParams", () => {
  test("hinge: a lid rotated about a pin moves against the base", () => {
    expect(brief(motions(hinge()))).toEqual([{ param: "open", moving: ["lid"], against: ["base"] }]);
    expect(motions(hinge())[0].range).toEqual([0, 110]);
  });

  test("slide: a translated drawer is a motion", () => {
    const part = twoBox({ controls: [ctl("out", 0, 80)], defaults: { out: 0 }, lid: (s, p) => s.translate([p.out, 0, 0]) });
    expect(brief(motions(part))).toEqual([{ param: "out", moving: ["lid"], against: ["base"] }]);
  });

  test("explode: a lid lifted by an explode slider is a motion", () => {
    const part = twoBox({ controls: [ctl("explode", 0, 30)], defaults: { explode: 0 }, lid: (s, p) => s.translate([0, 0, 10 + p.explode]) });
    expect(brief(motions(part))).toEqual([{ param: "explode", moving: ["lid"], against: ["base"] }]);
  });

  test("size: a param the base's build reads is no motion", () => {
    const part = twoBox({
      controls: [ctl("height", 5, 40)], defaults: { height: 10 },
      baseBuild: (k, p) => k.box({ size: [10, 10, p.height] }),
      lid: (s, p) => s.translate([0, 0, p.height]),
    });
    expect(motions(part)).toEqual([]);
  });

  test("size: a build that changes inside a narrow window of the range still counts", () => {
    const part = hinge();
    part.parts.base.build = (k, p) => k.box({ size: [p.open > 40 && p.open < 50 ? 12 : 10, 10, 10] });
    expect(motions(part)).toEqual([]);
  });

  for (const [when, enabled] of [["open > 50", (p) => p.open > 50], ["open < 50", (p) => p.open < 50]]) {
    test(`a piece enabled only for ${when} makes the motion unreadable, so it is skipped`, () => {
      const part = hinge();
      part.parts.flap = { views: { assembly: (s) => s.translate([30, 0, 0]) }, enabled, build: box };
      expect(motions(part)).toEqual([]);
    });
  }

  test("together: a param that moves every piece alike is no motion", () => {
    const move = (s, p) => s.translate([p.shift, 0, 0]);
    const part = twoBox({ controls: [ctl("shift", 0, 50)], defaults: { shift: 0 }, lid: move, base: move });
    expect(motions(part)).toEqual([]);
  });

  test("single: a view showing one piece has no motion", () => {
    const part = hinge();
    part.parts.base.views = { other: (s) => s };
    part.views.other = { label: "Other" };
    expect(motions(part)).toEqual([]);
  });

  test("ghost: a piece moving only against a non-exportable stand-in is no motion", () => {
    const part = hinge();
    part.parts.base.exportable = false;
    expect(motions(part)).toEqual([]);
  });

  test("turn: a wrapped 0..360 control rotating a gear is a motion", () => {
    const part = twoBox({
      controls: [ctl("turn", 0, 360, { wrap: true })], defaults: { turn: 0 },
      lid: (s, p) => s.rotate(p.turn, [0, 0, 0], [0, 0, 1]).translate([20, 0, 0]),
    });
    expect(brief(motions(part))).toEqual([{ param: "turn", moving: ["lid"], against: ["base"] }]);
  });

  test("noRange: a control with no min or max that poses the lid has range null", () => {
    const part = twoBox({
      controls: [{ key: "open", label: "open", description: "no range" }], defaults: { open: 0 },
      lid: (s, p) => s.rotateAbout({ axis: "X", deg: p.open, through: [0, 5, 10] }),
    });
    expect(motions(part)).toEqual([{ param: "open", range: null, moving: ["lid"], against: ["base"] }]);
  });

  test("throws: a placement that throws over part of the range is skipped, never thrown", () => {
    const part = twoBox({
      controls: [ctl("open", 0, 110), ctl("out", 0, 20)], defaults: { open: 0, out: 0 },
      lid: (s, p) => {
        if (p.open > 90) throw new Error("past the stop");
        return s.rotateAbout({ axis: "X", deg: p.open, through: [0, 5, 10] }).translate([p.out, 0, 0]);
      },
    });
    let list;
    expect(() => { list = motions(part); }).not.toThrow();
    expect(list.map((m) => m.param)).toEqual(["out"]);
  });

  test("a malformed part never throws", () => {
    expect(motionParams({}, "assembly", {})).toEqual([]);
    expect(motionParams(null, "assembly", {})).toEqual([]);
    expect(motionParams({ parts: { a: {} }, parameters: "nope" }, "x", {})).toEqual([]);
  });
});

describe("coveredParams and uncoveredMotions", () => {
  const presets = { type: "preset", label: "Shape", presets: { shut: { open: 0 }, wide: { open: 110 } } };
  const covering = {
    param: { param: "open" },
    handle: { handle: "hinge" },
    presets: { from: "shut", to: "wide" },
    path: { path: [{ open: 0 }, { open: 110 }] },
    animation: { animation: "swing" },
  };
  const covered = (sweep) => {
    const part = hinge({
      handles: { hinge: { point: () => [0, 5, 10], drag: "rotary", axis: [1, 0, 0], params: ["open"] } },
      verify: { sweeps: { s: sweep } },
    });
    part.parameters[0].controls.push(presets);
    part.views.assembly.animations = { swing: { steps: [{ duration: 1, tracks: { open: [[0, 0], [1, 110]] } }] } };
    return part;
  };

  test("an uncovered hinge is reported", () => {
    expect(uncoveredMotions(hinge(), hinge().defaults).motions).toEqual([
      { view: "assembly", param: "open", range: [0, 110], moving: ["lid"], against: ["base"] },
    ]);
  });

  for (const [kind, sweep] of Object.entries(covering)) {
    test(`a ${kind} sweep covers the motion`, () => {
      const part = covered(sweep);
      expect(coveredParams(part, "assembly", part.defaults).has("open")).toBe(true);
      expect(uncoveredMotions(part, part.defaults).motions).toEqual([]);
    });
  }

  test("a sweep limited to another view does not cover this one", () => {
    const part = covered({ param: "open", views: ["print"] });
    expect(coveredParams(part, "assembly", part.defaults).has("open")).toBe(false);
    expect(uncoveredMotions(part, part.defaults).motions.map((m) => m.param)).toEqual(["open"]);
  });

  test("a path covers only the keys its waypoints change", () => {
    const part = covered({ path: [{ open: 0, other: 1 }, { open: 0, other: 2 }] });
    const keys = coveredParams(part, "assembly", part.defaults);
    expect(keys.has("open")).toBe(false);
    expect(keys.has("other")).toBe(true);
  });

  test("the motion of the third view is reported with that view's name", () => {
    const part = hinge();
    part.views = { print: { label: "Print" }, flat: { label: "Flat" }, assembly: { label: "Assembly" } };
    for (const [name, sp] of Object.entries(part.parts)) {
      sp.views = { ...sp.views, print: (s) => s.translate([name === "lid" ? 30 : 0, 0, 0]), flat: (s) => s.translate([0, name === "lid" ? 30 : 0, 0]) };
    }
    expect(uncoveredMotions(part, part.defaults).motions).toEqual([
      { view: "assembly", param: "open", range: [0, 110], moving: ["lid"], against: ["base"] },
    ]);
  });

  test("no views map, or one exportable piece, gives nothing", () => {
    const part = hinge();
    delete part.views;
    expect(uncoveredMotions(part, part.defaults).motions).toEqual([]);
    const ghost = hinge();
    ghost.parts.base.exportable = false;
    expect(uncoveredMotions(ghost, ghost.defaults).motions).toEqual([]);
  });
});

test("MOTION_HINT is the exact text", () => {
  const entry = { view: "assembly", param: "open", range: [0, 110], moving: ["lid"], against: ["base", "pin"] };
  expect(MOTION_HINT(entry)).toBe(
    `"open" moves lid against base, pin in view "assembly" and no sweep checks that motion. `
    + `Add verify.sweeps: { open: { param: "open", clearance: 0 } } and verify.expect._view: { sweepContacts: 0 }.`,
  );
  expect(MOTION_HINT({ ...entry, range: null })).toBe(
    `"open" moves lid against base, pin in view "assembly" and no sweep checks that motion. `
    + `Give the "open" control a min and max, then add verify.sweeps: { open: { param: "open", clearance: 0 } } and verify.expect._view: { sweepContacts: 0 }.`,
  );
});

test("the hand reference part: the scan's work is bounded by the params a placement reads", () => {
  // The params some placement reads, per view (a place-scope probe's reads).
  const placeReads = new Map(Object.keys(hand.views).map((view) => {
    const reads = new Set();
    for (const e of probePoses(hand, view, hand.defaults, { scope: "place" }).values()) for (const k of e.reads ?? []) reads.add(k);
    return [view, reads];
  }));
  // Each pose call or full scan, attributed to (view, the params it changes from the defaults).
  const base = resolveParams(hand, hand.defaults).p;
  const changed = (q) => Object.keys(q).filter((k) => !Object.is(q[k], base[k])).join(",");
  scanMotion.mockClear();
  poseMatrices.mockClear();
  const t0 = performance.now();
  uncoveredMotions(hand, hand.defaults, undefined, { budgetMs: Infinity });
  const ms = performance.now() - t0;

  // A full scan only ever runs for a param some placement reads in that view.
  const scans = scanMotion.mock.calls.map(([, view, s]) => {
    const lo = s.at(s.lo), hi = s.at(s.hi);
    return { view, param: Object.keys(lo).filter((k) => !Object.is(lo[k], hi[k])).join(",") };
  });
  for (const { view, param } of scans) expect(placeReads.get(view).has(param), `${view}:${param}`).toBe(true);
  const readPairs = [...placeReads.values()].reduce((n, r) => n + r.size, 0);
  expect(scans.length).toBeLessThanOrEqual(readPairs);

  // Pose calls per (view, param): a param no placement reads gets none at all (the
  // place-scope reads rule it out); one that a placement reads gets its sample run once,
  // the pre-filter's probes being samples of it (2 more around a value with no range), and
  // the full scan's run only when a build reads it.
  const calls = new Map();
  for (const [, view, p] of poseMatrices.mock.calls) {
    const key = `${view}|${changed(p)}`;
    calls.set(key, (calls.get(key) ?? 0) + 1);
  }
  const scanned = new Set(scans.map(({ view, param }) => `${view}|${param}`));
  for (const [key, n] of calls) {
    const [view, param] = key.split("|");
    if (!param) continue; // a probe at the defaults, shared by every param
    expect(param.includes(","), key).toBe(false);
    expect(placeReads.get(view).has(param), key).toBe(true);
    const cap = MOTION_SAMPLES + 1 + 2 + (scanned.has(key) ? MOTION_SAMPLES + 1 : 0);
    expect(n, key).toBeLessThanOrEqual(cap);
  }
  // not vacuous: the joints the hand reports did get their full sample runs
  expect([...calls.values()].some((n) => n > 5)).toBe(true);
  // hand's print view poses nothing: nothing there gets more than the pre-filter
  expect(placeReads.get("print").size).toBe(0);

  expect(ms).toBeLessThan(1000); // loose ceiling only: the counts above are the real check
});

test("motionFinding: the message and the hint, which MOTION_HINT joins", () => {
  const entry = { view: "assembly", param: "open", range: [0, 110], moving: ["lid"], against: ["base"] };
  const { message, hint } = motionFinding(entry);
  expect(message).toBe(`"open" moves lid against base in view "assembly" and no sweep checks that motion`);
  expect(hint).toBe(`Add verify.sweeps: { open: { param: "open", clearance: 0 } } and verify.expect._view: { sweepContacts: 0 }.`);
  expect(MOTION_HINT(entry)).toBe(`${message}. ${hint}`);
});

describe("readSweeps", () => {
  test("reads each declared sweep once, by name, and a caller's reads are honoured", () => {
    const part = hinge({ verify: { sweeps: { open: { param: "open" } } } });
    expect([...readSweeps(part).keys()]).toEqual(["open"]);
    expect(uncoveredMotions(part).motions).toEqual([]);
    // reads handed in are used as given: none means nothing is covered
    expect(uncoveredMotions(part, part.defaults, new Map()).motions.map((m) => m.param)).toEqual(["open"]);
    expect(readSweeps(hinge()).size).toBe(0);
  });
});

describe("params that are never motions", () => {
  test("a goal handle's target (position and aim) is not a motion; its seed may be", () => {
    // the lid follows `open`, which a goal handle writes as its target
    const part = hinge({ handles: { aim: { on: "arm", drag: "goal", params: { position: ["open"], aim: [] }, seed: [] } } });
    expect(motions(part)).toEqual([]);
    // a goal handle's seed is not its target
    const seeded = hinge({ handles: { aim: { on: "arm", drag: "goal", params: { position: [] }, seed: ["open"] } } });
    expect(brief(motions(seeded))).toEqual([{ param: "open", moving: ["lid"], against: ["base"] }]);
  });

  test("a malformed goal handle excludes nothing and never throws", () => {
    const part = hinge({ handles: { aim: { drag: "goal", params: { position: "open" } }, bad: null } });
    expect(brief(motions(part))).toEqual([{ param: "open", moving: ["lid"], against: ["base"] }]);
  });

  test("a param with a statically hidden control and no handle is not a motion", () => {
    const part = hinge();
    part.parameters[0].controls[0].hidden = true;
    expect(motions(part)).toEqual([]);
    const sectionHidden = hinge();
    sectionHidden.parameters[0].hidden = true;
    expect(motions(sectionHidden)).toEqual([]);
  });

  test("the same hidden param a handle writes is a motion", () => {
    const part = hinge({ handles: { hinge: { point: () => [0, 5, 10], drag: "rotary", axis: [1, 0, 0], params: ["open"] } } });
    part.parameters[0].controls[0].hidden = true;
    expect(brief(motions(part))).toEqual([{ param: "open", moving: ["lid"], against: ["base"] }]);
  });
});

describe("uncoveredMotions: memo and budget", () => {
  test("a second call with the same part and params does no probing", () => {
    const part = hinge();
    const first = uncoveredMotions(part, part.defaults);
    expect(first.motions.map((m) => m.param)).toEqual(["open"]);
    poseMatrices.mockClear();
    scanMotion.mockClear();
    const second = uncoveredMotions(part, { ...part.defaults });
    expect(second).toEqual(first);
    expect(poseMatrices).not.toHaveBeenCalled();
    expect(scanMotion).not.toHaveBeenCalled();
    // other params scan again
    uncoveredMotions(part, { ...part.defaults, open: 10 });
    expect(poseMatrices).toHaveBeenCalled();
  });

  test("an expired budget stops the scan and says so", () => {
    expect(uncoveredMotions(hinge(), undefined, undefined, { budgetMs: 0 })).toEqual({ motions: [], partial: true });
    let t = 0;
    const late = uncoveredMotions(hinge(), undefined, undefined, { budgetMs: 5, now: () => (t += 10) });
    expect(late.partial).toBe(true);
  });

  test("motions found before the cutoff are kept", () => {
    // two views each with one motion; the clock runs out after the first view's param
    const part = hinge();
    part.parameters[0].controls.push(ctl("slide", 0, 20));
    part.defaults.slide = 0;
    part.parts.lid.views.side = (s, p) => s.translate([20 + p.slide, 0, 0]);
    part.parts.base.views.side = (s) => s;
    part.views.side = { label: "Side" };
    let calls = 0;
    // stop() is asked once per view before the probe, then once per candidate param
    const r = uncoveredMotions(part, part.defaults, undefined, { budgetMs: 1, now: () => (calls++ < 4 ? 0 : 10) });
    expect(r.partial).toBe(true);
    expect(r.motions.map((m) => m.param)).toEqual(["open"]);
  });

  test("a complete scan is not partial", () => {
    expect(uncoveredMotions(hinge(), undefined, undefined, { budgetMs: Infinity }).partial).toBe(false);
  });
});

describe("the scan's work", () => {
  test("a size param whose build hashes differ at lo, mid and hi costs no full scan", () => {
    const part = twoBox({
      controls: [ctl("height", 5, 40)], defaults: { height: 10 },
      baseBuild: (k, p) => k.box({ size: [10, 10, p.height] }),
      lid: (s, p) => s.translate([0, 0, p.height]),
    });
    scanMotion.mockClear();
    poseMatrices.mockClear();
    probePoses.mockClear();
    expect(uncoveredMotions(part, part.defaults, undefined, { budgetMs: Infinity }).motions).toEqual([]);
    expect(scanMotion).not.toHaveBeenCalled();
    // the pre-filter's 3 placements, and no sample run
    expect(poseMatrices.mock.calls.length).toBeLessThanOrEqual(3);
    // one build-scope and one place-scope probe at the defaults, then at most lo, mid, hi
    const builds = probePoses.mock.calls.filter(([, , , o]) => o?.scope === "build");
    expect(builds.length).toBeLessThanOrEqual(1 + 3);
  });

  test("a param no placement reads costs no placement probe", () => {
    const part = hinge();
    part.parameters[0].controls.push(ctl("unused", 0, 10));
    part.defaults.unused = 0;
    poseMatrices.mockClear();
    uncoveredMotions(part, part.defaults, undefined, { budgetMs: Infinity });
    expect(poseMatrices.mock.calls.filter(([, , p]) => p.unused !== 0)).toEqual([]);
  });

  test("the narrow-window rebuild still takes the full scan to find", () => {
    const part = hinge();
    part.parts.base.build = (k, p) => k.box({ size: [p.open > 40 && p.open < 50 ? 12 : 10, 10, 10] });
    scanMotion.mockClear();
    expect(uncoveredMotions(part, part.defaults, undefined, { budgetMs: Infinity }).motions).toEqual([]);
    expect(scanMotion).toHaveBeenCalledTimes(1);
  });
});

describe("a build the probe cannot trust", () => {
  // A build that queries its own solid: the probe answers with stand-ins, so its hash is
  // untrusted, but what it READS is still recorded.
  const querying = (read = () => {}) => (k, p) => { const b = box(k); b.boundingBox(); read(p); return b; };

  test("a third piece whose build queries and does not read the param leaves the hinge a motion", () => {
    const part = hinge();
    part.parts.tag = { views: { assembly: (s) => s.translate([30, 0, 0]) }, build: querying() };
    expect(brief(motions(part))).toEqual([{ param: "open", moving: ["lid"], against: ["base", "tag"] }]);
  });

  test("the moving lid's own build queries and does not read the param: still a motion", () => {
    const part = hinge();
    part.parts.lid.build = querying();
    expect(brief(motions(part))).toEqual([{ param: "open", moving: ["lid"], against: ["base"] }]);
  });

  test("a querying build that reads the param rebuilds: not a motion", () => {
    const part = twoBox({
      controls: [ctl("height", 5, 40)], defaults: { height: 10 },
      baseBuild: (k, p) => { const b = k.box({ size: [10, 10, p.height] }); b.boundingBox(); return b; },
      lid: (s, p) => s.translate([0, 0, p.height]),
    });
    expect(motions(part)).toEqual([]);
  });

  test("a querying build that throws counts as rebuilding", () => {
    const part = hinge();
    part.parts.tag = { views: { assembly: (s) => s.translate([30, 0, 0]) }, build: (k) => { box(k).boundingBox(); throw new Error("no"); } };
    expect(motions(part)).toEqual([]);
  });
});

test("the memo rescans when part.parameters is replaced on the same object", () => {
  const part = hinge();
  expect(uncoveredMotions(part).motions.map((m) => m.param)).toEqual(["open"]);
  part.parameters = [{ ...part.parameters[0], controls: [{ ...part.parameters[0].controls[0], hidden: true }] }];
  expect(uncoveredMotions(part).motions).toEqual([]);
});
