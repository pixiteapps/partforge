// @vitest-environment happy-dom
// The kit's SVG read back by a real SVG consumer: partforge's own ingest, i.e. paper.js's
// importSVG. It is the check test/kit-svg.test.js's hand-written reader cannot be — here
// someone else's arc code parses the > 180° arc and someone else's fill rules decide
// what is filled. A smoke test of the ENGRAVE layer only (design spec D.6): ingest
// ignores the mm size and would outline a stroke, so it runs with strokes: "ignore",
// which keeps exactly the filled paths — the engraving — and drops the cut hairline.
import { expect, test } from "vitest";
import { renderSvg } from "../src/framework/export/svg.js";
import { drawingBounds } from "../src/framework/export/drawing.js";
import { ingestSvg } from "../src/framework/ingest/svg-ingest.js";
import { toInternalDocument } from "../src/framework/geometry/vector-format.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea } from "../src/framework/geometry/shape2d-regions.js";

const closed = (start, segments) => ({ start, segments, closed: true });
// Engraved: a 270° CCW "pacman" about (20, 20), r 10, and a 20 × 10 frame whose 10 × 4
// window is wound the SAME way as its outline, so only even-odd makes it a window. Cut:
// the 70 × 40 outline around both, whose corner (0, 0) is the drawing's bounds.min.
const V = [20 + 10 * Math.cos((3 * Math.PI) / 4), 20 + 10 * Math.sin((3 * Math.PI) / 4)];
const layers = [
  { id: "engrave", paths: [
    closed([20, 20], [{ to: [30, 20] }, { to: [20, 10], via: V }, { to: [20, 20] }]),
    closed([40, 20], [{ to: [60, 20] }, { to: [60, 30] }, { to: [40, 30] }, { to: [40, 20] }]),
    closed([45, 23], [{ to: [55, 23] }, { to: [55, 27] }, { to: [45, 27] }, { to: [45, 23] }]),
  ] },
  { id: "cut-outer", paths: [closed([0, 0], [{ to: [70, 0] }, { to: [70, 40] }, { to: [0, 40] }, { to: [0, 0] }])] },
];
const drawing = { layers, bounds: drawingBounds(layers), nominal: [70, 40], kerf: 0 };
const H = 50;

test("paper.js reads the engraving back: the 270° arc, the even-odd window, and where the piece sits", () => {
  const text = renderSvg({ title: "t", size: [100, H], placements: [{ drawing, at: [5, 5], rotated: false }] });
  const doc = ingestSvg(text, { strokes: "ignore" });
  const regions = toInternalDocument(doc).shapes.get("artwork").regions;
  const area = (c) => ringArea(tessellateContour(c, 512));
  expect(regions).toHaveLength(2);
  const net = regions.map((r) => area(r.outer) + r.holes.reduce((a, h) => a + area(h), 0)).sort((a, b) => a - b);
  expect(net[0]).toBeCloseTo(20 * 10 - 10 * 4, 1);          // the frame minus its same-wound window
  expect(net[1]).toBeCloseTo(0.75 * Math.PI * 10 ** 2, 1);  // three quarters of an r-10 disc
  // ingest's y-up is −(SVG y), so H + y is back in the sheet frame. bounds.min (0, 0) sits
  // on `at` (5, 5), so the engraving's 10..60 × 10..30 box lands at 15..65 × 15..35.
  expect(doc.bbox.minX).toBeCloseTo(15, 2);
  expect(doc.bbox.maxX).toBeCloseTo(65, 2);
  expect(H + doc.bbox.minY).toBeCloseTo(15, 2);
  expect(H + doc.bbox.maxY).toBeCloseTo(35, 2);
});
