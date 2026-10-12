// CNC routing — process module #2. Flat stock machined from ONE face: through cuts
// (profile), flat-floored pockets at a depth, drilled holes at a depth, and `extra`
// operations the operator does with another tool after the flat milling. The
// drawing is one layered DXF per piece, depth on the layer name and colour.
//
// Import-free apart from sheet/constants.js and lint/finding.js (test/sheet-layering):
// lint and the oracle read the registry. The resolver that turns pockets/drills/extra
// into shapes lives in sheet/routed.js (it may import geometry); the writer in
// process/cnc-router/export.js (it reaches paper), loaded only by the kit.
import { ROUTED_DOC_ID, ROUTED_KEYS } from "../../sheet/constants.js";

export const ROUTER = {
  id: "cnc-router",
  label: "CNC routing",
  stock: "sheet",
  docId: ROUTED_DOC_ID,
  // profile = the through cut; reference = vector lines (centerlines); pockets,
  // drills and extra footprints = filled regions at a depth.
  layers: { profile: "region", reference: "line", pockets: "region", drills: "region", extra: "region" },
  keys: ROUTED_KEYS,
  reservedKeys: [],
  preview: undefined,                 // Task 4
  destinations: [{ id: "cnc-router", cutFormat: "dxf" }],
  facts: (s) => ({ process: s.process, material: s.material, thickness: s.thickness, group: s.group,
    flat: [0, 0], area: 0, pieces: 0, customBuild: s.customBuild, evaluated: false }),   // Task 5
  checks: () => ({}),                 // Task 5
  metrics: {},                        // Task 5
  lintRules: [],                      // Task 5
};
