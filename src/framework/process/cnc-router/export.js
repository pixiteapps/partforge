// The cnc-router exporter: one resolved routed piece → one Drawing whose layers carry
// their own DXF name and colour (drawing.js ROUTED_COLORS). Loaded only through
// process/exporters.js. Kerf never applies: the CAM offsets for the tool, and
// validateKitOptions has already refused a kerf for this destination — the check here
// is the belt for a laser destination carrying a routed piece.
//
// Colours: `ctx.palette` (drawing.js routedPalette, built by the kit over EVERY routed
// piece) when given, so one depth is one colour across the kit; without it — a direct
// call — routedPalette over the piece alone. Each named layer also carries its `depth` (mm,
// two decimals) and drills `through`, which the README's layer legend reads.
import {
  refitRing, ringsOf, cutRings, drawingBounds, routedLayerName, depthToken, drillKey, ROUTED_COLORS,
  routedPalette, FLIP_AXIS, mirrorRings,
} from "../../export/drawing.js";
import { KIT_OPTIONS_ERROR } from "../../export/formats.js";

const closedPath = (ring) => ({ start: ring.start, segments: ring.segments, closed: true });
const refitRegions = (regions) => regions.map((rg) => ({ outer: refitRing(rg.outer), holes: rg.holes.map(refitRing) }));
const allRings = (regions) => { const r = ringsOf(regions); return [...r.outer, ...r.holes]; };
const ringsOfShape = (shape) => allRings(refitRegions(shape.toContours())).map(closedPath);

// One face's operation layers: SECONDARY, then drills grouped by (d, depth, through) in
// first-seen order, then pockets grouped by two-decimal depth, shallowest first. `place`
// maps each layer's paths (identity for the near face, the flip's mirror for the far);
// a far layer's id is prefixed `far-` and it carries `face: "far"` — a near layer has
// no face key, so a one-sided piece draws exactly as before two-sided parts existed.
function opLayers({ pockets, drills, extra }, palette, place) {
  const tag = place ? { face: "far" } : {};
  const id = (base) => (place ? `far-${base}` : base);
  const at = place ?? ((paths) => paths);
  const layers = [];
  const secondary = extra.flatMap((x) => ringsOfShape(x.footprint));
  if (secondary.length) layers.push({ id: id("secondary"), name: place ? "FAR_SECONDARY" : "SECONDARY", ...ROUTED_COLORS.secondary, ...tag, paths: at(secondary) });

  // Each hole a closed ring of two exact arcs, which dxf.js writes as a CIRCLE.
  const drillGroups = new Map();
  drills.forEach((dr) => {
    const key = drillKey(dr);
    const g = drillGroups.get(key) ?? { id: id(`drill-${key}`), name: routedLayerName("drill", dr), ...palette.drill.get(key),
      depth: Number(depthToken(dr.depth)), through: dr.through, ...tag, paths: [] };
    g.paths.push(...at(ringsOfShape(dr.shape)));
    drillGroups.set(key, g);
  });
  layers.push(...drillGroups.values());

  // An empty region draws nothing.
  const pocketGroups = new Map();
  for (const pk of pockets) {
    const paths = ringsOfShape(pk.region);
    if (paths.length === 0) continue;
    const key = depthToken(pk.depth);
    const g = pocketGroups.get(key) ?? { id: id(`pocket-${key}`), name: routedLayerName("pocket", pk), depth: Number(key), ...tag, paths: [] };
    g.paths.push(...at(paths));
    pocketGroups.set(key, g);
  }
  [...pocketGroups.values()].sort((a, b) => a.depth - b.depth)
    .forEach((g) => layers.push({ ...g, ...palette.pocket.get(depthToken(g.depth)) }));
  return layers;
}

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
  // Near ops as they are; far ops (cut after the piece is turned over by the kit's flip)
  // on their own `far-` layers, every ring mirrored about the piece's centre so the far
  // face is drawn as the router sees it. One palette for both faces: a depth or drill
  // setting is one colour whichever face it is on.
  const palette = ctx.palette ?? routedPalette([s]);
  const nb = drawingBounds([{ id: "cut-outer", paths: ringsOf(nominal).outer.map(closedPath) }]);
  const axis = FLIP_AXIS[o?.flip ?? "left-right"];
  const centre = axis === "x" ? (nb.min[0] + nb.max[0]) / 2 : (nb.min[1] + nb.max[1]) / 2;
  const isFar = (op) => op.face === "far";
  const near = opLayers({ pockets: pockets.filter((op) => !isFar(op)), drills: drills.filter((op) => !isFar(op)), extra: extra.filter((op) => !isFar(op)) }, palette);
  const far = opLayers({ pockets: pockets.filter(isFar), drills: drills.filter(isFar), extra: extra.filter(isFar) }, palette,
    (paths) => mirrorRings(paths, axis, centre));
  layers.push(...near, ...far);

  if (cut.inner.length) layers.push({ id: "cut-inner", paths: cut.inner.map(closedPath) });
  layers.push({ id: "cut-outer", paths: cut.outer.map(closedPath) });

  const out = { layers, bounds: drawingBounds(layers), nominal: [nb.max[0] - nb.min[0], nb.max[1] - nb.min[1]], kerf: 0 };
  if (far.length) out.farOutline = mirrorRings(ringsOf(nominal).outer, axis, centre).map(closedPath);
  return out;
}

export default { drawing };
