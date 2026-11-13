// A hinge that cannot open, reduced from a published picture frame
// (spec 2026-11-12-moving-fits-swept-design.md, "Why"): two 4 mm plates folded flat, the
// hinge axis along X at their shared back corner (y = 0, z = 0), and each knuckle a plain
// cylinder centred on that axis with no relief cut in the other plate. So every knuckle
// sits inside the other plate's corner at every angle, about 4 mm deep along the axis.
// `verify.sweeps.open` at clearance 0 reads one contact, base×lid, over the whole swing.
const W = 40, D = 30, T = 4, R = 5;
// knuckle spans along X: the base takes the outer three, the lid the two between
const BASE_KNUCKLES = [[0, 8], [16, 24], [32, 40]];
const LID_KNUCKLES = [[8, 16], [24, 32]];

const knuckles = (k, spans) => spans
  .map(([x0, x1]) => k.cylinder({ r: R, h: x1 - x0 }).along("+X").translate([x0, 0, 0]))
  .reduce((a, b) => a.union(b));

export default {
  meta: { title: "Hinge frame knuckles", units: "mm" },
  parameters: [{ id: "hinge", title: "Hinge", description: "The frame's hinge.", controls: [
    { key: "open", label: "Open", unit: "°", min: 0, max: 110, step: 1, description: "Opens the lid about the hinge axis." },
  ] }],
  defaults: { open: 0 },
  parts: {
    base: {
      label: "Base",
      build: (k) => k.box({ min: [0, -D, -T], max: [W, 0, 0] }).union(knuckles(k, BASE_KNUCKLES)),
      views: { assembly: (s) => s },
    },
    lid: {
      label: "Lid",
      build: (k) => k.box({ min: [0, -D, 0], max: [W, 0, T] }).union(knuckles(k, LID_KNUCKLES)),
      views: { assembly: (s, p) => s.rotateAbout({ axis: "X", deg: -p.open, through: [0, 0, 0] }) },
    },
  },
  views: { assembly: { label: "Assembly" } },
  verify: { sweeps: { open: { param: "open", clearance: 0 } } },
};
