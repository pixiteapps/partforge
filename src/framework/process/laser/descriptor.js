// Laser cutting — process module #1. A ProcessDescriptor is DATA: which layers a sheet
// part draws, which keys it reserves, which destinations the kit offers. Later phases
// add its lint rules, DFM metrics and 2-D checks here.
//
// Import-free apart from sheet/constants.js: lint and the oracle read the registry, so
// nothing reachable from here may touch a kernel, a Shape2D or paper
// (test/lint-purity.test.js, test/oracle-no-paper.test.js). The writers that draw this
// process's cut files live in process/laser/export.js, which only the kit loads.
import { SHEET_DOC_ID } from "../../sheet/constants.js";

export const LASER = {
  id: "laser",
  label: "Laser cutting",
  stock: "sheet",
  docId: SHEET_DOC_ID,
  // profile = the CUT layer (filled regions: outline plus holes), score = vector lines,
  // engrave = filled regions burned into the laser face.
  layers: { profile: "region", score: "line", engrave: "region" },
  // Keys only this process reserves (sheet/constants.js RESERVED_KEYS covers the
  // global ones: folds, bends, grain).
  reservedKeys: [],
  // No preview hook: the default extrusion-plus-marks build (sheet/resolve.js
  // sheetPreview) is the laser preview.
  preview: undefined,
  destinations: [{ id: "own-laser", cutFormat: "svg" }, { id: "service", cutFormat: "dxf" }],
};
