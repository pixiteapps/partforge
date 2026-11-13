// A hinge whose axis is buried in the body, reduced from a published two-half case
// (spec 2026-11-12-moving-fits-swept-design.md, "Why"): a base and a lid, each 10 mm
// thick, closed on the seam at z = 10, with the hinge axis along X 5 mm inside the back
// wall (y = 15) at the seam. Closed, the lid rests on the base and nothing presses in; as
// it opens, the 5 mm of lid behind the axis swings down through the base (about
// 5·sin(open) mm deep). A static check at the closed pose passes; the sweep does not.
const W = 30, D = 20, H = 10, AXIS_Y = D - 5;

export default {
  meta: { title: "Hinge buried axis", units: "mm" },
  parameters: [{ id: "hinge", title: "Hinge", description: "The case's hinge.", controls: [
    { key: "open", label: "Open", unit: "°", min: 0, max: 110, step: 1, description: "Opens the lid about the hinge axis." },
  ] }],
  defaults: { open: 0 },
  parts: {
    base: {
      label: "Base",
      build: (k) => k.box({ min: [0, 0, 0], max: [W, D, H] }),
      views: { assembly: (s) => s },
    },
    lid: {
      label: "Lid",
      build: (k) => k.box({ min: [0, 0, H], max: [W, D, 2 * H] }),
      views: { assembly: (s, p) => s.rotateAbout({ axis: "X", deg: -p.open, through: [0, AXIS_Y, H] }) },
    },
  },
  views: { assembly: { label: "Assembly" } },
  verify: { sweeps: { open: { param: "open", clearance: 0 } } },
};
