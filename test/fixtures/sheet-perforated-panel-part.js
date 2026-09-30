// A speaker-grille panel: 900 3 mm perforations at a 5 mm pitch in 3 mm plywood — the
// laser checks' worst ordinary case (sheet parts spec C.6). Every web between holes is
// 2 mm, and a single shrink-and-regrow of this profile merges hundreds of rings: one
// such test took 14 s. No hole is far enough from its neighbours to be left out of the
// width search, and the checks price that first test past their whole budget
// (process/laser/descriptor.js), so they withhold it — `evaluated: false`, one
// sheetChecks warning — without spending that.
// Used by scripts/time-sheet-inspect.mjs.
import { sheetPart, sheetHole } from "partforge/geometry";

const N = 30, PITCH = 5, SIZE = N * PITCH + 10;
const holes = [];
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) holes.push(sheetHole({ d: 3, at: [5 + i * PITCH, 5 + j * PITCH] }));

export default {
  meta: { title: "Perforated grille panel", units: "mm" },
  parameters: [
    { id: "stock", title: "Stock", description: "Measure your sheet.", controls: [
      { key: "t", label: "Sheet thickness", unit: "mm", min: 2, max: 6.5, step: 0.05, description: "Measured." },
    ] },
  ],
  defaults: { t: 3 },
  parts: {
    grille: sheetPart({
      views: ["panel"], label: "Grille", display: { material: "oak" }, material: "birch plywood", thickness: (p) => p.t,
      profile: (k) => k.shape2d({ outer: [[0, 0], [SIZE, 0], [SIZE, SIZE], [0, SIZE]], holes }),
    }),
  },
  views: { panel: { label: "Panel" } },
};
