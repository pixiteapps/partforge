// CNC routing — process module #2. Flat stock machined from ONE face: through cuts
// (profile), flat-floored pockets at a depth, drilled holes at a depth, and `extra`
// operations the operator does with another tool after the flat milling. The
// drawing is one layered DXF per piece, depth on the layer name and colour.
//
// Import-free apart from sheet/constants.js and lint/finding.js (test/sheet-layering):
// lint and the oracle read the registry. The resolver that turns pockets/drills/extra
// into shapes lives in sheet/routed.js (it may import geometry); the writer in
// process/cnc-router/export.js (it reaches paper), loaded only by the kit.
import { EMPTY_MARK_RE, MARK_DEPTH, MARK_OVERCUT, ROUTED_DOC_ID, ROUTED_KEYS } from "../../sheet/constants.js";

// The preview: the profile extruded to the thickness, each pocket cut `depth` down from
// the machined face (z = t), each drill as a cylinder from the face to its depth —
// through holes clear BOTH faces by MARK_OVERCUT so no cap is coplanar with a face
// (OCCT's coplanar booleans are fragile) — each extra solid subtracted as given, and
// the reference grooves cut like a laser score. A tool whose region turned out empty
// (EMPTY_MARK_RE) is dropped, never a build failure; matched by message, never by
// asking the shape, so this stays probe-safe.
function orEmpty(make) {
  try { return make(); } catch (e) { if (EMPTY_MARK_RE.test(e?.message ?? "")) return null; throw e; }
}
function routedPreview(k, s) {
  const t = s.thickness;
  const body = s.profile.extrude({ h: t });
  const { pockets, drills, extra } = s.routed;
  const tools = [
    ...pockets.map((pk) => orEmpty(() => pk.region.extrude({ h: pk.depth + MARK_OVERCUT }).translate([0, 0, t - pk.depth]))),
    ...drills.map((dr) => (dr.through
      ? k.cylinder({ d: dr.d, h: t + 2 * MARK_OVERCUT }).translate([dr.at[0], dr.at[1], -MARK_OVERCUT])
      : k.cylinder({ d: dr.d, h: dr.depth + MARK_OVERCUT }).translate([dr.at[0], dr.at[1], t - dr.depth]))),
    ...extra.map((x) => x.solid),
    ...s.grooves.map((g) => orEmpty(() => g.extrude({ h: MARK_DEPTH + MARK_OVERCUT }).translate([0, 0, t - MARK_DEPTH]))),
  ].filter(Boolean);
  return tools.length ? body.cutAll(tools) : body;
}

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
  preview: routedPreview,
  destinations: [{ id: "cnc-router", cutFormat: "dxf" }],
  facts: (s) => ({ process: s.process, material: s.material, thickness: s.thickness, group: s.group,
    flat: [0, 0], area: 0, pieces: 0, customBuild: s.customBuild, evaluated: false }),   // Task 5
  checks: () => ({}),                 // Task 5
  metrics: {},                        // Task 5
  lintRules: [],                      // Task 5
};
