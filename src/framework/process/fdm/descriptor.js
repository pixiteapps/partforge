// Reusable design-for-manufacturing process profiles — a manufacturing technique
// as DATA: which checks apply and at what thresholds. `bed` is the build volume
// [x,y,z] in mm (a hard bbox-fit gate); `minWall` mm (a warn); `overhang` is the
// steepest unsupported face the process prints cleanly, in degrees from vertical
// (a cost — supports — armed by the profile alone, see overhangAngleFor; resin
// prints on supports, so it carries none); `bedContact` is the least share (%) of a printed
// piece's near-bed flat underside that must rest on the bed (a GATE, armed by the
// profile alone — see bedContactFor; resin prints on supports, so it carries none);
// `clearance` mm is carried for a future gap check (not enforced yet).
//
// `fits`, `holeUndersize` and `bridge` are the numbers an author (or the cloud
// agent) copies into derive() for a mating feature; nothing in this repo reads
// them yet. They are guide defaults from the FDM design guides, not measurements:
// a calibrated printer overrides them through an inline `{ base, fits: {...} }`
// profile, which REPLACES the fits table whole. `fits` are diametral offsets in
// mm (negative = interference): press (a pin that never comes out), push (a cap
// pressed on by hand), slip (a lid that lifts off), moving (a hinge pin or axle),
// printInPlace (parts printed already assembled). `holeUndersize` is added to a
// horizontal bore's diameter, since the top of a printed arch sags inward.
// `bridge` is the longest flat span the process prints unsupported; resin prints
// on supports, so it carries none.
//
// `footprint` is the percent of a printed piece's posed base area resting on the
// bed below which the footprint cost fires.
//
// A flexing member (`verify.flex`, oracle/flex-root.js) reads three more: `rootFillet`
// is the least root fillet radius as a share of the member's thickness (a GATE, 0.5
// from every snap-fit guide; the stress riser is the same in any material, so resin
// carries it too); `strain` the largest root strain, in percent, the material takes
// for a one-time snap (an advisory, read from a declared deflection: PLA is brittle,
// PETG forgiving); `flexTilt` the steepest the member's long axis may rise off the bed,
// in degrees, before its layers stack across the root (a COST, `standing`: the layer
// bond is a fraction of the in-plane strength, so a standing arm snaps along a layer;
// resin is isotropic and carries none).
//
// Import-free, like every process descriptor: lint and the oracle read it through
// process/registry.js.
export const FDM = {
  id: "fdm",
  kind: "print",
  label: "FDM 3D printing",
  stock: "filament",
  docId: "printed-parts",
  profiles: {
    "fdm-pla": {
      bed: [220, 220, 250], minWall: 1.2, clearance: 0.2, overhang: 45, bedContact: 50, footprint: 10,
      fits: { press: -0.1, push: 0.05, slip: 0.25, moving: 0.35, printInPlace: 0.45 },
      holeUndersize: 0.25, bridge: 10,
      rootFillet: 0.5, strain: 1.5, flexTilt: 45,
    },
    "fdm-petg": {
      bed: [220, 220, 250], minWall: 1.5, clearance: 0.3, overhang: 45, bedContact: 50, footprint: 10,
      fits: { press: -0.1, push: 0.05, slip: 0.3, moving: 0.4, printInPlace: 0.5 },
      holeUndersize: 0.3, bridge: 10,
      rootFillet: 0.5, strain: 3, flexTilt: 45,
    },
  },
  costs: { supports: "overhangArea", footprint: "footprintPct", standing: "flexTilt" },
  metrics: {},
  lintRules: [],
};
