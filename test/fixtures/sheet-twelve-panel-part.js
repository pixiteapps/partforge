// Twelve finger-jointed plywood panels: two 300 × 200 × 120 fingerBoxes side by side,
// each under a flat lid — the inspect-budget stress case (sheet parts spec C.6).
// Every wall edge carries some 49 fingers, so each outline runs to hundreds of
// vertices and its 2-D checks cost as much as a real box's do. Used by
// test/sheet-dfm.test.js and scripts/time-sheet-inspect.mjs.
import { sheetPart, fingerBox } from "partforge/geometry";

const PANELS = ["bottom", "front", "back", "left", "right"];
const GAP = 10;                                              // mm between the two boxes
const offsetOf = (i, p) => i * (p.width + GAP);              // box i's shift along X
const shiftX = (pose, dx) => ({ ...pose, at: [pose.at[0] + dx, pose.at[1], pose.at[2]] });
const PLY = { views: ["kit"], display: { material: "oak" }, material: "birch plywood", thickness: (p) => p.t };

const box = (i) => Object.fromEntries(PANELS.map((name) => [`${name}${i + 1}`, sheetPart({
  ...PLY, label: `Box ${i + 1} ${name}`,
  profile: (k, p, d) => k.shape2d(d.box[name].outline),
  pose: (p, d) => shiftX(d.box[name].pose, offsetOf(i, p)),
})]));

// Laser face up, resting on the walls' top edges.
const lid = (i) => sheetPart({
  ...PLY, label: `Box ${i + 1} lid`,
  profile: (k, p) => k.shape2d([[0, 0], [p.width, 0], [p.width, p.depth], [0, p.depth]]),
  pose: (p) => ({ face: "+Z", up: "+Y", at: [-p.width / 2 + offsetOf(i, p), -p.depth / 2, p.height + p.t] }),
});

export default {
  meta: { title: "Twelve-panel box pair", units: "mm" },
  parameters: [
    { id: "box", title: "Box", description: "Outside size of each box, lid excluded.", controls: [
      { key: "width", label: "Width", unit: "mm", min: 100, max: 400, step: 1, description: "Outside width." },
      { key: "depth", label: "Depth", unit: "mm", min: 80, max: 300, step: 1, description: "Outside depth." },
      { key: "height", label: "Height", unit: "mm", min: 50, max: 200, step: 1, description: "Wall height." },
    ] },
    { id: "stock", title: "Stock & fit", description: "Measure your sheet.", controls: [
      { key: "t", label: "Sheet thickness", unit: "mm", min: 2, max: 6.5, step: 0.05, description: "Measured." },
      { key: "fit", label: "Finger clearance", unit: "mm", min: 0, max: 0.4, step: 0.02, description: "Total play per finger joint." },
    ] },
  ],
  defaults: { width: 300, depth: 200, height: 120, t: 3, fit: 0.1 },
  derive: (p) => ({ box: fingerBox({ width: p.width, depth: p.depth, height: p.height, thickness: p.t, clearance: p.fit }) }),
  parts: { ...box(0), ...box(1), lid1: lid(0), lid2: lid(1) },
  views: { kit: { label: "Kit" } },
  verify: { expect: { _view: { overlaps: 0 } } },
};
