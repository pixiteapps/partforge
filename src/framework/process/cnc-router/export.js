// The cnc-router exporter: one resolved routed piece → one Drawing whose layers carry
// their own DXF name and colour (drawing.js ROUTED_COLORS). Loaded only through
// process/exporters.js. Kerf never applies: the CAM offsets for the tool, and
// validateKitOptions has already refused a kerf for this destination — the check here
// is the belt for a laser destination carrying a routed piece.
import {
  refitRing, ringsOf, cutRings, drawingBounds, routedLayerName, depthToken, ROUTED_COLORS,
} from "../../export/drawing.js";
import { KIT_OPTIONS_ERROR } from "../../export/formats.js";

const closedPath = (ring) => ({ start: ring.start, segments: ring.segments, closed: true });
const refitRegions = (regions) => regions.map((rg) => ({ outer: refitRing(rg.outer), holes: rg.holes.map(refitRing) }));
const allRings = (regions) => { const r = ringsOf(regions); return [...r.outer, ...r.holes]; };
const ringsOfShape = (shape) => allRings(refitRegions(shape.toContours())).map(closedPath);

function drawing(s, o, k, ctx = {}) {
  const label = ctx.label ?? s.label ?? "routed part";
  if (o?.kerf > 0) throw new Error(`${KIT_OPTIONS_ERROR} kerf does not apply to a CNC router — the CAM applies the tool offset; set kerf to 0 ("${label}")`);
  const nominal = refitRegions(s.profile.toContours());
  if (nominal.length === 0) throw new Error(`cut kit: "${label}" has an empty profile — nothing to cut`);
  const cut = cutRings(nominal);
  const { pockets, drills, extra } = s.routed;

  const layers = [];
  const reference = [
    ...s.score.lines.map(([a, b]) => ({ start: [a[0], a[1]], segments: [{ to: [b[0], b[1]] }], closed: false })),
    ...s.score.shapes.flatMap(ringsOfShape),
  ];
  if (reference.length) layers.push({ id: "reference", name: "REFERENCE", ...ROUTED_COLORS.reference, paths: reference });
  const secondary = extra.flatMap((x) => ringsOfShape(x.footprint));
  if (secondary.length) layers.push({ id: "secondary", name: "SECONDARY", ...ROUTED_COLORS.secondary, paths: secondary });

  // Drills grouped by (d, depth, through) in first-seen order; each hole a closed ring
  // of two exact arcs, which dxf.js writes as a CIRCLE.
  const drillGroups = new Map();
  drills.forEach((dr) => {
    const key = `D${depthToken(dr.d)}-${dr.through ? "THRU" : depthToken(dr.depth)}`;
    const g = drillGroups.get(key) ?? { id: `drill-${key}`, name: routedLayerName("drill", dr), ...ROUTED_COLORS.drill[drillGroups.size % ROUTED_COLORS.drill.length], paths: [] };
    g.paths.push(...ringsOfShape(dr.shape));
    drillGroups.set(key, g);
  });
  layers.push(...drillGroups.values());

  // Pockets grouped by two-decimal depth, shallowest layer first; an empty region draws nothing.
  const pocketGroups = new Map();
  for (const pk of pockets) {
    const paths = ringsOfShape(pk.region);
    if (paths.length === 0) continue;
    const key = depthToken(pk.depth);
    const g = pocketGroups.get(key) ?? { id: `pocket-${key}`, name: routedLayerName("pocket", pk), depth: Number(key), paths: [] };
    g.paths.push(...paths);
    pocketGroups.set(key, g);
  }
  [...pocketGroups.values()].sort((a, b) => a.depth - b.depth).forEach(({ depth, ...g }, i) => {
    layers.push({ ...g, ...ROUTED_COLORS.pocket[i % ROUTED_COLORS.pocket.length] });
  });

  if (cut.inner.length) layers.push({ id: "cut-inner", paths: cut.inner.map(closedPath) });
  layers.push({ id: "cut-outer", paths: cut.outer.map(closedPath) });

  const nb = drawingBounds([{ id: "cut-outer", paths: ringsOf(nominal).outer.map(closedPath) }]);
  return { layers, bounds: drawingBounds(layers), nominal: [nb.max[0] - nb.min[0], nb.max[1] - nb.min[1]], kerf: 0 };
}

export default { drawing };
