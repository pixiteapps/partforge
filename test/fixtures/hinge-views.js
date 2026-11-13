// A two-half hinged case with its motion in its THIRD view (spec
// 2026-11-12-moving-fits-swept-design.md, "Every view is scanned, whatever view is being
// verified"): views { base, lid, assembly, print }, and the hinge only turns in
// `assembly`, as a published AirPods case's does. The hosting app verifies a part's
// first view, so `verify.sweeps.open` must still be swept there, in `assembly`.
//
// `hingeViews("buried")` is hinge-buried-axis.js's geometry: the axis 5 mm inside the back
// wall at the seam, so the lid's back swings down through the base as it opens.
// `hingeViews("working")` lifts the lid 0.5 mm off the base and puts the axis 1 mm behind
// and 1 mm above the back edge, outside both bodies: nothing meets anywhere in the swing.
import buried from "./hinge-buried-axis.js";

const W = 30, D = 20, H = 10;
const GEOMETRY = {
  buried: { lidZ: H, axis: [0, D - 5, H] },
  working: { lidZ: H + 0.5, axis: [0, D + 1, H + 1] },
};

export function hingeViews(kind, { gated = true } = {}) {
  const { lidZ, axis } = GEOMETRY[kind];
  const open = (s, p) => s.rotateAbout({ axis: "X", deg: -p.open, through: axis });
  return {
    ...buried,
    meta: { title: `Hinge views (${kind})`, units: "mm" },
    parts: {
      base: {
        label: "Base",
        build: (k) => k.box({ min: [0, 0, 0], max: [W, D, H] }),
        views: { base: (s) => s, assembly: (s) => s, print: (s) => s },
      },
      lid: {
        label: "Lid",
        build: (k) => k.box({ min: [0, 0, lidZ], max: [W, D, lidZ + H] }),
        views: { lid: (s) => s, assembly: open, print: (s) => s.translate([W + 10, 0, -lidZ]) },
      },
    },
    views: { base: { label: "Base" }, lid: { label: "Lid" }, assembly: { label: "Assembly" }, print: { label: "Print" } },
    verify: { sweeps: { open: { param: "open", clearance: 0 } }, ...(gated ? { expect: { _view: { sweepContacts: 0 } } } : {}) },
  };
}
