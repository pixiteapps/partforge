import { expect, test } from "vitest";
import { bedLayout, bedWidthFor } from "../src/framework/export/bed-layout.js";

const box = (key, w, d, h = 5, at = [0, 0, 0]) => ({ key, min: at, max: [at[0] + w, at[1] + d, at[2] + h] });
const placed = (b, off) => ({ min: b.min.map((v, i) => v + off[i]), max: b.max.map((v, i) => v + off[i]) });
const overlapXY = (a, b) => a.min[0] < b.max[0] && b.min[0] < a.max[0] && a.min[1] < b.max[1] && b.min[1] < a.max[1];

test("pieces built at the same origin come out apart, on the bed, spacing apart", () => {
  const boxes = [box("body", 80, 60, 40), box("lid", 80, 60, 3), box("insert", 50, 30, 2)];
  const out = bedLayout(boxes, { width: 220 });
  const laid = boxes.map((b) => placed(b, out.get(b.key)));
  for (let i = 0; i < laid.length; i++) for (let j = i + 1; j < laid.length; j++) expect(overlapXY(laid[i], laid[j])).toBe(false);
  for (const l of laid) expect(l.min[2]).toBeCloseTo(0, 9);
  // Shelf order: tallest-in-Y first; first piece sits at the origin corner.
  const first = laid[boxes.findIndex((b) => b.key === "body")];
  expect(first.min[0]).toBeCloseTo(0, 9);
  expect(first.min[1]).toBeCloseTo(0, 9);
});

test("a lifted or offset piece is moved to rest at z = 0 at the origin corner", () => {
  const out = bedLayout([box("only", 10, 10, 4, [25, -7, 12])], { width: 220 });
  expect(out.get("only")).toEqual([-25, 7, -12]);
});

test("a shelf wraps at the width, and a piece wider than the width widens it", () => {
  const out = bedLayout([box("a", 150, 20), box("b", 150, 20)], { width: 220 });
  expect(out.get("b")[1]).toBeGreaterThanOrEqual(20 + 10 - 1e-9); // second shelf
  const wide = bedLayout([box("w", 300, 20), box("n", 10, 10)], { width: 220 });
  expect(wide.get("w")[0]).toBeCloseTo(0, 9);
});

test("deterministic: equal sizes order by key", () => {
  const a = bedLayout([box("b", 10, 10), box("a", 10, 10)], { width: 220 });
  expect(a.get("a")[0]).toBeLessThan(a.get("b")[0]);
});

test("bedWidthFor reads the process bed, else null", () => {
  expect(bedWidthFor({ verify: { process: "fdm-pla" } })).toBe(220);
  expect(bedWidthFor({ verify: { process: "resin" } })).toBe(120);
  expect(bedWidthFor({})).toBeNull();
  expect(bedWidthFor({ verify: { process: "no-such-process" } })).toBeNull();
});
