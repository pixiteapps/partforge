// Resin printing as DATA: see process/fdm/descriptor.js for what each profile field
// means. Resin prints on supports, so it carries no overhang, bedContact, footprint
// or bridge, and no costs; it is isotropic, so no flexTilt either. A flexing member's
// root fillet and strain apply in any material. Import-free, like every process descriptor.
export const RESIN = {
  id: "resin",
  kind: "print",
  label: "Resin 3D printing",
  stock: "resin",
  docId: "printed-parts",
  profiles: {
    "resin": {
      bed: [120, 68, 160], minWall: 0.6, clearance: 0.1,
      fits: { press: -0.05, push: 0.05, slip: 0.1, moving: 0.15, printInPlace: 0.2 },
      holeUndersize: 0.05,
      rootFillet: 0.5, strain: 2,
    },
  },
  costs: {},
  metrics: {},
  lintRules: [],
};
