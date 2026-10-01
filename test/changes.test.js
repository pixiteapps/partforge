import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { buildView } from "../src/framework/oracle/build.js";
import { measure } from "../src/framework/oracle/measure.js";
import { createChangeTracker } from "../src/framework/oracle/changes.js";
import hinged from "../src/parts/hinged-box.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

// One inspect, the way jobs.js runs it: the tracker captures its meshes between
// buildView and measure, because measure's cleanup frees the posed solids.
function inspect(tracker, part, key = "forge-1", view = "box") {
  tracker.begin(key, view);
  const built = buildView(k, part, view, {});
  tracker.endBuild(built);
  const measured = measure(k, part, view, {}, { built, minWall: false, gaps: false, memo: tracker.memo });
  const out = tracker.finish(k, view, built, measured);
  k.cleanup();
  return out;
}

const withLid = (build) => ({ ...hinged, parts: { ...hinged.parts, lid: { ...hinged.parts.lid, build } } });

test("first inspect has no baseline", () => {
  expect(inspect(createChangeTracker(), hinged)).toEqual({});
});

test("an identical rebuild is unchanged", () => {
  const t = createChangeTracker();
  inspect(t, hinged);
  expect(inspect(t, { ...hinged })).toEqual({ changes: { unchanged: true, subparts: [], unchangedSubparts: 2 } });
});

test("a translated sub-part is moved by the exact offset, without booleans", () => {
  const t = createChangeTracker();
  inspect(t, hinged);
  let calls = 0;
  const orig = k._meshDiff;
  k._meshDiff = (...a) => { calls++; return orig(...a); };
  const out = inspect(t, withLid((kk, p, d) => hinged.parts.lid.build(kk, p, d).translate([0, 0, 5])));
  k._meshDiff = orig;
  const lid = out.changes.subparts.find((s) => s.name === "lid");
  expect(lid.verdict).toBe("moved");
  lid.moved.forEach((v, i) => expect(v).toBeCloseTo([0, 0, 5][i], 3));
  expect(calls).toBe(0);
  expect(out.changes.unchangedSubparts).toBe(1);
});

test("a place-only change (assembly pose) is never unchanged", () => {
  const t = createChangeTracker();
  inspect(t, hinged);
  const placed = { ...hinged, parts: { ...hinged.parts, lid: { ...hinged.parts.lid,
    place: (s, ctx) => (hinged.parts.lid.place ? hinged.parts.lid.place(s, ctx) : s).translate([1, 0, 0]) } } };
  const lid = inspect(t, placed).changes.subparts.find((s) => s.name === "lid");
  expect(lid.verdict).toBe("moved");
  lid.moved.forEach((v, i) => expect(v).toBeCloseTo([1, 0, 0][i], 3));
});

test("added material is located and its root op is named", () => {
  const t = createChangeTracker();
  inspect(t, hinged);
  const out = inspect(t, withLid((kk, p, d) =>
    hinged.parts.lid.build(kk, p, d).union(kk.cylinder({ d: 6, h: 6 }).label("knob"))));
  const lid = out.changes.subparts.find((s) => s.name === "lid");
  expect(["added", "reshaped"]).toContain(lid.verdict);
  expect(lid.addedMm3).toBeGreaterThan(100);
  expect(lid.regions[0].change).toBe("added");
  expect(lid.changedOps.some((o) => o.label === "knob")).toBe(true);
  expect(out.changes.unchangedSubparts).toBe(1);
});

test("a sub-part missing from the baseline is new, and one missing now is deleted", () => {
  const t = createChangeTracker();
  const { lid, ...rest } = hinged.parts;
  inspect(t, { ...hinged, parts: rest });
  expect(inspect(t, hinged).changes).toEqual({ subparts: [{ name: "lid", verdict: "new" }], unchangedSubparts: 1 });
  expect(inspect(t, { ...hinged, parts: rest }).changes).toEqual({ subparts: [{ name: "lid", verdict: "deleted" }], unchangedSubparts: 1 });
});

test("a kernel without a mesh diff reports reshaped with the volume delta", () => {
  const t = createChangeTracker();
  inspect(t, hinged);
  const orig = k._meshDiff;
  k._meshDiff = undefined;
  try {
    const out = inspect(t, withLid((kk, p, d) => hinged.parts.lid.build(kk, p, d).union(kk.cylinder({ d: 6, h: 6 }))));
    const lid = out.changes.subparts.find((s) => s.name === "lid");
    expect(lid.verdict).toBe("reshaped");
    expect(lid.volumeDeltaMm3).toBeGreaterThan(100);
    expect(out.changesSkipped).toBeUndefined();
  } finally { k._meshDiff = orig; }
});

test("a refused mesh diff keeps the verdicts and names the reason", () => {
  const t = createChangeTracker();
  inspect(t, hinged);
  const orig = k._meshDiff;
  k._meshDiff = () => ({ ok: false, reason: "too-large" });
  try {
    const out = inspect(t, withLid((kk, p, d) => hinged.parts.lid.build(kk, p, d).union(kk.cylinder({ d: 6, h: 6 }))));
    expect(out.changesSkipped).toBe("too-large");
    expect(out.changes.subparts.find((s) => s.name === "lid").verdict).toBe("reshaped");
  } finally { k._meshDiff = orig; }
});

test("a new key forgets the baseline (forge switch)", () => {
  const t = createChangeTracker();
  inspect(t, hinged, "forge-1");
  expect(inspect(t, hinged, "forge-2")).toEqual({});
});

test("a different view has no baseline", () => {
  const t = createChangeTracker();
  inspect(t, hinged, "forge-1", "box");
  const views = Object.keys(hinged.views);
  if (views.length > 1) expect(inspect(t, hinged, "forge-1", views[1])).toEqual({});
});

test("an aborted round leaves the baseline in place", () => {
  const t = createChangeTracker();
  inspect(t, hinged);
  t.begin("forge-1", "box");
  t.abort();
  expect(inspect(t, hinged).changes).toEqual({ unchanged: true, subparts: [], unchangedSubparts: 2 });
});

test("budget exhausted mid-diff keeps the verdicts reached and reports timeout", () => {
  let clock = 0;
  const t = createChangeTracker({ now: () => (clock += 5000), budgetMs: 1 });
  inspect(t, hinged);
  const out = inspect(t, withLid((kk, p, d) => hinged.parts.lid.build(kk, p, d).union(kk.cylinder({ d: 6, h: 6 }))));
  expect(out.changesSkipped).toBe("timeout");
  expect(out.changes.subparts.find((s) => s.name === "lid")).toBeUndefined();
  expect(out.changes.unchanged).toBeUndefined();
  expect(out.changes.unchangedSubparts).toBe(1);
});

test("budget exhausted before any verdict reports timeout alone", () => {
  let clock = 0;
  const t = createChangeTracker({ now: () => (clock += 5000), budgetMs: 1 });
  const lidOnly = (build) => ({ ...hinged, parts: { lid: { ...hinged.parts.lid, ...(build ? { build } : {}) } } });
  inspect(t, lidOnly());
  const out = inspect(t, lidOnly((kk, p, d) => hinged.parts.lid.build(kk, p, d).union(kk.cylinder({ d: 6, h: 6 }))));
  expect(out).toEqual({ changesSkipped: "timeout" });
});

test("finish never throws", () => {
  const t = createChangeTracker();
  t.begin("k", "box");
  t.endBuild(null);
  expect(t.finish(k, "box", null, null)).toEqual({});
});
