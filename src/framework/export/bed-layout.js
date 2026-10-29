// Where a multi-piece 3MF or STEP puts each views-map piece. Those formats write every
// selected piece into one file, and a views-map piece exports AS BUILT — at its own
// origin — so without a layout every piece would sit on top of the others
// (spec 2026-10-04 "Export layout"). Translation only: orientation, layer lines and
// the per-piece STL are untouched. Deterministic first-fit-decreasing-height shelves
// over each piece's XY bounding box — the cut kit's packer (layout.js) without
// rotation, sheets or margins — `spacing` apart, every piece resting at z = 0.
// Legacy (array views + place) pieces never come here: their author placed them.
import { resolveProfile } from "../oracle/dfm-profiles.js";
import { formOf } from "../sub-part-views.js";
import { isSheetPart } from "../sheet/constants.js";

const EPS = 1e-9;
export const BED_SPACING = 10;
export const DEFAULT_BED_WIDTH = 220;
const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

export function bedLayout(boxes, { width, spacing = BED_SPACING } = {}) {
  const items = boxes.map((b) => ({ ...b, w: b.max[0] - b.min[0], h: b.max[1] - b.min[1] }));
  const W = Math.max(width ?? DEFAULT_BED_WIDTH, ...items.map((it) => it.w));
  const order = [...items].sort((a, b) => b.h - a.h || b.w - a.w || byKey(a, b));
  const shelves = []; // { y, h, x: used width, n: pieces }
  const out = new Map();
  for (const it of order) {
    let shelf = shelves.find((s) => (s.n ? s.x + spacing : 0) + it.w <= W + EPS);
    if (!shelf) {
      const last = shelves.at(-1);
      shelf = { y: last ? last.y + last.h + spacing : 0, h: it.h, x: 0, n: 0 };
      shelves.push(shelf);
    }
    const x = shelf.n ? shelf.x + spacing : 0;
    out.set(it.key, [x - it.min[0], shelf.y - it.min[1], -it.min[2]]);
    shelf.x = x + it.w;
    shelf.n++;
  }
  return out;
}

export function bedWidthFor(part) {
  const process = part?.verify?.process;
  if (!process) return null;
  try {
    const bed = resolveProfile(process)?.bed;
    return Array.isArray(bed) && Number.isFinite(bed[0]) ? bed[0] : null;
  } catch {
    return null;
  }
}

// Map-form pieces are laid out together; legacy ones keep their export pose, and so do
// sheet pieces — a sheet's pose IS its placement, so sheet exports come out assembled.
export function laidOutOnBed(part, name) {
  const sp = part.parts[name];
  return formOf(sp) === "map" && !isSheetPart(sp);
}

// `boxes`: [{ name, box }] for the laid-out pieces, in export order → Map(name → offset).
// Bounds alone are enough, which is what lets the 3MF export free each piece as soon as
// it is meshed and shift the mesh afterwards (feedback #212).
export function exportLayoutOffsets(part, boxes) {
  if (boxes.length === 0) return new Map();
  return bedLayout(boxes.map(({ name, box }) => ({ key: name, ...box })), { width: bedWidthFor(part) });
}

// `pieces`: [{ name, solid, ...rest }] in export order. Returns a new array, same order,
// laid-out pieces translated (see laidOutOnBed).
export function layoutExportPieces(part, pieces) {
  const mapPieces = pieces.filter(({ name }) => laidOutOnBed(part, name));
  if (mapPieces.length === 0) return pieces;
  const offsets = exportLayoutOffsets(part, mapPieces.map(({ name, solid }) => ({ name, box: solid.boundingBox() })));
  return pieces.map((pc) => (offsets.has(pc.name) ? { ...pc, solid: pc.solid.translate(offsets.get(pc.name)) } : pc));
}
