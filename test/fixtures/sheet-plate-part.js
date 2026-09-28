// A 120 × 80 birch-plywood plate with a (deliberately wrong) kerf control: the CLI
// fixture for the sheet-part lines `partforge measure` and `partforge lint` print.
import { sheetPart } from "partforge/geometry";

export default {
  meta: { title: "Sheet plate", units: "mm" },
  parameters: [{ id: "stock", title: "Stock", description: "Measure your sheet.", controls: [
    { key: "t", label: "Sheet thickness", unit: "mm", min: 1, max: 6, step: 0.05, description: "Measured with calipers." },
    { key: "kerf", label: "Kerf", unit: "mm", min: 0, max: 0.5, step: 0.01, description: "Wrong on purpose: kerf is chosen when the kit is downloaded." },
  ] }],
  defaults: { t: 3, kerf: 0.2 },
  parts: {
    plate: sheetPart({
      views: ["main"], label: "Plate", material: "birch plywood", thickness: (p) => p.t,
      profile: (k) => k.shape2d([[0, 0], [120, 0], [120, 80], [0, 80]]),
    }),
  },
  views: { main: { label: "Main" } },
};
