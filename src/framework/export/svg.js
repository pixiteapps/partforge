// The kit's SVG writer: a SheetDoc (placed Drawings on one sheet) → one SVG string,
// built by hand — paper.js cannot export SVG in a worker (there is no DOM to serialize
// through), and this module stays a paper-free leaf (arc-math.js only).
//
// Written for laser software, which reads styling far more literally than a browser:
//   - Size is physical: width/height in mm, viewBox in mm, so 1 user unit = 1 mm.
//   - y is flipped IN THE COORDINATES (svgY = H − y): the Drawing is y-up, SVG is y-down,
//     and a transform on the root is exactly the kind of inherited state a laser importer
//     may drop. The flip reverses every arc's sense, hence the sweep flag below.
//   - Every <path> carries its whole style. Nothing on the root or a group: inherited
//     style is where importers disagree. Cut and score paths carry fill="none" — an
//     unfilled SVG path defaults to BLACK FILL, which Glowforge reads as an engrave.
//   - Colours are LightBurn's convention (SVG_COLORS); groups are written in cut order.
//   - The only text is the escaped <title>. Escaping is hygiene, not the security
//     boundary: a hostile part shares the worker with this writer and can post its own
//     bytes — the host's download allowlist is the boundary (design spec E.1).
import { arcCenterAndSweep } from "../geometry/arc-math.js";

export const SVG_COLORS = Object.freeze({ engrave: "#000000", score: "#0000FF", "cut-inner": "#FF0000", "cut-outer": "#FF0000" });
export const SVG_STROKE_MM = 0.025;   // a hairline: laser software cuts it as a vector
// The group order is the cut order — the same list as drawing.js's LAYER_ORDER, which
// this leaf cannot import (drawing.js reaches paper); test/kit-svg.test.js pins them equal.
const ORDER = Object.keys(SVG_COLORS);

const num = (x) => { const v = Number(x.toFixed(4)); return String(v === 0 ? 0 : v); };   // -0 → "0"
const escapeXml = (s) => String(s)
  .replace(/[\u0000-\u001f\u007f]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

// Drawing frame → sheet frame for one placement: translate so the drawing's bounds.min
// lands on `at`, after an optional 90° CCW turn (a proper rotation: arcs keep their sense).
function placer({ drawing, at, rotated }) {
  const { min, max } = drawing.bounds;
  if (!rotated) return ([x, y]) => [x - min[0] + at[0], y - min[1] + at[1]];
  // (x, y) → (−y, x); the turned bounds' min corner is (−max.y, min.x)
  return ([x, y]) => [max[1] - y + at[0], x - min[0] + at[1]];
}

function pathData(path, place, H) {
  const P = (p) => { const [x, y] = place(p); return `${num(x)} ${num(H - y)}`; };
  let d = `M${P(path.start)}`;
  let from = path.start;
  for (const s of path.segments) {
    if (s.c1) d += ` C${P(s.c1)} ${P(s.c2)} ${P(s.to)}`;
    else if (s.via) {
      const g = arcCenterAndSweep(from, s.via, s.to);   // drawing frame: the turn keeps dA's sign
      d += g
        ? ` A${num(g.r)} ${num(g.r)} 0 ${Math.abs(g.dA) > Math.PI ? 1 : 0} ${g.dA > 0 ? 0 : 1} ${P(s.to)}`
        : ` L${P(s.to)}`;                                // collinear "arc": a straight line
    } else d += ` L${P(s.to)}`;
    from = s.to;
  }
  return path.closed ? `${d} Z` : d;
}

export function renderSvg(doc) {
  const [W, H] = doc.size;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${num(W)}mm" height="${num(H)}mm" viewBox="0 0 ${num(W)} ${num(H)}">`,
    `<title>${escapeXml(doc.title)}</title>`,
  ];
  for (const id of ORDER) {
    const paths = [];
    for (const placement of doc.placements) {
      const layer = placement.drawing.layers.find((l) => l.id === id);
      if (!layer || layer.paths.length === 0) continue;
      const place = placer(placement);
      if (id === "engrave") {
        // one filled path per piece: all its engrave rings, even-odd, so a glyph's
        // counter stays open whatever the rings' winding
        const d = layer.paths.map((p) => pathData(p, place, H)).join(" ");
        paths.push(`<path d="${d}" fill="${SVG_COLORS.engrave}" fill-rule="evenodd" stroke="none"/>`);
      } else {
        for (const p of layer.paths)
          paths.push(`<path d="${pathData(p, place, H)}" fill="none" stroke="${SVG_COLORS[id]}" stroke-width="${SVG_STROKE_MM}"/>`);
      }
    }
    if (paths.length) lines.push(`<g id="${id}">`, ...paths, "</g>");
  }
  lines.push("</svg>");
  return `${lines.join("\n")}\n`;
}
