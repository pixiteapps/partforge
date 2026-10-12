// CNC routing — process module #2. Flat stock machined from ONE face: through cuts
// (profile), flat-floored pockets at a depth, drilled holes at a depth, and `extra`
// operations the operator does with another tool after the flat milling. The
// drawing is one layered DXF per piece, depth on the layer name and colour.
//
// Import-free apart from sheet/constants.js and lint/finding.js (test/sheet-layering):
// lint and the oracle read the registry. The resolver that turns pockets/drills/extra
// into shapes lives in sheet/routed.js (it may import geometry); the writer in
// process/cnc-router/export.js (it reaches paper), loaded only by the kit.
import {
  EMPTY_MARK_RE, MARK_DEPTH, MARK_OVERCUT, ROUTED_DOC_ID, ROUTED_KEYS, LOSS_TOL_MM2, isSheetPart, sheetMeta, fmtMm,
} from "../../sheet/constants.js";
import { err } from "../../lint/finding.js";

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

// ── facts: the operations table ───────────────────────────────────────────────
// In the laser facts' shape (the laser-only readings null), so oracle/measure.js's
// sheetRowFacts reads a routed row unchanged; `routed` carries what the router does.
// `at2d.outside` is the 2-D spot of the first region found outside the profile;
// `at.outside` (its 3-D place) is left null here.
const round2 = (x) => Math.round(x * 100) / 100;
const sizeOf = (shape) => { const { min, max } = shape.boundingBox(); return [max[0] - min[0], max[1] - min[1]]; };
// The centre of the bounding box of `shape`'s largest region; null when empty.
function centreOfLargest(shape) {
  if (shape.isEmpty()) return null;
  let best = null, bestArea = -Infinity;
  for (const region of shape.regions()) { const a = region.area(); if (a > bestArea) { best = region; bestArea = a; } }
  const { min, max } = best.boundingBox();
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2];
}
// Does `shape` leave the profile? Its part outside, when it has an area.
function outsideOf(shape, profile) {
  const off = shape.cut(profile);
  return off.isEmpty() || off.area() <= LOSS_TOL_MM2 ? null : off;
}

function routedFacts(s) {
  const { profile, thickness: t } = s;
  const pieces = profile.toContours().length;
  const area = pieces ? profile.area() : 0;
  const flat = pieces ? sizeOf(profile) : [0, 0];
  const { pockets, drills, extra } = s.routed;

  let outside = 0, empty = 0, outsideAt = null;
  const noteOutside = (shape) => { const off = outsideOf(shape, profile); if (off) { outside++; outsideAt ??= centreOfLargest(off); } };

  const pocketRows = [];
  for (const pk of pockets) {
    if (pk.region.isEmpty()) { empty++; continue; }
    const [w, h] = sizeOf(pk.region);
    pocketRows.push({ label: pk.label, depth: pk.depth, w: round2(w), h: round2(h), area: round2(pk.region.area()) });
    noteOutside(pk.region);
  }
  // Drills grouped by (d, depth, through): one row per tool setting, labels joined.
  const drillGroups = new Map();
  for (const dr of drills) {
    const key = `${dr.d}|${dr.depth}|${dr.through}`;
    const g = drillGroups.get(key) ?? { labels: [], d: dr.d, depth: dr.depth, through: dr.through, count: 0 };
    g.count++;
    if (dr.label && !g.labels.includes(dr.label)) g.labels.push(dr.label);
    drillGroups.set(key, g);
    noteOutside(dr.shape);
  }
  const drillRows = [...drillGroups.values()].map(({ labels, d, depth, through, count }) =>
    ({ label: labels.length ? labels.join(", ") : null, d, depth, through, count }));
  const extraRows = extra.map((x) => {
    const [w, h] = sizeOf(x.footprint);
    noteOutside(x.footprint);
    // How deep the op reaches below the machined face (z = t), within the stock.
    const reach = t - x.solid.boundingBox().min[2];
    return { label: x.label, method: x.method, w: round2(w), h: round2(h), maxDepth: round2(Math.max(0, Math.min(t, reach))) };
  });

  return {
    process: s.process, material: s.material, thickness: t, group: s.group,
    flat, area, pieces, customBuild: s.customBuild,
    marksArea: null, bridge: null, bridgeCapped: false, gap: null, gapCapped: false, marksOutside: null, solidMatchPct: null,
    at2d: { bridge: null, gap: null, marks: null, outside: outsideAt },
    at: { bridge: null, gap: null, marks: null, outside: null },
    readErrors: { bridge: null, gap: null, marks: null, marksArea: null },
    evaluated: true,
    routed: { profile: { w: round2(flat[0]), h: round2(flat[1]) }, pockets: pocketRows, drills: drillRows, extra: extraRows, outside, empty },
  };
}

// ── verify metrics: all warnings, volunteered by checks() ─────────────────────
// None is `budgeted` and none has a `readError`: a routed part's facts are taken
// whole, so nothing is budget-withheld.
const METRICS = {
  routedOutside: { kind: "warn", doc: ROUTED_DOC_ID,
    extract: (s) => s.sheet?.routed?.outside ?? null,
    hint: "a pocket, drill or extra-op footprint of this routed part lies partly outside its profile — the router would cut air or the next piece; move it inside the outline, or widen the profile" },
  routedEmpty: { kind: "warn", doc: ROUTED_DOC_ID,
    extract: (s) => s.sheet?.routed?.empty ?? null,
    hint: "a pocket of this routed part resolved to an empty region at these parameters, so nothing is cut and nothing is drawn for it — check the region's size and position, or drop the entry" },
  routedPieces: { kind: "warn", doc: ROUTED_DOC_ID,
    extract: (s) => s.sheet?.pieces ?? null,
    hint: "the profile is not exactly one piece — a routed part must cut out as one region; join the pieces or split them into separate routedPart sub-parts" },
};

// ── lint ──────────────────────────────────────────────────────────────────────
const DRILL_DEPTH_HINT = "A drill's depth is measured from the machined face; a depth at or past the stock thickness is a through hole. Lower the depth, raise the stock thickness control, or set depth to the thickness to drill through.";
const ROUTER_RULES = [{
  id: "routed-drill-depth",
  run: ({ part, p, d, deriveError }) => {
    if (deriveError || !part?.parts || typeof part.parts !== "object") return [];
    return Object.entries(part.parts).flatMap(([name, sp]) => {
      if (!isSheetPart(sp) || sp.sheet.process !== "cnc-router" || typeof sp.sheet.drills !== "function") return [];
      const meta = sheetMeta(sp, p, d);
      if (!meta) return [];
      let drills;
      try { drills = sp.sheet.drills(p, d); } catch { return []; }   // a throwing drills() is the build rules' business
      if (!Array.isArray(drills)) return [];
      return drills.flatMap((dr, i) => {
        if (!dr || typeof dr.depth !== "number" || !(dr.depth > meta.thickness)) return [];
        const who = typeof dr.label === "string" && dr.label.trim() ? `drill "${dr.label.trim()}"` : `drill ${i + 1}`;
        return [err("routed-drill-depth", `sub-part "${name}": ${who} is ${fmtMm(dr.depth)} mm deep in ${fmtMm(meta.thickness)} mm stock`,
          DRILL_DEPTH_HINT, `parts.${name}.sheet.drills`, ROUTED_DOC_ID)];
      });
    });
  },
}];

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
  facts: routedFacts,
  checks: () => ({ routedOutside: "0", routedEmpty: "0", routedPieces: "1" }),
  metrics: METRICS,
  lintRules: ROUTER_RULES,
};
