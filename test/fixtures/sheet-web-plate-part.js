// Thirty booleaned 6 mm holes and one narrow web: a 164 × 60 mm plate of 3 mm plywood
// with its holes cut by cutAll (four cubics each, the offset engine's costliest round
// shape) and, in one corner, two slots 1 mm apart — a web under the 1.5 mm laser floor,
// so the bridge check has something to find. Finding it used to cost one uninterruptible
// boolean of 5.5 s over the whole profile; every hole here clears every other ring by
// more than 1.5 × the 3 mm search ceiling, so the laser checks leave the holes out of the
// width search (process/laser/descriptor.js holePlan) and read the web in milliseconds.
// Used by scripts/time-sheet-inspect.mjs and test/sheet-dfm.test.js.
import { sheetPart, sheetHole } from "partforge/geometry";

const HOLES = Array.from({ length: 30 }, (_, i) => sheetHole({ d: 6, at: [10 + (i % 12) * 12, 10 + Math.floor(i / 12) * 12] }));
const SLOTS = [[[154, 45], [159, 45], [159, 55], [154, 55]], [[160, 45], [162, 45], [162, 55], [160, 55]]];   // the web: x 159–160

export default {
  meta: { title: "Plate with holes and one narrow web", units: "mm" },
  parameters: [
    { id: "stock", title: "Stock", description: "Measure your sheet.", controls: [
      { key: "t", label: "Sheet thickness", unit: "mm", min: 2, max: 6.5, step: 0.05, description: "Measured." },
    ] },
  ],
  defaults: { t: 3 },
  parts: {
    plate: sheetPart({
      views: ["panel"], label: "Plate", display: { material: "oak" }, material: "birch plywood", thickness: (p) => p.t,
      profile: (k) => k.shape2d([[0, 0], [164, 0], [164, 60], [0, 60]]).cutAll([...HOLES, ...SLOTS]),
    }),
  },
  views: { panel: { label: "Panel" } },
};
