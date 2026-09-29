// The laser process's exporter: one resolved sheet piece → one Drawing (contract §5.5).
// Loaded only through process/exporters.js's dynamic import — it reaches the drawing
// stage and so paper, which the laser DESCRIPTOR (read by lint and the oracle) must never
// do; that is why a process is split into descriptor.js and export.js.
//
// Layers, from the piece's canonical-frame declaration (the pose is never read):
//   cut-outer / cut-inner — the profile's outlines / every ring they enclose (holes, and
//                           an island in a hole), refit, then kerf, in cut order: every
//                           ring before any ring that encloses it (drawing.js's cutRings)
//   score — two-point lines as open paths, score shapes' every ring closed
//   engrave — the engrave shape's rings, a filled region
// Kerf offsets the cut layer ONLY: a score or engrave line is burned along its centre, so
// widening the kerf never moves it.
import { refitRing, ringsOf, cutRings, applyKerf, drawingBounds, LAYER_ORDER } from "../../export/drawing.js";
import { KIT_DEFAULTS } from "../../export/formats.js";

const closedPath = (ring) => ({ start: ring.start, segments: ring.segments, closed: true });
const refitRegions = (regions) => regions.map((rg) => ({ outer: refitRing(rg.outer), holes: rg.holes.map(refitRing) }));
const allRings = (regions) => { const r = ringsOf(regions); return [...r.outer, ...r.holes]; };

// `s` is a ResolvedSheet (sheet/resolve.js), `o` validated KitOptions (only `kerf` is
// read), `k` the geometry kernel (unused by laser: every layer is already a Shape2D or
// plain data), `ctx` = { label, facts? } — facts supplies the narrowest gap a kerf error
// names.
function drawing(s, o, k, ctx = {}) {
  const label = ctx.label ?? s.label ?? "sheet part";
  const kerf = o?.kerf ?? KIT_DEFAULTS.kerf;
  const nominal = refitRegions(s.profile.toContours());
  if (nominal.length === 0) throw new Error(`cut kit: "${label}" has an empty profile — nothing to cut`);
  // A capped gap is the search ceiling, not a measured opening — don't name it.
  const gap = ctx.facts && !ctx.facts.gapCapped && Number.isFinite(ctx.facts.gap) ? ctx.facts.gap : null;
  const cut = cutRings(applyKerf(nominal, kerf, { label, gap }));

  const byId = {
    engrave: s.engrave ? allRings(refitRegions(s.engrave.toContours())).map(closedPath) : [],
    score: [
      ...s.score.lines.map(([a, b]) => ({ start: [a[0], a[1]], segments: [{ to: [b[0], b[1]] }], closed: false })),
      ...s.score.shapes.flatMap((shape) => allRings(refitRegions(shape.toContours())).map(closedPath)),
    ],
    "cut-inner": cut.inner.map(closedPath),
    "cut-outer": cut.outer.map(closedPath),
  };
  const layers = LAYER_ORDER.filter((id) => byId[id].length > 0).map((id) => ({ id, paths: byId[id] }));
  const nb = drawingBounds([{ id: "cut-outer", paths: ringsOf(nominal).outer.map(closedPath) }]);
  return {
    layers,
    bounds: drawingBounds(layers),
    nominal: [nb.max[0] - nb.min[0], nb.max[1] - nb.min[1]],
    kerf,
  };
}

export default { drawing };
