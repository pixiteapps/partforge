// The kit's sheet layout: one stock group's pieces packed onto sheets of one stock size.
// Deterministic first-fit decreasing-height SHELVES over each piece's bounding box of ALL
// its layers, kerf included — a stray engrave or score mark must never land on a
// neighbour — turned 0° or 90°, `margin` in from every sheet edge and `spacing` apart,
// so no two pieces share a cut line. v1 packs rectangles only: no nesting into holes,
// grain ignored; the README says so (design spec D.5).
//
// Coordinates are the sheet frame: mm, y up, origin at the sheet's corner. A placement's
// `at` is where the (turned) drawing's bounds.min lands (contract §5.6).
import { fmtMm } from "../sheet/constants.js";
import { KIT_OPTIONS_ERROR } from "./formats.js";

const EPS = 1e-9;
const sizeOf = ({ min, max }) => [max[0] - min[0], max[1] - min[1]];
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// `pieces`: [{ key, label, drawing, qty }] — `key` names the piece in `oversized` and
// breaks sort ties; `label` is what an error quotes. The `label` argument is the group's
// `${material} ${fmtMm(t)} mm`; `group` is accepted and not needed here. `strict` (own
// laser): a piece that fits the sheet in neither orientation is an options error;
// otherwise (a cutting service, whose sheets are reference only) its key is listed in
// `oversized` and it is left out. The sheets-per-group cap belongs to the caller — this
// only packs.
export function layoutGroup({ label, pieces, stock, margin, spacing, strict }) {
  const [W, H] = stock;
  const innerW = W - 2 * margin, innerH = H - 2 * margin;
  const items = [];
  const oversized = [];
  for (const pc of pieces) {
    const [w, h] = sizeOf(pc.drawing.bounds);
    const fits = [];
    if (w <= innerW + EPS && h <= innerH + EPS) fits.push({ rotated: false, w, h });
    if (h <= innerW + EPS && w <= innerH + EPS) fits.push({ rotated: true, w: h, h: w });
    if (fits.length === 0) {
      if (strict)
        throw new Error(`${KIT_OPTIONS_ERROR} stock too small — "${pc.label}" is ${w.toFixed(1)} × ${h.toFixed(1)} mm; a ${fmtMm(W)} × ${fmtMm(H)} mm sheet leaves ${fmtMm(innerW)} × ${fmtMm(innerH)} after its ${fmtMm(margin)} mm margin (${label})`);
      oversized.push(pc.key);
      continue;
    }
    // The orientation with the smaller height packs shelves tighter; 0° wins a tie.
    const pick = fits.length === 2 && fits[1].h < fits[0].h - EPS ? fits[1] : fits[0];
    for (let i = 0; i < pc.qty; i++) items.push({ key: pc.key, drawing: pc.drawing, ...pick });
  }
  items.sort((a, b) => b.h - a.h || b.w - a.w || byKey(a.key, b.key));

  // Each sheet: shelves bottom-up ({ y, h, x: used width, n: pieces }), `top` = the last
  // shelf's upper edge, `area` = placed bounding-box area.
  const sheets = [];
  const place = (sh, shelf, it) => {
    const x = shelf.n ? shelf.x + spacing : 0;
    sh.placements.push({ drawing: it.drawing, at: [margin + x, margin + shelf.y], rotated: it.rotated });
    shelf.x = x + it.w; shelf.n++; sh.area += it.w * it.h;
  };
  for (const it of items) {
    // 1. the first shelf, on any sheet, with room left along it
    const onShelf = (() => {
      for (const sh of sheets) for (const shelf of sh.shelves) {
        const x = shelf.n ? shelf.x + spacing : 0;
        if (x + it.w <= innerW + EPS && it.h <= shelf.h + EPS) return [sh, shelf];
      }
      return null;
    })();
    if (onShelf) { place(onShelf[0], onShelf[1], it); continue; }
    // 2. a new shelf on the first sheet with height left; 3. else a new sheet
    let sh = sheets.find((s) => s.top + spacing + it.h <= innerH + EPS);
    if (!sh) { sh = { placements: [], shelves: [], top: -spacing, area: 0 }; sheets.push(sh); }
    const shelf = { y: sh.top + spacing, h: it.h, x: 0, n: 0 };
    sh.shelves.push(shelf);
    sh.top = shelf.y + it.h;
    place(sh, shelf, it);
  }
  return {
    sheets: sheets.map((sh) => ({ placements: sh.placements, used: (100 * sh.area) / (W * H) })),
    oversized,
  };
}
