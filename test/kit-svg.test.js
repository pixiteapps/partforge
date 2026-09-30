// The kit's SVG writer (export/svg.js), read back through a parser for exactly its own
// subset (test/helpers/svg-subset.js) so the assertions are physical: the sheet's size
// in mm, arc centres and radii after the y flip, per-layer paint, region areas. The
// existing SVG ingest round-trip is no substitute — it ignores mm sizes and outlines
// strokes (design spec D.6).
import { describe, expect, test } from "vitest";
import { renderSvg, SVG_COLORS, SVG_STROKE_MM } from "../src/framework/export/svg.js";
import { drawingBounds, LAYER_ORDER } from "../src/framework/export/drawing.js";
import { parseSvg, parsePathData, arcGeometry, ringArea } from "./helpers/svg-subset.js";

const closed = (start, segments) => ({ start, segments, closed: true });
const makeDrawing = (byId) => {
  const layers = LAYER_ORDER.filter((id) => byId[id]?.length).map((id) => ({ id, paths: byId[id] }));
  const bounds = drawingBounds(layers);
  return { layers, bounds, nominal: [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]], kerf: 0 };
};
// 40 × 30 plate with a CW r-5 hole at (20, 15), an engraved 4 mm square, a score line
const RECT = closed([0, 0], [{ to: [40, 0] }, { to: [40, 30] }, { to: [0, 30] }, { to: [0, 0] }]);
const HOLE = closed([25, 15], [{ to: [15, 15], via: [20, 10] }, { to: [25, 15], via: [20, 20] }]);
const plate = () => makeDrawing({
  engrave: [closed([10, 20], [{ to: [14, 20] }, { to: [14, 24] }, { to: [10, 24] }, { to: [10, 20] }])],
  score: [{ start: [5, 5], segments: [{ to: [35, 5] }], closed: false }],
  "cut-inner": [HOLE],
  "cut-outer": [RECT],
});
// a 270° CCW arc about (20, 20), r 10: centre → (30, 20) → arc round the top → (20, 10) → centre
const V = [20 + 10 * Math.cos((3 * Math.PI) / 4), 20 + 10 * Math.sin((3 * Math.PI) / 4)];
const pacman = () => makeDrawing({ "cut-outer": [closed([20, 20], [{ to: [30, 20] }, { to: [20, 10], via: V }, { to: [20, 20] }])] });
const sheet = (drawing, { size = [100, 50], at = [0, 0], rotated = false, title = "t" } = {}) =>
  ({ title, size, placements: [{ drawing, at, rotated }] });

test("the group order is drawing.js's cut order", () => {
  expect(Object.keys(SVG_COLORS)).toEqual(LAYER_ORDER);
  expect(SVG_COLORS).toEqual({ engrave: "#000000", score: "#0000FF", "cut-inner": "#FF0000", "cut-outer": "#FF0000" });
  expect(SVG_STROKE_MM).toBe(0.025);
});

describe("the document", () => {
  test("is sized in millimetres, 1 user unit = 1 mm", () => {
    const text = renderSvg(sheet(plate(), { size: [300, 200.5] }));
    expect(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg ')).toBe(true);
    expect(text.endsWith("</svg>\n")).toBe(true);
    expect(parseSvg(text).rootAttrs).toEqual({
      xmlns: "http://www.w3.org/2000/svg", version: "1.1", width: "300mm", height: "200.5mm", viewBox: "0 0 300 200.5",
    });
  });

  test("the only text is an escaped title, control characters dropped", () => {
    const text = renderSvg(sheet(plate(), { title: 'Box <"A&B\'s">\u0007 — sheet 1 of 2' }));
    expect(parseSvg(text).title).toBe("Box &lt;&quot;A&amp;B&apos;s&quot;&gt; — sheet 1 of 2");
  });

  test("groups carry only their id, in cut order; nothing is styled by inheritance", () => {
    const { groups } = parseSvg(renderSvg(sheet(plate())));
    expect(groups.map((g) => g.attrs)).toEqual(LAYER_ORDER.map((id) => ({ id })));
  });

  test("an empty layer writes no group", () => {
    const { groups } = parseSvg(renderSvg(sheet(pacman())));
    expect(groups.map((g) => g.attrs.id)).toEqual(["cut-outer"]);
  });
});

describe("paint", () => {
  test("every path is fully styled: cut and score unfilled hairlines, engrave filled even-odd with no stroke", () => {
    const { groups } = parseSvg(renderSvg(sheet(plate())));
    const attrs = Object.fromEntries(groups.map((g) => [g.attrs.id, g.paths.map(({ attrs: { d, ...rest } }) => rest)]));
    const line = (stroke) => ({ fill: "none", stroke, "stroke-width": "0.025" });
    expect(attrs).toEqual({
      engrave: [{ fill: "#000000", "fill-rule": "evenodd", stroke: "none" }],
      score: [line("#0000FF")],
      "cut-inner": [line("#FF0000")],
      "cut-outer": [line("#FF0000")],
    });
  });

  test("each placement's engrave rings share ONE path; line layers get one path per ring", () => {
    const d = plate();
    d.layers[0].paths.push(closed([20, 20], [{ to: [22, 20] }, { to: [22, 22] }, { to: [20, 22] }, { to: [20, 20] }]));
    const doc = { title: "t", size: [200, 50], placements: [{ drawing: d, at: [0, 0], rotated: false }, { drawing: d, at: [60, 0], rotated: false }] };
    const { groups } = parseSvg(renderSvg(doc));
    const byId = Object.fromEntries(groups.map((g) => [g.attrs.id, g.paths]));
    expect(byId.engrave).toHaveLength(2);
    expect(byId.engrave[0].subpaths).toHaveLength(2);
    expect(byId["cut-outer"]).toHaveLength(2);
  });
});

describe("geometry, read back and un-flipped", () => {
  test("an arc over 180° is written as quarter arcs that keep its centre, radius and sweep — sweep flag 0 for CCW", () => {
    const text = renderSvg(sheet(pacman(), { at: [5, 5] }));   // bounds.min (10, 10) lands on (5, 5)
    const svg = parseSvg(text);
    const sub = svg.groups[0].paths[0].subpaths[0];
    // line, three 90° pieces of the one 270° IR arc, line
    expect(sub.segs.map((s) => s.cmd)).toEqual(["L", "A", "A", "A", "L"]);
    let from = sub.segs[0].to, total = 0;
    for (const arc of sub.segs.slice(1, 4)) {
      expect(arc).toMatchObject({ cmd: "A", large: 0, sweep: 0 });
      const g = arcGeometry(from, arc, svg.height);
      expect(g.center[0]).toBeCloseTo(15, 4);
      expect(g.center[1]).toBeCloseTo(15, 4);
      expect(g.r).toBeCloseTo(10, 4);
      expect(g.dA).toBeCloseTo(Math.PI / 2, 4);
      total += g.dA;
      from = arc.to;
    }
    expect(total).toBeCloseTo((3 * Math.PI) / 2, 4);
    expect(ringArea(sub, svg.height)).toBeCloseTo(75 * Math.PI, 3);
  });

  test("a clockwise hole arc writes sweep flag 1 and reads back on its circle", () => {
    const svg = parseSvg(renderSvg(sheet(plate())));
    const sub = svg.groups.find((g) => g.attrs.id === "cut-inner").paths[0].subpaths[0];
    // two 180° IR arcs, each written as two quarters: no written arc is near 180°
    expect(sub.segs.map((s) => [s.large, s.sweep])).toEqual([[0, 1], [0, 1], [0, 1], [0, 1]]);
    let from = sub.start;
    for (const s of sub.segs) {
      const g = arcGeometry(from, s, svg.height);
      expect(g.center[0]).toBeCloseTo(20, 4); expect(g.center[1]).toBeCloseTo(15, 4); expect(g.r).toBeCloseTo(5, 4);
      expect(g.dA).toBeCloseTo(-Math.PI / 2, 4);
      from = s.to;
    }
  });

  test("a written arc never spans more than 90°, and a small one is written whole", () => {
    // 100° → two 50° pieces; 90° → one piece; the final end is the IR's own `to`.
    const arcAt = (deg) => {
      const t = (deg * Math.PI) / 180;
      return makeDrawing({ "cut-outer": [closed([0, 0], [{ to: [10, 0] },
        { to: [10 * Math.cos(t), 10 * Math.sin(t)], via: [10 * Math.cos(t / 2), 10 * Math.sin(t / 2)] }, { to: [0, 0] }])] });
    };
    for (const [deg, pieces] of [[100, 2], [90, 1], [45, 1], [359, 4]]) {
      const svg = parseSvg(renderSvg(sheet(arcAt(deg), { size: [30, 30], at: [10, 10] })));
      const segs = svg.groups[0].paths[0].subpaths[0].segs;
      expect(segs.filter((s) => s.cmd === "A"), `${deg}°`).toHaveLength(pieces);
    }
  });

  test("the cut region's area survives the flip: outline + hole = 40·30 − 25π", () => {
    const svg = parseSvg(renderSvg(sheet(plate())));
    const ring = (id) => svg.groups.find((g) => g.attrs.id === id).paths[0].subpaths[0];
    expect(ringArea(ring("cut-outer"), svg.height)).toBeCloseTo(1200, 6);
    expect(ringArea(ring("cut-outer"), svg.height) + ringArea(ring("cut-inner"), svg.height)).toBeCloseTo(1200 - 25 * Math.PI, 6);
  });

  test("a 90° turn keeps orientation and lands the piece at `at`", () => {
    const svg = parseSvg(renderSvg(sheet(makeDrawing({ "cut-outer": [RECT] }), { size: [100, 100], at: [10, 20], rotated: true })));
    const sub = svg.groups[0].paths[0].subpaths[0];
    const up = [sub.start, ...sub.segs.map((s) => s.to)].map(([x, y]) => [x, svg.height - y]);
    expect(Math.min(...up.map((p) => p[0]))).toBe(10);
    expect(Math.max(...up.map((p) => p[0]))).toBe(40);   // the 30 mm side now runs along x
    expect(Math.min(...up.map((p) => p[1]))).toBe(20);
    expect(Math.max(...up.map((p) => p[1]))).toBe(60);
    expect(ringArea(sub, svg.height)).toBeCloseTo(1200, 6);   // still CCW
  });

  test("cubics are written as C, open score lines have no Z, and numbers are 4-decimal with no -0", () => {
    const d = makeDrawing({
      engrave: [closed([0, 0], [{ to: [10, 0], c1: [0, 8], c2: [10, 8] }, { to: [0, 0] }])],
      score: [{ start: [0, 0.00001], segments: [{ to: [3.123456, 0] }], closed: false }],
    });
    const svg = parseSvg(renderSvg(sheet(d, { size: [20, 10] })));
    const byId = Object.fromEntries(svg.groups.map((g) => [g.attrs.id, g.paths[0]]));
    expect(byId.engrave.subpaths[0].segs[0].cmd).toBe("C");
    expect(byId.score.attrs.d).toBe("M0 10 L3.1235 10");
    expect(parsePathData(byId.score.attrs.d)[0].closed).toBe(false);
  });
});
