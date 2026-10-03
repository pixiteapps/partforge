import { expect, test } from "vitest";
import { resolveSelection, quantizePoint, snapNormal } from "../src/framework/selection/resolve.js";

const view = { v: { label: "V" } };
const part = {
  defaults: { a: 1, b: 2 }, views: view,
  parts: {
    one: { views: ["v"], build: (k, p) => k.cylinder({ r: p.a, h: p.a }) },        // reads a only
    two: { views: ["v"], build: (k, p) => k.box({ min: [0, 0, 0], max: [p.b, p.b, p.b] }) }, // reads b only
  },
};
const ctx = { view: "v", params: { a: 1, b: 2 }, derived: {} };

test("quantizePoint rounds to 0.01mm and removes -0", () => {
  expect(quantizePoint([0.004, 5.2349, -0.001])).toEqual([0, 5.23, 0]);
});

test("snapNormal snaps a near-axis vector to the exact axis", () => {
  expect(snapNormal([0.999, 0.02, 0.0])).toEqual([1, 0, 0]);
  expect(snapNormal([0, -1.0, 0])).toEqual([0, -1, 0]);
});

test("snapNormal leaves an off-axis vector normalized (quantized)", () => {
  const n = snapNormal([1, 1, 0]);
  expect(n[0]).toBeCloseTo(0.71, 2);
  expect(n[1]).toBeCloseTo(0.71, 2);
  expect(n[2]).toBe(0);
});

test("L0: scopes params to the clicked sub-part's read keys, quantizes, snaps", () => {
  const sel = resolveSelection(part, ctx, {
    subPart: "one", pointLocal: [0, 0, 5.2349], normalLocal: [0.999, 0, 0.02],
  });
  expect(sel.subPart).toBe("one");
  expect(sel.point).toEqual([0, 0, 5.23]);
  expect(sel.normal).toEqual([1, 0, 0]);
  expect(sel.params).toEqual({ a: 1 });   // sub-part "one" reads only `a`
  expect(sel.feature).toBeUndefined();     // no face metadata → L0 only
});

test("a hit with a feature resolves to selection.feature.label", () => {
  const s = resolveSelection(part, ctx, {
    subPart: "one", pointLocal: [1, 2, 3], normalLocal: [0, 0, 1],
    feature: { id: 1, label: "Drainage hole" },
  });
  expect(s.feature).toEqual({ label: "Drainage hole" });
});

test("a hit without a feature has no selection.feature", () => {
  const s = resolveSelection(part, ctx, {
    subPart: "one", pointLocal: [1, 2, 3], normalLocal: [0, 0, 1], feature: null,
  });
  expect(s.feature).toBeUndefined();
});

test("resolveSelection carries the cut-face marker through", () => {
  const hit = {
    subPart: "one", pointLocal: [1.004, 0, -2], normalLocal: [0, 0, 1],
    feature: null, onCutPlane: true,
  };
  const s = resolveSelection(part, ctx, hit);
  expect(s.onCutPlane).toBe(true);
  expect(s.feature).toBeUndefined();
});

test("an ordinary pick carries no cut-face marker", () => {
  const hit = { subPart: "one", pointLocal: [0, 0, 2], normalLocal: [0, 0, 1], feature: null };
  expect(resolveSelection(part, ctx, hit).onCutPlane).toBeUndefined();
});

test("scopeParams prefers the recorded reads in ctx.readsOf", () => {
  const part = { defaults: { a: 1, b: 2, c: 3 }, views: { v: { label: "V" } },
    parts: { s: { views: ["v"], build: (k, p) => k.cylinder({ r: p.a, h: 1 }) } } };
  const ctx = { view: "v", params: { a: 1, b: 2, c: 3 }, readsOf: () => new Set(["c"]) };
  const sel = resolveSelection(part, ctx, { subPart: "s", pointLocal: [0, 0, 0], normalLocal: [0, 0, 1] });
  expect(sel.params).toEqual({ c: 3 });
});
