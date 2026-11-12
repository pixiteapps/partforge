import { describe, expect, test } from "vitest";
import { motionParams, coveredParams, uncoveredMotions, MOTION_HINT } from "../src/framework/collide/motion-coverage.js";
import hand from "../src/parts/hand.js";

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
    expect(uncoveredMotions(hinge(), hinge().defaults)).toEqual([
      { view: "assembly", param: "open", range: [0, 110], moving: ["lid"], against: ["base"] },
    ]);
  });

  for (const [kind, sweep] of Object.entries(covering)) {
    test(`a ${kind} sweep covers the motion`, () => {
      const part = covered(sweep);
      expect(coveredParams(part, "assembly", part.defaults).has("open")).toBe(true);
      expect(uncoveredMotions(part, part.defaults)).toEqual([]);
    });
  }

  test("a sweep limited to another view does not cover this one", () => {
    const part = covered({ param: "open", views: ["print"] });
    expect(coveredParams(part, "assembly", part.defaults).has("open")).toBe(false);
    expect(uncoveredMotions(part, part.defaults).map((m) => m.param)).toEqual(["open"]);
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
    expect(uncoveredMotions(part, part.defaults)).toEqual([
      { view: "assembly", param: "open", range: [0, 110], moving: ["lid"], against: ["base"] },
    ]);
  });

  test("no views map, or one exportable piece, gives nothing", () => {
    const part = hinge();
    delete part.views;
    expect(uncoveredMotions(part, part.defaults)).toEqual([]);
    const ghost = hinge();
    ghost.parts.base.exportable = false;
    expect(uncoveredMotions(ghost, ghost.defaults)).toEqual([]);
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
    + `Give the "open" control a min and max first, so the sweep has a range.`,
  );
});

test("the hand reference part scans in under 150 ms", () => {
  uncoveredMotions(hand, hand.defaults); // warm the caches lint shares with every other rule
  const t0 = performance.now();
  uncoveredMotions(hand, hand.defaults);
  expect(performance.now() - t0).toBeLessThan(150);
});
