// Demo part — a cross bracket. Showcases the 2-D Shape2D toolkit end to end:
//   • union      — two rounded-rectangle bars fused into a plus
//   • intersect  — optionally clipped to a disc so the arm tips round off
//   • cutAll      — four corner bolt holes drilled in one batch
//   • cut         — a central bore
//   • offset      — an optional print-clearance grow with rounded corners
// The rounded corners and circular holes are true arcs (curve-native profiles), so
// the whole outline stays curve-exact. Open /bracket.html after `npm run dev`.
import { roundedRectPolygon, circleProfile } from "partforge/geometry";

export default {
  meta: { title: "Cross bracket", units: "mm", background: 0x15181d, environment: "workshop" },
  parameters: [
    {
      id: "size",
      title: "Bracket",
      description: "A plus-shaped plate made by **union**-ing a horizontal and a vertical rounded bar.",
      advanced: [
        { key: "span", label: "Span", unit: "mm", min: 30, max: 100, step: 1,
          description: "Overall arm length, tip to tip, in both directions." },
        { key: "bar", label: "Arm width", unit: "mm", min: 10, max: 40, step: 1,
          description: "Width of each arm." },
        { key: "corner", label: "Corner radius", unit: "mm", min: 0, max: 12, step: 0.5,
          description: "Rounding on the bar corners (arcs, kept exact to STEP)." },
        { key: "thickness", label: "Thickness", unit: "mm", min: 2, max: 10, step: 0.5,
          description: "Plate thickness." },
      ],
    },
    {
      id: "holes",
      title: "Holes",
      description: "Four corner bolt holes (**cutAll** in one batch) and an optional central bore (**cut**).",
      advanced: [
        { key: "hole_d", label: "Bolt hole ø", unit: "mm", min: 2, max: 10, step: 0.5,
          description: "Diameter of the four corner holes." },
        { key: "inset", label: "Hole inset", unit: "mm", min: 5, max: 24, step: 1,
          description: "How far the corner holes sit in from the arm tips." },
        { key: "center_d", label: "Center bore ø", unit: "mm", min: 0, max: 30, step: 1,
          description: "Central through-bore. Set to 0 for none." },
      ],
    },
    {
      id: "shape",
      title: "Shape ops",
      controls: [
        { key: "clip", type: "radio", label: "Arm tips",
          options: [{ value: 0, label: "Square" }, { value: 1, label: "Clipped" }],
          description: "**Intersect** the cross with a circle so the four arm tips are rounded off to a common radius." },
        { key: "clearance", type: "slider", label: "Print-clearance offset", unit: "mm",
          min: 0, max: 1, step: 0.1,
          description: "**Offset** the whole outline outward (round corners) for a looser slip fit. 0 = none." },
      ],
    },
  ],
  defaults: { span: 60, bar: 22, corner: 4, thickness: 4, hole_d: 5, inset: 8, center_d: 16, clip: 0, clearance: 0 },
  parts: {
    bracket: {
      label: "Cross bracket",
      views: ["bracket"],
      export: { name: "cross-bracket" },
      display: { material: "powder-coat", color: 0x2b2f36 },
      build: (k, p) => {
        const barH = k.shape2d(roundedRectPolygon(p.span, p.bar, p.corner));
        const barV = k.shape2d(roundedRectPolygon(p.bar, p.span, p.corner));
        let plate = barH.union(barV);                                        // union
        if (p.clip) plate = plate.intersect(k.shape2d(circleProfile(p.span / 2)));  // intersect
        const d = p.span / 2 - p.inset;
        const holes = [[d, d], [-d, d], [d, -d], [-d, -d]].map((c) => circleProfile(p.hole_d / 2, c));
        plate = plate.cutAll(holes);                                         // batch cut
        if (p.center_d > 0) plate = plate.cut(k.shape2d(circleProfile(p.center_d / 2)));  // cut
        if (p.clearance) plate = plate.offset(p.clearance, { corners: "round" });  // offset
        return k.extrude({ profile: plate, h: p.thickness });
      },
    },
  },
  views: { bracket: { label: "Cross bracket" } },
};
