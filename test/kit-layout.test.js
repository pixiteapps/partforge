// The kit's sheet layout (export/layout.js): deterministic shelves over each piece's
// all-layer bounding box, never overlapping, inside the margin, a turn only when it
// packs better or is the only way in, and the two destinations' opposite answers to a
// piece that does not fit (design spec D.5).
import { describe, expect, test } from "vitest";
import { layoutGroup } from "../src/framework/export/layout.js";
import { drawingBounds } from "../src/framework/export/drawing.js";

// A w × h rectangle drawing; `mark` adds a score line running `mark` mm past both side
// edges, so the all-layer box is wider than the cut.
const rect = (w, h, { mark = 0 } = {}) => {
  const layers = [];
  if (mark) layers.push({ id: "score", paths: [{ start: [-mark, h / 2], segments: [{ to: [w + mark, h / 2] }], closed: false }] });
  layers.push({ id: "cut-outer", paths: [{ start: [0, 0], segments: [{ to: [w, 0] }, { to: [w, h] }, { to: [0, h] }, { to: [0, 0] }], closed: true }] });
  return { layers, bounds: drawingBounds(layers), nominal: [w, h], kerf: 0 };
};
const piece = (key, drawing, qty = 1) => ({ key, label: key.toUpperCase(), drawing, qty });
const lay = (pieces, { stock = [300, 300], margin = 5, spacing = 3, strict = true } = {}) =>
  layoutGroup({ group: "birch plywood|3.00", label: "birch plywood 3 mm", pieces, stock, margin, spacing, strict });
// a placement's footprint on its sheet
const box = ({ drawing, at, rotated }) => {
  const w = drawing.bounds.max[0] - drawing.bounds.min[0], h = drawing.bounds.max[1] - drawing.bounds.min[1];
  const [bw, bh] = rotated ? [h, w] : [w, h];
  return { x0: at[0], y0: at[1], x1: at[0] + bw, y1: at[1] + bh };
};
const expectPacked = (sheets, { stock = [300, 300], margin = 5, spacing = 3 } = {}) => {
  for (const { placements } of sheets) {
    const boxes = placements.map(box);
    for (const b of boxes) {
      expect(b.x0).toBeGreaterThanOrEqual(margin - 1e-9); expect(b.y0).toBeGreaterThanOrEqual(margin - 1e-9);
      expect(b.x1).toBeLessThanOrEqual(stock[0] - margin + 1e-9); expect(b.y1).toBeLessThanOrEqual(stock[1] - margin + 1e-9);
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const apart = a.x1 + spacing <= b.x0 + 1e-9 || b.x1 + spacing <= a.x0 + 1e-9
        || a.y1 + spacing <= b.y0 + 1e-9 || b.y1 + spacing <= a.y0 + 1e-9;
      expect(apart, `pieces ${i} and ${j} are closer than the spacing`).toBe(true);
    }
  }
};

describe("packing", () => {
  test("quantities expand, shelves fill left to right then upward, sheets overflow, and used is the bbox share", () => {
    const { sheets, oversized } = lay([piece("plate", rect(100, 100), 10)]);
    expect(oversized).toEqual([]);
    expect(sheets.map((s) => s.placements.length)).toEqual([4, 4, 2]);   // 2 per 290 mm shelf, 2 shelves per sheet
    expect(sheets[0].placements.map((p) => p.at)).toEqual([[5, 5], [108, 5], [5, 108], [108, 108]]);
    expect(sheets[0].used).toBeCloseTo((100 * 4 * 100 * 100) / (300 * 300), 9);
    expectPacked(sheets);
  });

  test("taller pieces go first, and a short piece fills a gap on an earlier shelf", () => {
    const { sheets } = lay([piece("small", rect(50, 20)), piece("tall", rect(200, 150))]);
    expect(sheets).toHaveLength(1);
    const [first, second] = sheets[0].placements;
    expect(first.drawing.bounds.max[1]).toBe(150);
    expect(second.at).toEqual([5 + 200 + 3, 5]);   // beside the tall piece on the same shelf
    expectPacked(sheets);
  });

  test("the box is every layer's, not just the cut's", () => {
    const d = rect(50, 50, { mark: 5 });             // 60 mm wide with its score line
    const { sheets } = lay([piece("marked", d, 5)], { stock: [200, 200] });
    expect(sheets[0].placements.map((p) => p.at[0])).toEqual([5, 68, 131, 5, 68]);   // 60 + 3 apart (the cut alone would give 5, 58, 111)
    expectPacked(sheets, { stock: [200, 200] });
  });

  test("the orientation with the smaller height wins; 0° wins a tie", () => {
    const { sheets } = lay([piece("tall", rect(20, 80)), piece("wide", rect(80, 20)), piece("square", rect(30, 30))]);
    const byH = Object.fromEntries(sheets[0].placements.map((p) => [p.drawing.bounds.max[0] + "x" + p.drawing.bounds.max[1], p.rotated]));
    expect(byH).toEqual({ "20x80": true, "80x20": false, "30x30": false });
  });

  test("a piece that fits only when turned is turned", () => {
    const { sheets } = lay([piece("long", rect(200, 50))], { stock: [100, 300] });
    expect(sheets[0].placements[0].rotated).toBe(true);
    expectPacked(sheets, { stock: [100, 300] });
  });

  test("the same pieces in any order lay out identically", () => {
    const pieces = [piece("a", rect(40, 70), 3), piece("b", rect(90, 30), 2), piece("c", rect(60, 60), 4), piece("d", rect(30, 30), 5)];
    const one = lay(pieces), two = lay([...pieces].reverse());
    expect(two).toEqual(one);
    expectPacked(one.sheets);
  });
});

describe("a piece bigger than the sheet", () => {
  test("own laser: an options error that says how big both are", () => {
    expect(() => lay([piece("front", rect(120, 50))], { stock: [100, 100] }))
      .toThrow('cut kit options: stock too small — "FRONT" is 120.0 × 50.0 mm; a 100 × 100 mm sheet leaves 90 × 90 after its 5 mm margin (birch plywood 3 mm)');
  });

  test("a cutting service: listed by key and left out, the rest still laid out", () => {
    const { sheets, oversized } = lay([piece("base", rect(400, 250)), piece("side", rect(80, 80), 2)], { strict: false });
    expect(oversized).toEqual(["base"]);
    expect(sheets).toHaveLength(1);
    expect(sheets[0].placements).toHaveLength(2);
  });

  test("everything oversized for a service: no sheets at all", () => {
    expect(lay([piece("base", rect(400, 250))], { strict: false })).toEqual({ sheets: [], oversized: ["base"] });
  });
});

describe("a margin that leaves no room", () => {
  // KIT_LIMITS allows a 50 mm margin and a 10 mm stock side, and nothing else stops the
  // two meeting: the sheet would have a negative inside.
  test.each([true, false])("strict %s: an options error about the margin, for either destination", (strict) => {
    expect(() => lay([piece("a", rect(5, 5))], { stock: [10, 10], margin: 50, strict }))
      .toThrow("cut kit options: a 10 × 10 mm sheet has no room inside a 50 mm margin on every side (birch plywood 3 mm) — lower margin or use larger stock");
    expect(() => lay([piece("a", rect(5, 5))], { stock: [300, 100], margin: 50, strict }))
      .toThrow("cut kit options: a 300 × 100 mm sheet has no room inside a 50 mm margin on every side (birch plywood 3 mm) — lower margin or use larger stock");
  });
});
