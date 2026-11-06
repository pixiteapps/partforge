// Which views a handle shows in (pose/handle-views.js): a declared `views` list, else the
// automatic rule — its params are relevant here AND, when some view draws its source, this
// view does. The bug it fixes: a print layout that reads any derived value made every pose
// param "relevant" (a single-function derive attributes a read to all its inputs), so the
// handles showed in the print view at the assembly pose, floating in air.
import { describe, it, expect } from "vitest";
import { handlesShownInView, viewSourceReads } from "../src/framework/pose/handle-views.js";
import { relevantParamKeys } from "../src/framework/param-deps.js";
import { handlesReport } from "../src/framework/oracle/handles.js";
import fixture from "./fixtures/ik-hand-fixture.js";
import hand from "../src/parts/hand.js";
import robotArm from "../src/parts/robot-arm.js";
import gearbox from "../src/parts/gearbox.js";
import drawerBox from "../src/parts/drawer-box.js";

// The IK hand fixture with each finger drawn (placed by its limb in "hand") and a "print"
// view that lays everything flat — reading one derived value (`gap`), as a kit layout does.
const flat = (x) => (s, p, d) => s.translate([x * d.gap, -60, 0]);
const twoViews = {
  ...fixture,
  derive: (p) => ({ ...fixture.derive(p), gap: 30 }),
  parts: {
    palm: { ...fixture.parts.palm, views: { ...fixture.parts.palm.views, print: flat(0) } },
    fa: { label: "Finger A", build: (k) => k.box({ min: [-4, -4, 0], max: [4, 4, 40] }), views: { hand: (s, p, d) => d.a.place(s, "mcp"), print: flat(1) } },
    fb: { label: "Finger B", build: (k) => k.box({ min: [-4, -4, 0], max: [4, 4, 40] }), views: { hand: (s, p, d) => d.b.place(s, "mcp"), print: flat(2) } },
  },
  views: { hand: { label: "Hand" }, print: { label: "Print" } },
};

describe("handlesShownInView", () => {
  it("a print layout that reads a derived value makes the pose params relevant (the bug's cause)", () => {
    const relevant = relevantParamKeys(twoViews, "print", { ...twoViews.defaults });
    expect(relevant.has("aCurl")).toBe(true);
    expect(relevant.has("bCurl")).toBe(true);
  });

  it("hides a handle in a view that draws none of its source", () => {
    expect(handlesShownInView(twoViews, "hand", {})).toEqual(["a", "b"]);
    expect(handlesShownInView(twoViews, "print", {})).toEqual([]);
  });

  it("reads which derived values a view's sub-parts read (build and placement)", () => {
    expect([...viewSourceReads(twoViews, "hand", {})].sort()).toEqual(["a", "b"]);
    expect([...viewSourceReads(twoViews, "print", {})]).toEqual(["gap"]);
  });

  it("a sub-part whose probe throws does not blind the view: the others' reads still count", () => {
    const boom = { label: "Boom", build: () => { throw new Error("probe cannot build this"); }, views: { hand: (s) => s, print: flat(3) } };
    const part = { ...twoViews, parts: { ...twoViews.parts, boom } };
    expect([...viewSourceReads(part, "hand", {})].sort()).toEqual(["a", "b"]);
    expect([...viewSourceReads(part, "print", {})]).toEqual(["gap"]);
    expect(handlesShownInView(part, "print", {})).toEqual([]);
    // the reads made before the throw are kept
    const early = { label: "Early", build: (k, p, d) => { if (d.a) throw new Error("late"); }, views: { print: flat(4) } };
    expect([...viewSourceReads({ ...part, parts: { ...part.parts, early } }, "print", {})].sort()).toEqual(["a", "gap"]);
    // only when every sub-part fails is the view unknown
    expect(viewSourceReads({ ...part, parts: { boom } }, "hand", {})).toBeNull();
  });

  it("a source no view draws says nothing: relevance alone decides", () => {
    // the plain fixture draws only the palm: neither finger limb is read by any view, so
    // `a` shows (the palm reads its `wrist`) and `b` does not (nothing reads its params)
    expect(viewSourceReads(fixture, "hand", {}).size).toBe(0);
    expect(handlesShownInView(fixture, "hand", {})).toEqual(["a"]);
  });

  it("a declared `views` list is the whole rule", () => {
    const part = { ...twoViews, handles: { ...twoViews.handles, a: { ...twoViews.handles.a, views: ["print"] }, b: { ...twoViews.handles.b, views: ["hand", "print"] } } };
    expect(handlesShownInView(part, "hand", {})).toEqual(["b"]);
    expect(handlesShownInView(part, "print", {})).toEqual(["a", "b"]);
  });

  it("a `point` handle's source is what its function reads from d", () => {
    const part = { ...twoViews, handles: {
      onA: { point: (p, d) => d.a.world("tip").origin, params: ["aCurl"] },
      plain: { point: (p) => [0, 0, p.aCurl], params: ["aCurl"] },
    } };
    expect(handlesShownInView(part, "hand", {})).toEqual(["onA", "plain"]);
    expect(handlesShownInView(part, "print", {})).toEqual(["plain"]);
  });

  it("a showOn naming only sub-parts outside the view hides the handle", () => {
    const part = { ...twoViews,
      parts: { ...twoViews.parts, knob: { label: "Knob", build: (k) => k.box({ min: [0, 0, 0], max: [1, 1, 1] }), views: { hand: (s) => s } } },
      handles: { k: { point: (p) => [0, 0, p.wrist], params: ["wrist"], showOn: "knob" } } };
    expect(handlesShownInView(part, "hand", {})).toEqual(["k"]);
    expect(handlesShownInView(part, "print", {})).toEqual([]);
  });

  it("the oracle's handles report follows the same rule", () => {
    expect(handlesReport(twoViews, "hand", {}).map((h) => h.id)).toEqual(["a", "b"]);
    expect(handlesReport(twoViews, "print", {})).toEqual([]);
  });

  it("hand's print kit would hide its handles even without its declared views", () => {
    const auto = { ...hand, handles: Object.fromEntries(Object.entries(hand.handles).map(([id, h]) => [id, { ...h, views: undefined }])) };
    expect(handlesShownInView(auto, "assembly", {})).toEqual(Object.keys(hand.handles));
    expect(handlesShownInView(auto, "print", {})).toEqual([]);
  });

  it("the reference parts show their handles in their main view only", () => {
    expect(handlesShownInView(hand, "assembly", {})).toEqual(Object.keys(hand.handles));
    expect(handlesShownInView(hand, "print", {})).toEqual([]);
    expect(handlesShownInView(robotArm, "assembly", {})).toEqual(["tool"]);
    expect(handlesShownInView(gearbox, "gearbox", {})).toEqual(Object.keys(gearbox.handles));
    expect(handlesShownInView(drawerBox, "cabinet", {})).toEqual(Object.keys(drawerBox.handles));
  });
});
