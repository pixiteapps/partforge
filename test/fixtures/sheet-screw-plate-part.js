// A mounting plate: 200 × 120 mm of 3 mm plywood with sixteen M3 clearance holes
// (3.4 mm) cut with cutAll — booleaned, so each hole is four cubics, the offset
// engine's slowest shape to shrink and regrow. The laser checks read a round hole's
// width directly (process/laser/descriptor.js narrowestGap), so this plate is read in
// full well inside the budget. Used by scripts/time-sheet-inspect.mjs.
import { sheetPart, sheetHole } from "partforge/geometry";

const HOLES = [];
for (let i = 0; i < 8; i++) for (const y of [10, 110]) HOLES.push(sheetHole({ d: 3.4, at: [15 + i * 24, y] }));

export default {
  meta: { title: "Screw mounting plate", units: "mm" },
  parameters: [
    { id: "stock", title: "Stock", description: "Measure your sheet.", controls: [
      { key: "t", label: "Sheet thickness", unit: "mm", min: 2, max: 6.5, step: 0.05, description: "Measured." },
    ] },
  ],
  defaults: { t: 3 },
  parts: {
    plate: sheetPart({
      views: ["panel"], label: "Plate", display: { material: "oak" }, material: "birch plywood", thickness: (p) => p.t,
      profile: (k) => k.shape2d([[0, 0], [200, 0], [200, 120], [0, 120]]).cutAll(HOLES),
    }),
  },
  views: { panel: { label: "Panel" } },
};
