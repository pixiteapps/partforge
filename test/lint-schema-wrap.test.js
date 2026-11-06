import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";

const part = (control, defaults, animations) => ({
  meta: { title: "Test", units: "mm" },
  parameters: [{ id: "s", title: "S", controls: [control] }],
  defaults,
  parts: { body: { views: ["main"], build: (k, p) => k.box({ size: [p.a + 1, 5, 5] }) } },
  views: { main: { label: "Main", ...(animations ? { animations } : {}) } },
});
const all = (r) => [...r.errors, ...r.warnings];
const rules = (r) => all(r).map((f) => f.rule);

test("wrap: true without min/max is an error", () => {
  const r = lintPart(part({ key: "a", type: "slider", label: "A", wrap: true }, { a: 0 }));
  expect(r.errors.map((f) => f.rule)).toContain("wrap-needs-range");
  const half = lintPart(part({ key: "a", type: "slider", label: "A", min: 0, wrap: true }, { a: 0 }));
  expect(half.errors.map((f) => f.rule)).toContain("wrap-needs-range");
});

test("a wrap control with a range is accepted, and an unreduced default is in range", () => {
  const r = lintPart(part({ key: "a", type: "slider", label: "A", min: 0, max: 360, step: 1, wrap: true }, { a: 725 }));
  expect(rules(r)).not.toContain("wrap-needs-range");
  expect(rules(r)).not.toContain("slider-range-excludes-default");
  expect(rules(r)).not.toContain("unknown-control-field");
});

test("a non-wrap control still warns on an out-of-range default", () => {
  const r = lintPart(part({ key: "a", type: "slider", label: "A", min: 0, max: 360, step: 1 }, { a: 725 }));
  expect(rules(r)).toContain("slider-range-excludes-default");
});

test("an animation keyframe past max on a wrap control is not out of range", () => {
  const anim = { spin: { tracks: { a: [[0, 0], [1, 725]] }, duration: 2 } };
  const wrapped = lintPart(part({ key: "a", type: "slider", label: "A", min: 0, max: 360, wrap: true }, { a: 0 }, anim));
  expect(rules(wrapped)).not.toContain("animation-value-out-of-range");
  const plain = lintPart(part({ key: "a", type: "slider", label: "A", min: 0, max: 360 }, { a: 0 }, anim));
  expect(rules(plain)).toContain("animation-value-out-of-range");
});
