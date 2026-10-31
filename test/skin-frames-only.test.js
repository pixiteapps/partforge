import { test, expect } from "vitest";
import { framesOnlyChange } from "../src/framework/skin/frames-only.js";
import { TWO_BONE, BALL } from "./fixtures/skin-fixtures.js";

test("a change inside frames alone is frames-only", () => expect(framesOnlyChange([TWO_BONE(0)], [TWO_BONE(30)])).toBe(true));

const base = TWO_BONE(0);
test.each([
  ["a radius", { ...base, root: { ...base.root, children: [{ ...base.root.children[0], r: 5 }, base.root.children[1]] } }],
  ["a blend k", { ...base, root: { ...base.root, k: 3 } }],
  ["a node added", { ...base, root: { ...base.root, children: [...base.root.children, { kind: "sphere", frame: "root", at: [0, 0, 0], r: 2 }] } }],
  ["a frame added", { ...base, frames: { ...base.frames, extra: { at: [1, 1, 1] } } }],
  ["a frame removed", { ...base, frames: { root: base.frames.root } }],
  ["frames reordered", { ...base, frames: { child: base.frames.child, root: base.frames.root } }],
])("%s is not frames-only", (_n, changed) => expect(framesOnlyChange([base], [changed])).toBe(false));

test("a different number of k.implicit calls, or none, is not frames-only", () => {
  expect(framesOnlyChange([BALL()], [BALL(), BALL("root")])).toBe(false);
  expect(framesOnlyChange([], [])).toBe(false);
});

test("repeated same-shape calls pair by position", () => {
  expect(framesOnlyChange([TWO_BONE(0), TWO_BONE(0)], [TWO_BONE(10), TWO_BONE(20)])).toBe(true);
});
