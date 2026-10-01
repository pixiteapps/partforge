// The kit's DXF writer: a SheetDoc → one AutoCAD R12 (AC1009) DXF string, the dialect
// every cutting service and laser package reads. A paper-free leaf (arc-math.js only).
//
// R12 has LINE, CIRCLE and the old two-part POLYLINE / VERTEX / SEQEND; it has no
// LWPOLYLINE, no SPLINE and no HATCH, which fixes the whole mapping:
//   - A closed ring is a closed POLYLINE. Its arcs ride as BULGES, tan(θ/4) with θ the
//     signed sweep (positive = CCW), stored on the vertex that STARTS the segment — so
//     the vertices are the start plus every segment's `to` except the last (which is
//     the start again), and the closing segment's bulge sits on the final vertex.
//   - A ring whose segments are ALL arcs on one centre and radius (relative 1e-6),
//     sweeping ±360° in total, is a CIRCLE, whatever the arc count: recoverArcs hands a
//     hole cut with cutAll back as three arcs, and a service quotes a CIRCLE as a hole.
//   - A two-point open path (a score line) is a LINE.
//   - A cubic is flattened to lines within FLATTEN_MM of the curve.
//   - ENGRAVE carries outlines only (no HATCH in R12); the README says to set it to fill.
// Units are mm ($INSUNITS 4 — an R12 reader may ignore it, which is why the README
// prints a scale check per piece); y is NOT flipped, DXF is y-up like the Drawing.
import { arcCenterAndSweep } from "../geometry/arc-math.js";
import { placer } from "./placement.js";

export const DXF_LAYERS = Object.freeze({ CUT: 1, SCORE: 5, ENGRAVE: 7 });   // layer → ACI colour
const LAYER_FOR = Object.freeze({ engrave: "ENGRAVE", score: "SCORE", "cut-inner": "CUT", "cut-outer": "CUT" });
const INCLUDE_FOR = Object.freeze({ engrave: "engrave", score: "score", "cut-inner": "cut", "cut-outer": "cut" });
// The entity order is the cut order — drawing.js's LAYER_ORDER, which this leaf cannot
// import (drawing.js reaches paper); test/kit-dxf.test.js pins them equal.
const ORDER = Object.keys(LAYER_FOR);
const INCLUDES = ["cut", "score", "engrave"];
const TAU = 2 * Math.PI;
const FLATTEN_MM = 0.01;
const CIRCLE_REL = 1e-6;

// DXF reals: fixed precision, -0 → 0, and always a decimal point (a bare "5" is legal,
// but a strict reader of real-valued group codes may want "5.0").
const fixed = (x, digits) => { const v = Number(x.toFixed(digits)); const s = String(v === 0 ? 0 : v); return s.includes(".") ? s : `${s}.0`; };
const coord = (x) => fixed(x, 6);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Distance from q to the SEGMENT a–b (not the infinite line: a cubic that overshoots an
// endpoint is not flat).
function segDist(q, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  const t = L2 < 1e-24 ? 0 : Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2));
  return Math.hypot(q[0] - (a[0] + t * dx), q[1] - (a[1] + t * dy));
}

// Points p1…pN (excluding p0) of a polyline within FLATTEN_MM of the cubic. The curve
// lies inside its control polygon's convex hull, so it is within max(segDist(c1),
// segDist(c2)) of the chord; split at t = ½ until that is small enough.
function flattenCubic(p0, c1, c2, p1, depth = 0, out = []) {
  if (depth >= 16 || Math.max(segDist(c1, p0, p1), segDist(c2, p0, p1)) <= FLATTEN_MM) { out.push(p1); return out; }
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const a = mid(p0, c1), b = mid(c1, c2), c = mid(c2, p1), d = mid(a, b), e = mid(b, c), m = mid(d, e);
  flattenCubic(p0, a, d, m, depth + 1, out);
  flattenCubic(m, e, c, p1, depth + 1, out);
  return out;
}

// A path's segments as lines and arcs in its drawing frame: { to, dA } (dA 0 = a line),
// arcs also carrying their centre and radius.
function primitives(path) {
  const out = [];
  let from = path.start;
  for (const s of path.segments) {
    if (s.c1) for (const q of flattenCubic(from, s.c1, s.c2, s.to)) out.push({ to: q, dA: 0 });
    else if (s.via) {
      const g = arcCenterAndSweep(from, s.via, s.to);
      out.push(g ? { to: s.to, dA: g.dA, center: g.center, r: g.r } : { to: s.to, dA: 0 });
    } else out.push({ to: s.to, dA: 0 });
    from = s.to;
  }
  return out;
}

function asCircle(prims) {
  if (prims.length === 0 || prims.some((p) => !p.center)) return null;
  const { center, r, dA } = prims[0];
  const tol = CIRCLE_REL * r;
  let sweep = 0;
  for (const p of prims) {
    if (Math.abs(p.r - r) > tol || dist(p.center, center) > tol || Math.sign(p.dA) !== Math.sign(dA)) return null;
    sweep += p.dA;
  }
  return Math.abs(Math.abs(sweep) - TAU) <= 1e-6 ? { center, r } : null;
}

function writeEntity(g, layer, path, place) {
  const prims = primitives(path);
  if (!path.closed && prims.length === 1 && prims[0].dA === 0) {
    const [x1, y1] = place(path.start), [x2, y2] = place(prims[0].to);
    g(0, "LINE"); g(8, layer);
    g(10, coord(x1)); g(20, coord(y1)); g(30, "0.0");
    g(11, coord(x2)); g(21, coord(y2)); g(31, "0.0");
    return;
  }
  const circle = path.closed ? asCircle(prims) : null;
  if (circle) {
    const [cx, cy] = place(circle.center);
    g(0, "CIRCLE"); g(8, layer); g(10, coord(cx)); g(20, coord(cy)); g(30, "0.0"); g(40, coord(circle.r));
    return;
  }
  const verts = [path.start, ...prims.map((p) => p.to)];
  if (path.closed) verts.pop();                    // the last `to` is the start again
  g(0, "POLYLINE"); g(8, layer); g(66, 1); g(10, "0.0"); g(20, "0.0"); g(30, "0.0"); g(70, path.closed ? 1 : 0);
  verts.forEach((v, i) => {
    const [x, y] = place(v);
    g(0, "VERTEX"); g(8, layer); g(10, coord(x)); g(20, coord(y)); g(30, "0.0");
    const dA = prims[i]?.dA ?? 0;                  // the segment this vertex starts (none after an open end)
    if (dA !== 0) g(42, fixed(Math.tan(dA / 4), 10));
  });
  g(0, "SEQEND"); g(8, layer);
}

// `include` picks the layers: a cutting service gets one cut-only file per piece and a
// separate marks file (["score", "engrave"]). Only the included layers are declared.
export function renderDxf(doc, { include = INCLUDES } = {}) {
  for (const inc of include)
    if (!INCLUDES.includes(inc)) throw new Error(`renderDxf: include lists "cut", "score" and "engrave" only, got ${JSON.stringify(inc)}`);
  const want = new Set(include);
  const ids = ORDER.filter((id) => want.has(INCLUDE_FOR[id]));
  const names = [...new Set(ids.map((id) => LAYER_FOR[id]))];
  const out = [];
  const g = (code, value) => { out.push(String(code).padStart(3), String(value)); };

  g(0, "SECTION"); g(2, "HEADER");
  g(9, "$ACADVER"); g(1, "AC1009");
  g(9, "$INSUNITS"); g(70, 4);
  g(0, "ENDSEC");

  g(0, "SECTION"); g(2, "TABLES");
  g(0, "TABLE"); g(2, "LTYPE"); g(70, 1);
  g(0, "LTYPE"); g(2, "CONTINUOUS"); g(70, 0); g(3, "Solid line"); g(72, 65); g(73, 0); g(40, "0.0");
  g(0, "ENDTAB");
  g(0, "TABLE"); g(2, "LAYER"); g(70, names.length);
  for (const name of names) { g(0, "LAYER"); g(2, name); g(70, 0); g(62, DXF_LAYERS[name]); g(6, "CONTINUOUS"); }
  g(0, "ENDTAB");
  g(0, "ENDSEC");

  g(0, "SECTION"); g(2, "ENTITIES");
  for (const id of ids) {
    for (const placement of doc.placements) {
      const layer = placement.drawing.layers.find((l) => l.id === id);
      if (!layer) continue;
      const place = placer(placement);
      for (const path of layer.paths) writeEntity(g, LAYER_FOR[id], path, place);
    }
  }
  g(0, "ENDSEC");
  g(0, "EOF");
  return `${out.join("\n")}\n`;
}
