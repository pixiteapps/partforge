// @vitest-environment happy-dom
import { expect, it, test } from "vitest";
import { readFileSync } from "node:fs";
import { ingestSvg } from "../src/framework/ingest/svg-ingest.js";
import { toInternalDocument } from "../src/framework/geometry/vector-format.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea } from "../src/framework/geometry/shape2d-regions.js";

const svg = (body, attrs = 'viewBox="0 0 48 48"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
// Ingest always emits a single shape named "artwork" — see fromInternalRegions's
// call in svg-ingest.js's last line.
const regionsOf = (doc, label) => toInternalDocument(doc, label).shapes.get("artwork").regions;
const netArea = (doc) => regionsOf(doc).reduce((a, r) =>
  a + Math.abs(ringArea(tessellateContour(r.outer, 256)))
    - r.holes.reduce((h, c) => h + Math.abs(ringArea(tessellateContour(c, 256))), 0), 0);

test("a filled rect ingests to a valid document with the right bbox and area", () => {
  const doc = ingestSvg(svg('<rect x="4" y="6" width="20" height="10" fill="#111"/>'), { source: "r.svg" });
  expect(doc.format).toBe("partforge-vector");
  expect(doc.source).toBe("r.svg");
  expect(doc.bbox.maxX - doc.bbox.minX).toBeCloseTo(20, 3);
  expect(doc.bbox.maxY - doc.bbox.minY).toBeCloseTo(10, 3);
  expect(netArea(doc)).toBeCloseTo(200, 1);
});

test("y is flipped from SVG's y-down to model y-up", () => {
  // a wide bar at SVG y=0 (the top) and a small square at SVG y=40 (the bottom)
  const doc = ingestSvg(svg('<rect x="0" y="0" width="40" height="4" fill="#111"/><rect x="0" y="40" width="4" height="4" fill="#111"/>'));
  const regions = regionsOf(doc);
  const widest = regions.map((r) => tessellateContour(r.outer, 8))
    .map((pts) => ({ w: Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0])),
                     top: Math.max(...pts.map((p) => p[1])) }))
    .sort((a, b) => b.w - a.w)[0];
  expect(widest.top).toBeCloseTo(doc.bbox.maxY, 3);   // the wide bar is the HIGH one
});

test("ancestor transforms are baked in", () => {
  const doc = ingestSvg(svg('<g transform="translate(2 0) scale(2)"><rect width="10" height="10" fill="#111"/></g>'));
  expect(doc.bbox.maxX - doc.bbox.minX).toBeCloseTo(20, 3);
  expect(doc.bbox.minX).toBeCloseTo(2, 3);
});

test("fill=none with a stroke yields the stroke outline only", () => {
  const doc = ingestSvg(svg('<path fill="none" stroke="#111" stroke-width="2" stroke-linecap="butt" d="M0,0 L10,0"/>'));
  expect(netArea(doc)).toBeCloseTo(20, 1);
});

test("strokes:'ignore' drops stroke geometry", () => {
  const body = '<rect width="10" height="10" fill="#111" stroke="#111" stroke-width="4"/>';
  expect(netArea(ingestSvg(svg(body), { strokes: "ignore" }))).toBeCloseTo(100, 1);
  expect(netArea(ingestSvg(svg(body)))).toBeGreaterThan(100);
});

test("evenodd makes a hole where nonzero does not", () => {
  const d = "M0,0 L30,0 L30,30 L0,30 Z M10,10 L20,10 L20,20 L10,20 Z";
  expect(netArea(ingestSvg(svg(`<path fill="#111" fill-rule="evenodd" d="${d}"/>`)))).toBeCloseTo(800, 1);
  expect(netArea(ingestSvg(svg(`<path fill="#111" fill-rule="nonzero" d="${d}"/>`)))).toBeCloseTo(900, 1);
});

test("overlapping filled shapes union rather than double-count", () => {
  const doc = ingestSvg(svg('<rect width="10" height="10" fill="#111"/><rect x="5" width="10" height="10" fill="#111"/>'));
  expect(netArea(doc)).toBeCloseTo(150, 1);
});

// The same two overlapping squares as the test above, but as two subpaths of
// ONE <path> element instead of two separate elements. Ingest calls
// resolveCurveFill per-ITEM to resolve an element's own subpaths under its fill
// rule; that used to drop the overlap between two same-winding subpaths and
// return area 100 / bbox width 10 (the first subpath alone). It now merges them,
// so both routes agree — which is the property that actually matters, since
// which one an artwork takes is an authoring accident, not a modelling choice.
test("overlapping same-winding subpaths within one <path> merge into their union", () => {
  const d = "M0,0 L10,0 L10,10 L0,10 Z M5,0 L15,0 L15,10 L5,10 Z";
  const doc = ingestSvg(svg(`<path fill="#111" d="${d}"/>`));
  expect(netArea(doc)).toBeCloseTo(150, 1);
  expect(doc.bbox.maxX - doc.bbox.minX).toBeCloseTo(15, 1);
});

// evenodd on the same geometry: the band both subpaths cover is crossed twice,
// so it drops out and two disjoint 5x10 bars remain. This threw before the fix —
// paper's XOR hands back the two bars with OPPOSITE orientations, and the
// grouper reads orientation to tell an outer from a hole, so it called the
// second one a hole with nothing to live in.
test("evenodd subpaths in one <path> cancel their overlap instead of throwing", () => {
  const d = "M0,0 L10,0 L10,10 L0,10 Z M5,0 L15,0 L15,10 L5,10 Z";
  const doc = ingestSvg(svg(`<path fill="#111" fill-rule="evenodd" d="${d}"/>`));
  expect(netArea(doc)).toBeCloseTo(100, 1);
  expect(doc.bbox.maxX - doc.bbox.minX).toBeCloseTo(15, 1);
});

test("a circle survives as symbolic arcs, not cubics", () => {
  const doc = ingestSvg(svg('<circle cx="24" cy="24" r="10" fill="#111"/>'));
  const [region] = regionsOf(doc);
  expect(region.outer.segments.every((s) => s.via)).toBe(true);
  expect(netArea(doc)).toBeCloseTo(Math.PI * 100, 0);
});

test("<use> and <defs> resolve — the capability this architecture bought (bare href)", () => {
  const doc = ingestSvg(svg(
    '<defs><rect id="r" width="10" height="10"/></defs>'
    + '<use href="#r" fill="#111"/><use href="#r" x="20" fill="#111"/>'));
  expect(netArea(doc)).toBeCloseTo(200, 1);
  expect(doc.bbox.maxX - doc.bbox.minX).toBeCloseTo(30, 1);
});

test("<use> and <defs> resolve with the legacy xlink:href spelling too", () => {
  const doc = ingestSvg(svg(
    '<defs><rect id="r" width="10" height="10"/></defs>'
    + '<use xlink:href="#r" fill="#111"/><use xlink:href="#r" x="20" fill="#111"/>',
    'viewBox="0 0 48 48" xmlns:xlink="http://www.w3.org/1999/xlink"'));
  expect(netArea(doc)).toBeCloseTo(200, 1);
  expect(doc.bbox.maxX - doc.bbox.minX).toBeCloseTo(30, 1);
});

test("<symbol> + <use> resolves", () => {
  const doc = ingestSvg(svg(
    '<symbol id="s"><rect width="10" height="10" fill="#111"/></symbol>'
    + '<use href="#s"/><use href="#s" x="20"/>'));
  expect(netArea(doc)).toBeCloseTo(200, 1);
  expect(doc.bbox.maxX - doc.bbox.minX).toBeCloseTo(30, 1);
});

test("a CSS class in a <style> block resolves", () => {
  const doc = ingestSvg(svg('<style>.a { fill: #111; }</style><rect class="a" width="10" height="10"/>'));
  expect(netArea(doc)).toBeCloseTo(100, 1);
});

test("an SVG with no painted geometry throws", () => {
  expect(() => ingestSvg(svg('<rect width="10" height="10" fill="none"/>'))).toThrow(/svg: /);
});

test("the emitted document always validates", () => {
  const doc = ingestSvg(svg('<circle cx="10" cy="10" r="5" fill="#111"/><path fill="none" stroke="#111" stroke-width="2" d="M0,30 L40,30"/>'));
  expect(() => toInternalDocument(doc, "x")).not.toThrow();
});

test("emitted regions carry the storage winding invariant: outer CCW, holes CW", () => {
  const signed = (c) => ringArea(tessellateContour(c, 64));

  const rect = regionsOf(ingestSvg(svg('<rect width="20" height="10" fill="#111"/>')));
  expect(signed(rect[0].outer)).toBeGreaterThan(0);

  const d = "M0,0 L30,0 L30,30 L0,30 Z M10,10 L20,10 L20,20 L10,20 Z";
  const [donut] = regionsOf(ingestSvg(svg(`<path fill="#111" fill-rule="evenodd" d="${d}"/>`)));
  expect(signed(donut.outer)).toBeGreaterThan(0);
  expect(signed(donut.holes[0])).toBeLessThan(0);
});

it("is deterministic: ingesting twice gives identical bytes", () => {
  const svg = readFileSync("src/parts/assets/emblem.svg", "utf8");
  const a = JSON.stringify(ingestSvg(svg, { source: "emblem.svg" }), null, 2);
  const b = JSON.stringify(ingestSvg(svg, { source: "emblem.svg" }), null, 2);
  expect(a).toBe(b);
});

it("reproduces the checked-in emblem fixture byte for byte", () => {
  const svg = readFileSync("src/parts/assets/emblem.svg", "utf8");
  const fresh = `${JSON.stringify(ingestSvg(svg, { source: "emblem.svg" }), null, 2)}\n`;
  expect(fresh).toBe(readFileSync("src/parts/assets/emblem.vector.json", "utf8"));
});

// Regression for the half-disc class: `toContour` drops the implicit closing
// chord, and arc recovery merges two quarter-arc cubics into ONE ≤180° arc, so
// the contour arrives with a single segment. validateVectorDocument used to
// require two and refused the file — ingest wrote it happily, and the first
// build that touched it died. Both halves are fixed: the rule now accepts a lone
// CURVED segment, and ingestSvg validates its own output before returning, so
// this can never silently ship again.
test("a filled half-disc round-trips: one arc plus the implicit chord is a valid contour", () => {
  const doc = ingestSvg(svg('<path fill="#111" d="M 4 24 A 10 10 0 0 1 24 24 Z"/>'));
  const [region] = doc.shapes.artwork;              // the emitted JSON, not the internal form
  expect(region.outer.segments).toHaveLength(1);
  expect(region.outer.segments[0].kind).toBe("arc");
  expect(netArea(doc)).toBeCloseTo(Math.PI * 100 / 2, 0);
});

test("the reversed-sweep half-disc round-trips too", () => {
  const doc = ingestSvg(svg('<path fill="#111" d="M 24 24 A 10 10 0 0 1 4 24 Z"/>'));
  expect(regionsOf(doc)[0].outer.segments).toHaveLength(1);
  expect(netArea(doc)).toBeCloseTo(Math.PI * 100 / 2, 0);
});

test("a half-disc written as two 90-degree A commands round-trips", () => {
  const doc = ingestSvg(svg('<path fill="#111" d="M 4 24 A 10 10 0 0 1 14 14 A 10 10 0 0 1 24 24 Z"/>'));
  expect(netArea(doc)).toBeCloseTo(Math.PI * 100 / 2, 0);
});

// A sine-wave edge drawn as one cubic per quarter period: a run of whole periods has its
// first, middle and last points on one line to float noise, and arc recovery used to fit
// it a circle of radius about 1e17 and store the whole wave as ONE arc — a straight chord
// in the document. It is not a circle, and it stays the cubics it was drawn with.
test("a wavy edge stays cubics: no arc runs across the wave", () => {
  const k2 = (2 * Math.PI) / 25, y = (x) => 30 + 3 * Math.sin(k2 * (x - 5)), dy = (x) => 3 * k2 * Math.cos(k2 * (x - 5));
  let d = "M 0 0 L 110 0 L 110 30 L 105 30";
  for (let i = 16; i > 0; i--) {
    const a = 5 + i * 6.25, b = a - 6.25, h3 = (b - a) / 3;
    d += ` C ${a + h3} ${y(a) + dy(a) * h3} ${b - h3} ${y(b) - dy(b) * h3} ${b} ${y(b)}`;
  }
  const doc = ingestSvg(svg(`<path fill="#111" d="${d} L 0 30 Z"/>`, 'viewBox="0 0 110 40"'));
  const [region] = regionsOf(doc);
  expect(region.outer.segments.filter((s) => s.via)).toEqual([]);
  expect(region.outer.segments.filter((s) => s.c1).length).toBeGreaterThanOrEqual(16);
  expect(netArea(doc)).toBeCloseTo(110 * 30, 0);
});
