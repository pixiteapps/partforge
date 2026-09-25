// Dev-only contact sheet for the material library: one 30 mm sample per preset,
// laid out in a grid, so a change to a preset or the pattern shader can be
// judged by eye in every environment (materials.html). Not a reference part.
import { PRESETS } from "../framework/materials/presets.js";

const ids = Object.keys(PRESETS);
const COLS = 6, PITCH = 40;

const withHole = (k) =>
  k.box({ size: [30, 30, 12] }).fillet({ r: 3 }).cut(k.cylinder({ r: 5, h: 20 }).translate([0, 0, -4]));

export default {
  meta: { title: "Material swatches", units: "mm", environment: "studio" },
  defaults: {},
  views: { all: { label: "All presets", default: true }, print: { label: "Layer lines" } },
  parts: {
    ...Object.fromEntries(ids.map((id, i) => [id.replaceAll("-", "_"), {
      label: PRESETS[id].label,
      views: ["all"],
      build: (k) => withHole(k).translate([(i % COLS) * PITCH, -Math.floor(i / COLS) * PITCH, 0]),
      display: { material: id },
    }])),
    // No material at all: the blue-grey CAD look, a PLA print in that colour in
    // realistic mode (resolve.js).
    no_material: {
      label: "No material",
      views: ["all"],
      build: (k) => withHole(k).translate([(ids.length % COLS) * PITCH, -Math.floor(ids.length / COLS) * PITCH, 0]),
    },
    upright_pla: {
      label: "PLA, displayed upright, printed flat",
      views: ["print"],
      build: (k) => k.box({ size: [30, 12, 40] }),
      // Displayed standing on its Z-tall face; the export pose lies it flat on
      // its printed layer plane, which is what the layer-line orientation check
      // in the "Layer lines" view is for.
      place: (s, { purpose }) => (purpose === "export" ? s.rotateX(90) : s),
      display: { material: "pla-print", color: 0xe0592a },
    },
    flat_pla: {
      label: "PLA, same pose both ways",
      views: ["print"],
      build: (k) => k.box({ size: [30, 12, 40] }).translate([50, 0, 0]),
      display: { material: "pla-print", color: 0xe0592a },
    },
  },
};
