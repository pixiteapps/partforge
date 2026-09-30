// Dev-only contact sheet for the material library: one 30 mm sample per preset,
// laid out in a grid, so a change to a preset or the pattern shader can be
// judged by eye in every environment (materials.html). The "Laser-cut" views
// (below) do the same for the laser burn. Not a reference part.
import { PRESETS } from "../framework/materials/presets.js";
import { sheetPart } from "../framework/sheet/part.js";
import { sheetHole } from "../framework/sheet/joinery.js";

const ids = Object.keys(PRESETS);
const COLS = 6, PITCH = 40;

// Common filament colours for the "PLA colours" and "PETG colours" views: how
// each print finish reads across light, dark and saturated tints, since a preset
// tuned on one colour can wash out another. The last is the no-material blue-grey.
const FILAMENT_COLOURS = [
  ["White", 0xf2f0eb], ["Cream (preset)", PRESETS["pla-print"].color], ["Light grey", 0xa3a6a8],
  ["Charcoal", 0x4a4c50], ["Black", 0x1e1f21], ["No-material blue-grey", 0x9fb4cc],
  ["Red", 0xc8102e], ["Orange", 0xe0592a], ["Yellow", 0xf2c500],
  ["Green", 0x2e8b3d], ["Blue", 0x1f5fbf], ["Purple", 0x6b3fa0],
];

const withHole = (k) =>
  k.box({ size: [30, 30, 12] }).fillet({ r: 3 }).cut(k.cylinder({ r: 5, h: 20 }).translate([0, 0, -4]));

// The "Laser-cut" view: sheet swatches as the laser burn draws them — each 30 × 30 with a
// cut hole, an engraved label (its thickness) and a score line — in every wood at 3, 6 and
// 9 mm; one oak panel standing on edge (posed, so its frame is not the identity); and the
// looks that must NOT burn: a clear-acrylic sheet and an oak block that is not a sheet part.
// "Laser-cut, unburnt" is its twin: the same swatches with an identity author `place`,
// which shows plain wood (materials/sheet-look.js) — same geometry, same place, same
// material — so the two views differ ONLY by the burn and scripts/capture-contact-sheet.mjs
// can diff them pixel for pixel.
const SW = 30;
const WOODS = ["plywood", "oak", "walnut"];
const CONTROLS_Y = -WOODS.length * PITCH;
const LASER_SWATCHES = [
  ...WOODS.flatMap((material, row) => [3, 6, 9].map((t, col) => ({
    key: `${material}_${t}`, label: `${PRESETS[material].label}, ${t} mm`, at: [col * PITCH, -row * PITCH], t, display: { material },
  }))),
  { key: "acrylic_3", label: "Clear acrylic, 3 mm", at: [0, CONTROLS_Y], t: 3, display: { material: "clear-acrylic" }, stock: "clear acrylic" },
  { key: "oak_standing", label: "Oak, 3 mm, standing", at: [PITCH, CONTROLS_Y], t: 3, display: { material: "oak" }, standing: true },
  { key: "oak_block", label: "Oak block (not a sheet part)", at: [2 * PITCH, CONTROLS_Y], t: 3, display: { material: "oak" }, block: true },
];

function laserSwatch(s, unburnt) {
  const [x, y] = s.at;
  const common = {
    label: unburnt ? `${s.label} (unburnt)` : s.label,
    views: [unburnt ? "unburnt" : "laser"],
    ...(s.display ? { display: s.display } : {}),
  };
  if (s.block) {
    return { ...common, build: (k) => k.box({ min: [x, y, 0], max: [x + SW, y + SW, s.t] })
      .cut(k.cylinder({ d: 8, h: s.t + 2 }).translate([x + 21, y + 21, -1])) };
  }
  // A standing swatch is drawn at the drawing origin; its pose stands it on edge at `at`.
  const [u, v] = s.standing ? [0, 0] : [x, y];
  return sheetPart({
    ...common,
    material: s.stock ?? "birch plywood",
    thickness: s.t,
    profile: (k) => k.shape2d([[u, v], [u + SW, v], [u + SW, v + SW], [u, v + SW]]).cut(sheetHole({ d: 8, at: [u + 21, v + 21] })),
    engrave: (k) => k.text2d(String(s.t), { size: 10, align: "center", valign: "middle" }).translate([u + 9, v + 20]),
    score: () => [[[u + 3, v + 7], [u + SW - 3, v + 7]]],
    ...(s.standing ? { pose: { face: "-Y", up: "+Z", at: [x, y, 0] } } : {}),
    ...(unburnt ? { place: (solid) => solid } : {}),
  });
}

export default {
  meta: { title: "Material swatches", units: "mm", environment: "studio" },
  defaults: {},
  views: { all: { label: "All presets", default: true }, colours: { label: "PLA colours" }, petg: { label: "PETG colours" }, print: { label: "Layer lines" }, laser: { label: "Laser-cut" }, unburnt: { label: "Laser-cut, unburnt" } },
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
    ...Object.fromEntries(FILAMENT_COLOURS.map(([label, color], i) => [`pla_${i}`, {
      label: `PLA — ${label}`,
      views: ["colours"],
      build: (k) => withHole(k).translate([(i % COLS) * PITCH, -Math.floor(i / COLS) * PITCH, 0]),
      display: { material: "pla-print", color },
    }])),
    ...Object.fromEntries(FILAMENT_COLOURS.map(([label, color], i) => [`petg_${i}`, {
      label: `PETG — ${label}`,
      views: ["petg"],
      build: (k) => withHole(k).translate([(i % COLS) * PITCH, -Math.floor(i / COLS) * PITCH, 0]),
      display: { material: "petg-print", color },
    }])),
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
    ...Object.fromEntries(LASER_SWATCHES.flatMap((s) => [
      [`laser_${s.key}`, laserSwatch(s, false)],
      [`unburnt_${s.key}`, laserSwatch(s, true)],
    ])),
  },
};
