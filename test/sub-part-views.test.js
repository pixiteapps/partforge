import { expect, test } from "vitest";
import { isViewsMap, viewsOf, inView, formOf, placeOf } from "../src/framework/sub-part-views.js";

// A stand-in solid that records the ops applied to it.
const solid = (ops = []) => ({
  ops,
  translate: (v) => solid([...ops, ["t", ...v]]),
  rotateX: (deg) => solid([...ops, ["rx", deg]]),
});

test("isViewsMap is true only for plain objects", () => {
  expect(isViewsMap({ a: true })).toBe(true);
  expect(isViewsMap(["a"])).toBe(false);
  expect(isViewsMap(null)).toBe(false);
  expect(isViewsMap(undefined)).toBe(false);
});

test("viewsOf reads both forms, in declaration order, and drops invalid map entries", () => {
  expect(viewsOf({ views: ["a", "b"] })).toEqual(["a", "b"]);
  const fn = (s) => s;
  expect(viewsOf({ views: { assembly: fn, lid: true, print: fn } })).toEqual(["assembly", "lid", "print"]);
  expect(viewsOf({ views: { a: true, b: false, c: null, d: "yes", e: fn } })).toEqual(["a", "e"]);
  expect(viewsOf({})).toEqual([]);
  expect(viewsOf({ views: "a" })).toEqual([]);
  expect(inView({ views: { a: true, b: false } }, "b")).toBe(false);
});

test("formOf tells the forms apart", () => {
  expect(formOf({ views: { a: true } })).toBe("map");
  expect(formOf({ views: ["a"] })).toBe("legacy");
  expect(formOf({})).toBe("legacy");
});

test("legacy placeOf is the author's place", () => {
  const place = (s) => s;
  expect(placeOf({ views: ["a"], place })).toBe(place);
  expect(placeOf({ views: ["a"] })).toBeNull();
});

test("an all-true map with no place has no placement at all", () => {
  expect(placeOf({ views: { a: true, b: true } })).toBeNull();
});

test("the compiled place applies the view's entry for display and nothing for export", () => {
  const sp = { views: { assembly: (s, p) => s.translate([0, 0, p.h]), lid: true } };
  const place = placeOf(sp);
  const p = { h: 40 }, d = {};
  expect(place(solid(), { view: "assembly", purpose: "display", p, d }).ops).toEqual([["t", 0, 0, 40]]);
  expect(place(solid(), { view: "lid", purpose: "display", p, d }).ops).toEqual([]);
  expect(place(solid(), { view: "assembly", purpose: "export", p, d }).ops).toEqual([]);
  // A view the piece is not in poses nothing (callers never ask, but it must not throw).
  expect(place(solid(), { view: "other", purpose: "display", p, d }).ops).toEqual([]);
});

test("entries receive (s, p, d) — not a context object", () => {
  let seen;
  const sp = { views: { a: (s, p, d) => { seen = [p, d]; return s; } } };
  placeOf(sp)(solid(), { view: "a", purpose: "display", p: { x: 1 }, d: { y: 2 } });
  expect(seen).toEqual([{ x: 1 }, { y: 2 }]);
});

test("a base place (sheetPart's generated pose) runs first, for display AND export", () => {
  const sp = {
    views: { box: (s) => s.translate([1, 0, 0]) },
    place: (s) => s.rotateX(90),
  };
  const place = placeOf(sp);
  expect(place(solid(), { view: "box", purpose: "display", p: {}, d: {} }).ops).toEqual([["rx", 90], ["t", 1, 0, 0]]);
  expect(place(solid(), { view: "box", purpose: "export", p: {}, d: {} }).ops).toEqual([["rx", 90]]);
});

test("placeOf is memoized per sub-part", () => {
  const sp = { views: { a: (s) => s } };
  expect(placeOf(sp)).toBe(placeOf(sp));
});

test("an invalid entry poses nothing", () => {
  const place = placeOf({ views: { a: true, b: false, c: (s) => s.translate([2, 0, 0]) } });
  expect(place(solid(), { view: "b", purpose: "display", p: {}, d: {} }).ops).toEqual([]);
});
