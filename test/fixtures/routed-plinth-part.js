// The worked example from the guide's "Routed parts" section, made runnable: a pine-
// plywood plinth with two pockets at different depths, six peg holes, a tilted saw slot as an
// `extra` op and a centerline. test/routed-kit.test.js builds its cnc-router kit.
import { routedPart, roundedRectProfile } from "partforge/geometry";

export default {
  meta: { title: "Routed plinth", units: "mm" },
  parameters: [{ id: "stock", title: "Stock", controls: [
    { key: "baseLength", label: "Length", unit: "mm", min: 150, max: 300, step: 1 },
    { key: "baseWidth", label: "Width", unit: "mm", min: 80, max: 200, step: 1 },
    { key: "baseThickness", label: "Board thickness", unit: "mm", min: 12, max: 30, step: 0.1, description: "Measured with calipers." },
    { key: "inlayThickness", label: "Inlay thickness", unit: "mm", min: 2, max: 10, step: 0.1 },
    { key: "pegHoleDia", label: "Peg hole", unit: "mm", min: 2, max: 6, step: 0.01 },
    { key: "rackTilt", label: "Rack tilt", unit: "°", min: 0, max: 20, step: 1 },
  ] }],
  defaults: { baseLength: 208, baseWidth: 112, baseThickness: 18, inlayThickness: 6, pegHoleDia: 3.43, rackTilt: 12 },
  derive: () => ({
    vaultW: 34, vaultL: 60, pocketW: 68.6, pocketL: 86.6, rackL: 180, rackY: 41,
    pegHoles: [[-70, 17.5], [-58, 17.5], [-46, 17.5], [46, 17.5], [58, 17.5], [70, 17.5]],
  }),
  views: { assembly: { label: "Assembly" }, base: { label: "Base" } },
  parts: {
    plinth: routedPart({
      label: "Plywood base", views: { assembly: true, base: true }, display: { material: "pine-plywood" },
      material: "pine plywood",
      thickness: (p) => p.baseThickness,
      profile: (k, p) => k.shape2d(roundedRectProfile(p.baseLength, p.baseWidth, 10)),
      pockets: (k, p, d) => [
        { region: k.shape2d(roundedRectProfile(d.vaultW, d.vaultL, 2)).translate([0, -9]), depth: 11.43, label: "peg vault" },
        { region: k.shape2d(roundedRectProfile(d.pocketW, d.pocketL, 4)).translate([-58, -10]), depth: p.inlayThickness, label: "inlay pocket" },
      ],
      drills: (p, d) => d.pegHoles.map(([x, y]) => ({ at: [x, y], d: p.pegHoleDia, depth: 10 })),
      extra: (k, p, d) => [{
        solid: k.box({ size: [d.rackL, 12, 14] }).rotateX(-p.rackTilt).at([0, d.rackY, p.baseThickness - 9.5]),
        footprint: k.shape2d(roundedRectProfile(d.rackL, 12, 2)).translate([0, d.rackY]),
        label: "domino rack slot", method: `table saw, blade tilted ${p.rackTilt}°, 9.5 mm deep`,
      }],
      reference: (k, p) => [[[-p.baseLength / 2 + 10, 0], [p.baseLength / 2 - 10, 0]]],
    }),
  },
};
