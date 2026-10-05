// Finger-jointed plywood box: five laser-cut panels from fingerBox, a laser-cut lid,
// and two print-in-place hinges whose tongues key into slots in the back panel and
// the lid; an engraved label and a score line on the front. A hinge prints flat and
// flat is 90° open, so the box is shown with its lid standing up.
import { sheetPart, fingerBox, printedTab, worldToSheet } from "partforge/geometry";

// Hinge in its PRINT pose: leaves flat on the bed, knuckle axis along X at y = 0,
// z = R, tongues up (+Z). Fixed leaf (y < 0) → back panel; lid leaf (y > 0) → lid.
const HINGE = { width: 24, leaf: 18, leafT: 3, R: 3, gap: 0.4, pinR: 1.2, lift: 0.25,
  tongue: [8, 3], tongueX: 6, tongueY: 11 };

// ONE spec for a tongue and its slot; the slot carries the clearance.
const tab = (p) => printedTab({ size: HINGE.tongue, thickness: p.t, clearance: p.printFit });

function hinge(k, p, d) {
  const { width: w, leaf, leafT, R, gap, pinR, tongueX } = HINGE, { tongueY } = d;
  const seg = (w - 2 * gap) / 3;                                  // three knuckles, `gap` apart
  const x0 = -w / 2, x1 = x0 + seg, x2 = x1 + gap, x3 = x2 + seg, x4 = x3 + gap, x5 = w / 2;
  const box = (min, max) => k.box({ min, max });
  const barrel = (a, b, r = R) => k.cylinder({ r, h: b - a }).along("+X").at([a, 0, R]);
  const tongues = (y) => [-tongueX, tongueX].map((x) => k.box({ size: tab(p).tongue }).at([x, y, leafT]));
  const fixed = k.union([
    box([x0, -leaf, 0], [x5, -(R + gap), leafT]),
    box([x0, -(R + gap), 0], [x1, 0, leafT]), box([x4, -(R + gap), 0], [x5, 0, leafT]),
    barrel(x0, x1), barrel(x4, x5), barrel(x0, x5, pinR),         // outer knuckles + pin
    ...tongues(-tongueY),
  ]).label("Fixed leaf");
  const moving = k.union([
    box([x0, R + gap, 0], [x5, leaf, leafT]), box([x2, 0, 0], [x3, R + gap, leafT]),
    barrel(x2, x3), ...tongues(tongueY),
  ]).cut(barrel(x2 - 1, x3 + 1, pinR + gap)).label("Lid leaf");  // running clearance on the pin
  return k.union([fixed, moving]);
}

// Each hinge is built in its PRINT pose (above); the box view stands it up on the back
// panel. Identical builds, so the kit still prints "hinge" ×2.
const hingePose = (i) => (s, p, d) => s.rotateX(90).at([d.hingeX[i], p.depth / 2 + HINGE.leafT, d.axisZ]);

// Tongue slots for both hinges, cut where the tongues really land (world → sheet).
const hingeSlots = (k, p, d, pose, z) => d.hingeX.flatMap((hx) =>
  [hx - HINGE.tongueX, hx + HINGE.tongueX].map((x) =>
    k.shape2d(tab(p).slot).translate(worldToSheet(pose, [x, p.depth / 2, z]))));

const PLY = { views: { box: true }, display: { material: "plywood" }, material: "birch plywood", thickness: (p) => p.t };
const panel = (name, label, extra = {}) => sheetPart({
  ...PLY, label,
  profile: (k, p, d) => d.box[name].outline,       // drawn as seen from outside
  pose: (p, d) => d.box[name].pose,                // fingerBox knows where it goes
  ...extra,
});

export default {
  meta: { title: "Plywood box with printed hinges", units: "mm" },
  parameters: [
    { id: "box", title: "Box", description: "Outside size, lid excluded.", controls: [
      { key: "width", label: "Width", unit: "mm", min: 100, max: 400, step: 1, description: "Outside width." },
      { key: "depth", label: "Depth", unit: "mm", min: 80, max: 300, step: 1, description: "Hinges on the back." },
      { key: "height", label: "Height", unit: "mm", min: 50, max: 200, step: 1, description: "Wall height." },
      { key: "label", type: "text", label: "Label", description: "Engraved on the front; empty for none." },
    ] },
    { id: "stock", title: "Stock & fit", description: "Measure your sheet. Kerf is chosen when you download the kit.", controls: [
      { key: "t", label: "Sheet thickness", unit: "mm", min: 2, max: 6.5, step: 0.05, description: "MEASURED — '3 mm' ply is often 2.7–3.3." },
      { key: "fit", label: "Finger clearance", unit: "mm", min: 0, max: 0.4, step: 0.02, description: "Total play per finger joint." },
      { key: "printFit", label: "Hinge tab clearance", unit: "mm", min: 0, max: 0.8, step: 0.05, description: "Slot minus printed tongue." },
    ] },
  ],
  defaults: { width: 160, depth: 110, height: 80, label: "TOOLS", t: 3, fit: 0.1, printFit: 0.3 },
  derive: (p) => {
    const rise = Math.max(0, p.t - HINGE.R);                     // thick stock: the shut lid clears the walls
    const axisZ = p.height + HINGE.lift + HINGE.R + rise;        // knuckle axis, above the back wall
    const lidZ = axisZ + HINGE.lift + HINGE.R;                   // hinge edge of the open lid
    return {
      box: fingerBox({ width: p.width, depth: p.depth, height: p.height, thickness: p.t, clearance: p.fit }),
      hingeX: [-(p.width / 2 - 25), p.width / 2 - 25],
      axisZ,
      tongueY: HINGE.tongueY + rise,                             // slots stay put
      // Open 90°: laser face to the back, the drawing's front edge (v = 0) on top.
      lidPose: { face: "+Y", up: "-Z", at: [-p.width / 2, p.depth / 2, lidZ + p.depth] },
    };
  },
  parts: {
    bottom: panel("bottom", "Bottom"),
    left: panel("left", "Left"),
    right: panel("right", "Right"),
    front: panel("front", "Front", {                              // u across, v up
      engrave: (k, p) => (p.label?.trim() ? k.text2d(p.label, { size: 14 }).translate([p.width / 2, p.height * 0.55]) : null),
      score: (k, p) => [[[12, p.height * 0.35], [p.width - 12, p.height * 0.35]]],   // a two-point line
    }),
    back: panel("back", "Back", {
      profile: (k, p, d) => k.shape2d(d.box.back.outline)
        .cutAll(hingeSlots(k, p, d, d.box.back.pose, d.axisZ - d.tongueY)),
    }),
    lid: sheetPart({
      ...PLY, label: "Lid",
      profile: (k, p, d) => k.shape2d([[0, 0], [p.width, 0], [p.width, p.depth], [0, p.depth]])
        .cutAll(hingeSlots(k, p, d, d.lidPose, d.axisZ + d.tongueY)),
      pose: (p, d) => d.lidPose,
    }),
    hingeL: { label: "Hinge (left)", views: { box: hingePose(0) }, display: { material: "pla-print" },
      export: { name: "hinge" }, build: hinge },
    hingeR: { label: "Hinge (right)", views: { box: hingePose(1) }, display: { material: "pla-print" },
      build: hinge },    // identical solid: the kit prints "hinge" ×2
  },
  views: { box: { label: "Box" } },
  // `process` = the PRINTED parts' profile; sheet parts get the laser checks instead.
  verify: { process: "fdm-pla", expect: { _view: { overlaps: 0 } } },
};
