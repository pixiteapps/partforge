// The kit's R12 DXF writer (export/dxf.js), read back through a reader for exactly its
// own subset (test/helpers/dxf-subset.js): header and layers, POLYLINE bulge signs and
// areas, CIRCLE for a hole whatever its arc count, LINE for a score, cubic flattening
// (design spec D.7).
import { beforeAll, describe, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { renderDxf, DXF_LAYERS } from "../src/framework/export/dxf.js";
import { drawingBounds, refitRing, LAYER_ORDER } from "../src/framework/export/drawing.js";
import { parseDxf, polylineArea, bulgeArc } from "./helpers/dxf-subset.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const closed = (start, segments) => ({ start, segments, closed: true });
const makeDrawing = (byId) => {
  const layers = LAYER_ORDER.filter((id) => byId[id]?.length).map((id) => ({ id, paths: byId[id] }));
  const bounds = drawingBounds(layers);
  return { layers, bounds, nominal: [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]], kerf: 0 };
};
const RECT = closed([0, 0], [{ to: [40, 0] }, { to: [40, 30] }, { to: [0, 30] }, { to: [0, 0] }]);
const HOLE = closed([25, 15], [{ to: [15, 15], via: [20, 10] }, { to: [25, 15], via: [20, 20] }]);
const plate = () => makeDrawing({
  engrave: [closed([10, 20], [{ to: [14, 20] }, { to: [14, 24] }, { to: [10, 24] }, { to: [10, 20] }])],
  score: [{ start: [5, 5], segments: [{ to: [35, 5] }], closed: false }],
  "cut-inner": [HOLE],
  "cut-outer": [RECT],
});
const V = [20 + 10 * Math.cos((3 * Math.PI) / 4), 20 + 10 * Math.sin((3 * Math.PI) / 4)];
const pacman = () => makeDrawing({ "cut-outer": [closed([20, 20], [{ to: [30, 20] }, { to: [20, 10], via: V }, { to: [20, 20] }])] });
const piece = (drawing) => ({ title: "t", size: [drawing.bounds.max[0] - drawing.bounds.min[0], drawing.bounds.max[1] - drawing.bounds.min[1]], placements: [{ drawing, at: [0, 0], rotated: false }] });

test("the layer table and the entity order follow drawing.js's cut order", () => {
  expect(DXF_LAYERS).toEqual({ CUT: 1, SCORE: 5, ENGRAVE: 7 });
  const dxf = parseDxf(renderDxf(piece(plate())));
  expect(dxf.entities.map((e) => e.layer)).toEqual(["ENGRAVE", "SCORE", "CUT", "CUT"]);
  expect(LAYER_ORDER).toEqual(["engrave", "score", "cut-inner", "cut-outer"]);
});

describe("the file", () => {
  test("is R12 in millimetres with space-padded group codes, ending in EOF", () => {
    const text = renderDxf(piece(plate()));
    expect(text.startsWith("  0\nSECTION\n  2\nHEADER\n  9\n$ACADVER\n  1\nAC1009\n  9\n$INSUNITS\n 70\n4\n  0\nENDSEC\n")).toBe(true);
    expect(text.endsWith("  0\nEOF\n")).toBe(true);
    const dxf = parseDxf(text);
    expect(dxf.header).toEqual({ $ACADVER: "AC1009", $INSUNITS: "4" });
    expect(dxf.eof).toBe(true);
  });

  test("declares exactly the included layers, with their colours and CONTINUOUS", () => {
    expect(parseDxf(renderDxf(piece(plate()))).layers).toEqual([
      { name: "ENGRAVE", color: 7, linetype: "CONTINUOUS" },
      { name: "SCORE", color: 5, linetype: "CONTINUOUS" },
      { name: "CUT", color: 1, linetype: "CONTINUOUS" },
    ]);
    const cutOnly = parseDxf(renderDxf(piece(plate()), { include: ["cut"] }));
    expect(cutOnly.layers.map((l) => l.name)).toEqual(["CUT"]);
    expect(cutOnly.entities.every((e) => e.layer === "CUT")).toBe(true);
    const marks = parseDxf(renderDxf(piece(plate()), { include: ["score", "engrave"] }));
    expect(marks.entities.map((e) => e.layer)).toEqual(["ENGRAVE", "SCORE"]);
  });

  test("an unknown include is refused", () => {
    expect(() => renderDxf(piece(plate()), { include: ["cut", "mark"] }))
      .toThrow('renderDxf: include lists "cut", "score" and "engrave" only, got "mark"');
  });
});

describe("entities", () => {
  test("a closed ring is a closed POLYLINE: one vertex per corner, no repeated start", () => {
    const [, , , outline] = parseDxf(renderDxf(piece(plate()))).entities;
    expect(outline).toMatchObject({ type: "POLYLINE", layer: "CUT", closed: true });
    expect(outline.vertices.map((v) => v.at)).toEqual([[0, 0], [40, 0], [40, 30], [0, 30]]);
    expect(polylineArea(outline)).toBeCloseTo(1200, 9);
  });

  test("a two-point score is a LINE", () => {
    const score = parseDxf(renderDxf(piece(plate()))).entities[1];
    expect(score).toEqual({ type: "LINE", layer: "SCORE", a: [5, 5], b: [35, 5] });
  });

  test("the two-arc hole is a CIRCLE; outline minus circle is the region's area", () => {
    const [, , hole, outline] = parseDxf(renderDxf(piece(plate()))).entities;
    expect(hole).toEqual({ type: "CIRCLE", layer: "CUT", center: [20, 15], r: 5 });
    expect(polylineArea(outline) - Math.PI * hole.r ** 2).toBeCloseTo(1200 - 25 * Math.PI, 4);
  });

  test("a hole cut with cutAll comes back from recoverArcs as three arcs — still one CIRCLE", () => {
    const h = k.shape2d([[0, 0], [40, 0], [40, 30], [0, 30]])
      .cutAll([{ start: [25, 15], segments: [{ to: [15, 15], via: [20, 20] }, { to: [25, 15], via: [20, 10] }] }])
      .toContours()[0].holes[0];
    const ring = refitRing(h);
    expect(ring.segments.filter((s) => s.via)).toHaveLength(3);
    const dxf = parseDxf(renderDxf(piece(makeDrawing({ "cut-outer": [RECT], "cut-inner": [{ ...ring, closed: true }] }))));
    const circle = dxf.entities.find((e) => e.type === "CIRCLE");
    expect(circle.center[0]).toBeCloseTo(20, 6);
    expect(circle.center[1]).toBeCloseTo(15, 6);
    expect(circle.r).toBeCloseTo(5, 6);
  });

  test("an arc over 180° is one bulge > 1 on the vertex that starts it, and the area is exact", () => {
    const [poly] = parseDxf(renderDxf(piece(pacman()))).entities;
    expect(poly.vertices.map((v) => v.at)).toEqual([[10, 10], [20, 10], [10, 0]]);   // bounds.min (10, 10) → origin
    expect(poly.vertices.map((v) => v.bulge)).toEqual([0, expect.closeTo(Math.tan((3 * Math.PI) / 8), 8), 0]);
    const g = bulgeArc(poly.vertices[1].at, poly.vertices[2].at, poly.vertices[1].bulge);
    expect(g.center[0]).toBeCloseTo(10, 6);
    expect(g.center[1]).toBeCloseTo(10, 6);
    expect(g.r).toBeCloseTo(10, 6);
    expect(polylineArea(poly)).toBeCloseTo(75 * Math.PI, 4);
  });

  test("bulge signs follow the winding: CCW outline arcs positive, CW hole arcs negative; the closing segment's bulge sits on the last vertex", () => {
    // a D: a 20 × 10 box whose right end is a CCW half circle — and a CW slot hole
    const D = closed([0, 0], [{ to: [20, 0] }, { to: [20, 10], via: [25, 5] }, { to: [0, 10] }, { to: [0, 0] }]);
    const slot = closed([5, 3], [{ to: [5, 7], via: [3, 5] }, { to: [10, 7] }, { to: [10, 3], via: [12, 5] }, { to: [5, 3] }]);
    const closing = closed([0, 0], [{ to: [10, 0] }, { to: [10, 10] }, { to: [0, 10], via: [5, 15] }, { to: [0, 0], via: [-5, 5] }]);
    const [outer] = parseDxf(renderDxf(piece(makeDrawing({ "cut-outer": [D] })))).entities;
    expect(outer.vertices.map((v) => Math.sign(v.bulge))).toEqual([0, 1, 0, 0]);
    expect(polylineArea(outer)).toBeCloseTo(200 + 12.5 * Math.PI, 4);
    const [inner] = parseDxf(renderDxf(piece(makeDrawing({ "cut-outer": [RECT], "cut-inner": [slot] })), { include: ["cut"] })).entities;
    expect(inner.vertices.map((v) => Math.sign(v.bulge))).toEqual([-1, 0, -1, 0]);
    expect(polylineArea(inner)).toBeCloseTo(-(20 + 4 * Math.PI), 4);
    const [last] = parseDxf(renderDxf(piece(makeDrawing({ "cut-outer": [closing] })))).entities;
    expect(last.vertices).toHaveLength(4);
    expect(last.vertices[3].bulge).toBeCloseTo(Math.tan(Math.PI / 4), 8);   // (0,10)→(0,0) is a CCW half circle
  });

  test("a cubic is flattened to lines within 0.01 mm of the curve", () => {
    // (0,0) → (10,0) arching up to y = 6, then straight back: x(t) = 30t² − 20t³, y(t) = 24t(1 − t)
    const d = makeDrawing({ "cut-outer": [closed([0, 0], [{ to: [10, 0], c1: [0, 8], c2: [10, 8] }, { to: [0, 0] }])] });
    const [poly] = parseDxf(renderDxf(piece(d))).entities;
    expect(poly.vertices.every((v) => v.bulge === 0)).toBe(true);
    expect(poly.vertices.length).toBeGreaterThan(10);
    const curve = Array.from({ length: 20001 }, (_, i) => { const t = i / 20000; return [30 * t * t - 20 * t ** 3, 24 * t * (1 - t)]; });
    const toCurve = (p) => Math.min(...curve.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1])));
    const v = poly.vertices.map((x) => x.at);
    for (let i = 0; i + 1 < v.length; i++)   // every chord but the closing straight line
      expect(toCurve([(v[i][0] + v[i + 1][0]) / 2, (v[i][1] + v[i + 1][1]) / 2])).toBeLessThanOrEqual(0.011);
    expect(polylineArea(poly)).toBeCloseTo(-48, 0);   // clockwise; the curve bounds ∫y dx = 48
  });

  test("a rotated placement turns the piece 90° CCW and keeps bulge signs", () => {
    const doc = { title: "t", size: [100, 100], placements: [{ drawing: pacman(), at: [0, 0], rotated: true }] };
    const [poly] = parseDxf(renderDxf(doc)).entities;
    expect(Math.sign(poly.vertices[1].bulge)).toBe(1);
    expect(polylineArea(poly)).toBeCloseTo(75 * Math.PI, 4);
  });
});
