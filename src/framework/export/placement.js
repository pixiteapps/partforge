// Shared by the kit's SVG and DXF writers: one Drawing's frame → the sheet frame for one
// placement. IMPORT-FREE, like formats.js — svg.js and dxf.js are each a "paper-free leaf
// (arc-math.js only)" on their own, and this tiny third leaf is what lets them share the
// placement math without either reaching into the other or into drawing.js (which reaches
// paper).

// Translate so the drawing's bounds.min lands on `at`, after an optional 90° CCW turn (a
// proper rotation: arcs keep their sense).
export function placer({ drawing, at, rotated }) {
  const { min, max } = drawing.bounds;
  if (!rotated) return ([x, y]) => [x - min[0] + at[0], y - min[1] + at[1]];
  // (x, y) → (−y, x); the turned bounds' min corner is (−max.y, min.x)
  return ([x, y]) => [max[1] - y + at[0], x - min[0] + at[1]];
}
