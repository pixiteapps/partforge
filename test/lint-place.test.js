// test/lint-place.test.js
// The two place() invariants, promoted from doc-only to lint: display
// placement must not read `view`, and display-vs-export must differ by a
// rigid motion only. Both run the place-scope probe (place() alone, on a canonical
// token), so a querying build no longer hides them; a place() the probe cannot
// read (it queries the solid or passes a function) stays silent.
import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";

const mk = (place) => ({
  meta: { title: "T" },
  parameters: [],
  defaults: { a: 1 },
  parts: { p: { views: ["v", "w"], build: (k) => k.box({ size: [1, 1, 1] }), ...(place && { place }) } },
  views: { v: { label: "V" }, w: { label: "W" } },
});
const ids = (r) => r.errors.map((f) => f.rule);

test("clean part: no place findings", () => {
  expect(ids(lintPart(mk())).filter((i) => i.includes("place"))).toEqual([]);
  expect(ids(lintPart(mk((s) => s.translate([1, 0, 0])))).filter((i) => i.includes("place"))).toEqual([]);
});

test("a display pose that depends on the view is allowed (the viewer re-poses per tab)", () => {
  const r = lintPart(mk((s, { view }) => (view === "w" ? s.translate([5, 0, 0]) : s)));
  expect(ids(r).filter((i) => i.includes("place"))).toEqual([]);
});

test("non-rigid display/export delta → place-not-rigid", () => {
  const r = lintPart(mk((s, { purpose }) => (purpose === "export" ? s.scale(2) : s)));
  expect(ids(r)).toContain("place-not-rigid");
  // fixture part has two views ("v", "w") — this pins the one-finding-per-sub-part dedupe
  expect(ids(r).filter((i) => i === "place-not-rigid")).toHaveLength(1);
});

test("two non-rigid sub-parts in one view are both reported", () => {
  const part = {
    meta: { title: "T" }, parameters: [], defaults: { a: 1 },
    parts: {
      p1: { views: ["v"], build: (k) => k.box({ size: [1, 1, 1] }),
        place: (s, { purpose }) => (purpose === "export" ? s.scale(2) : s) },
      p2: { views: ["v"], build: (k) => k.box({ size: [2, 2, 2] }),
        place: (s, { purpose }) => (purpose === "export" ? s.scale(3) : s) },
    },
    views: { v: { label: "V" } },
  };
  const found = lintPart(part).errors.filter((f) => f.rule === "place-not-rigid");
  expect(found.map((f) => f.path).sort()).toEqual(["parts.p1.place", "parts.p2.place"]);
});

test("a rigid display/export difference is allowed", () => {
  const r = lintPart(mk((s, { purpose }) => (purpose === "export" ? s.translate([10, 0, 0]) : s.rotate(30, [0, 0, 0], [1, 0, 0]))));
  expect(ids(r).filter((i) => i.includes("place"))).toEqual([]);
});

test("a querying build behind a rigid place() earns no place finding", () => {
  const part = mk((s) => s);
  part.parts.p.build = (k) => { const b = k.box({ size: [1, 1, 1] }); b.volume(); return b; };
  expect(ids(lintPart(part)).filter((i) => i.includes("place"))).toEqual([]);
});

test("place-not-rigid is found behind a querying build (the full probe used to stay silent)", () => {
  const part = mk((s, { purpose }) => (purpose === "export" ? s.scale(2) : s));
  part.parts.p.build = (k) => { const b = k.box({ size: [1, 1, 1] }); b.boundingBox(); return b; };
  expect(ids(lintPart(part))).toContain("place-not-rigid");
});

test("the same reshape on both purposes is allowed", () => {
  const r = lintPart(mk((s, { purpose }) => (purpose === "export" ? s.scale(2).translate([5, 0, 0]) : s.scale(2))));
  expect(ids(r).filter((i) => i.includes("place"))).toEqual([]);
});

test("a place() that queries the solid proves nothing and stays silent", () => {
  const r = lintPart(mk((s, { purpose }) => (purpose === "export" ? s.scale(2) : s.translate([0, 0, s.boundingBox().size[2]]))));
  expect(ids(r).filter((i) => i.includes("place"))).toEqual([]);
});
