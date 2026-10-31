import { test, expect } from "vitest";
import { probeSubPartPose } from "../src/framework/pose-probe-core.js";
import { TWO_BONE, BALL } from "./fixtures/skin-fixtures.js";

const a = TWO_BONE(0), b = BALL();
const ctx = { view: "v", p: {}, d: {} };
const probe = (build, scope = "build", sp = { build }) => probeSubPartPose(sp, ctx, { scope });

test("a union of k.implicit results is skinnable and records the specs in call order", () => {
  const r = probe((k) => k.union([k.implicit(a), k.implicit(b)]));
  expect(r.skinnable).toBe(true);
  expect(r.implicitSpecs).toEqual([a, b]);
  expect(r.trusted).toBe(true);
});

test("a lone k.implicit is skinnable; a union with a plain box too", () => {
  expect(probe((k) => k.implicit(a)).skinnable).toBe(true);
  expect(probe((k) => k.union([k.implicit(a), k.box([1, 1, 1])])).skinnable).toBe(true);
  expect(probe((k) => k.implicit(a).union(k.box([1, 1, 1]))).skinnable).toBe(true);
});

test.each([
  ["k.implicit(a).translate([1,0,0])", (k) => k.implicit(a).translate([1, 0, 0])],
  ["translated child in union", (k) => k.union([k.implicit(a).translate([1, 0, 0]), k.implicit(b)])],
  ["cut", (k) => k.implicit(a).cut(k.box([1, 1, 1]))],
  ["mirror", (k) => k.implicit(a).mirror("yz")],
  ["translated union", (k) => k.union([k.implicit(a), k.implicit(b)]).translate([0, 0, 1])],
])("a moved or cut implicit is not skinnable: %s", (_n, build) => {
  const r = probe(build);
  expect(r.skinnable).toBe(false);
  expect(r.implicitSpecs.length).toBeGreaterThan(0);
});

test("a build with no implicit has skinnable false and no specs", () => {
  const r = probe((k) => k.box([1, 1, 1]));
  expect(r.skinnable).toBe(false);
  expect(r.implicitSpecs).toEqual([]);
});

test("a throwing build yields no specs", () => {
  const r = probe((k) => { k.implicit(a); throw new Error("x"); });
  expect(r).toMatchObject({ trusted: false, skinnable: false, implicitSpecs: [] });
});

test("place() steps in full scope do not change skinnable", () => {
  const sp = { build: (k) => k.union([k.implicit(a), k.implicit(b)]), place: (s) => s.translate([5, 0, 0]) };
  expect(probe(null, "full", sp).skinnable).toBe(true);
  expect(probe(null, "full", sp).trusted).toBe(true);
});
