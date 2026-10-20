import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";
import { routedPart } from "../src/framework/sheet/routed.js";

const RECT = [[0, 0], [100, 0], [100, 60], [0, 60]];
const part = (drills) => ({
  meta: { title: "Plinth" },
  parameters: [{ id: "s", title: "Stock", controls: [{ key: "t", label: "Stock thickness", unit: "mm", min: 6, max: 30, step: 1 }] }],
  defaults: { t: 18 },
  views: { main: { label: "Main" } },
  parts: { plinth: routedPart({ views: ["main"], label: "Plinth", material: "walnut", thickness: (p) => p.t, profile: (k) => k.shape2d(RECT), drills }) },
});
// lintPart answers { ok, errors, warnings, notes }; every finding, whatever its tier.
const allFindings = (p) => { const r = lintPart(p); return [...r.errors, ...r.warnings, ...r.notes]; };
const findings = (p) => allFindings(p).filter((f) => f.rule === "routed-drill-depth");

test("a drill deeper than the stock at the defaults is an error carrying the routed doc id", () => {
  const [f] = findings(part(() => [{ at: [10, 10], d: 4, depth: 25, label: "peg" }]));
  expect(f).toMatchObject({ rule: "routed-drill-depth", severity: "error", pattern: "routed-parts", path: "parts.plinth.sheet.drills" });
  expect(f.message).toBe('sub-part "plinth": drill "peg" is 25 mm deep in 18 mm stock');
  expect(f.hint.length).toBeLessThan(500);
});

test("a through drill (depth == thickness) and a blind one are fine; a laser thickness warning never fires on a routed part", () => {
  const all = allFindings(part(() => [{ at: [10, 10], d: 4, depth: 18 }, { at: [20, 10], d: 4, depth: 9 }]));
  expect(all.filter((f) => f.rule === "routed-drill-depth")).toEqual([]);
  expect(all.filter((f) => f.rule === "laser-thickness-range")).toEqual([]);
});

test("a drills function that throws at the defaults is left to the build rules", () => {
  expect(findings(part(() => { throw new Error("boom"); }))).toEqual([]);
});
