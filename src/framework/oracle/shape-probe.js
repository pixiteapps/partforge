// The probe-report summary of a Shape2D: its arcs as centre + radius, its corners as
// point + angle. A reader asking "do these two arcs share a centre?" or "what radius
// did that fillet actually take?" reads the numbers here instead of a render.
//
// Arcs come from the contour IR, never from tessellation: a {to, via} segment is exact
// (circumcircle of from/via/to); a cubic — what a curve-adjacent fillet emits — is
// FITTED through its start, midpoint and end and tagged `fit: "cubic"` so the reader
// knows it is an approximation. Straight segments are counted, not listed.
//
// Corners are profileCorners' three reader-facing fields. The `index` field is
// deliberately dropped: it is the contour vertex index, not a position into the list
// `fillet({indices})` selects from, and carrying it here is what invites that mistake.
//
// Bounded: partforge-cloud drops a probe value that grows past its JSON budget, so a
// ring lists at most MAX_RING_ARCS arcs and MAX_RING_CORNERS corners and the summary
// says `truncated` when it had to cut.
import { arcCenterAndSweep } from "../geometry/paper-bridge.js";
import { cubicAt, profileCorners } from "../geometry/contour-ops.js";

export const MAX_RING_ARCS = 64;
export const MAX_RING_CORNERS = 64;

const round = (x) => Math.round(x * 1e4) / 1e4;
const pt = ([x, y]) => [round(x), round(y)];
const toDeg = (rad) => (rad * 180) / Math.PI;

// One segment → an arc record, or null for a straight (or degenerate) segment.
function arcOf(from, seg) {
  if (seg.c1 && seg.c2) {
    const mid = cubicAt(from, seg.c1, seg.c2, seg.to, 0.5);
    const c = arcCenterAndSweep(from, mid, seg.to);
    if (!c) return null;
    return { center: pt(c.center), r: round(c.r), from: pt(from), to: pt(seg.to), sweepDeg: round(toDeg(c.dA)), fit: "cubic" };
  }
  if (seg.via) {
    const c = arcCenterAndSweep(from, seg.via, seg.to);
    if (!c) return null;
    return { center: pt(c.center), r: round(c.r), from: pt(from), to: pt(seg.to), sweepDeg: round(toDeg(c.dA)) };
  }
  return null;
}

function summarizeRing(contour, state) {
  const arcs = [];
  let lines = 0;
  let from = contour.start;
  for (const seg of contour.segments) {
    const a = arcOf(from, seg);
    if (a) {
      if (arcs.length < MAX_RING_ARCS) arcs.push(a); else state.truncated = true;
    } else lines++;
    from = seg.to;
  }
  const corners = profileCorners(contour).map((c) => ({
    point: pt(c.point), interiorAngleDeg: round(c.interiorAngleDeg), convex: c.convex,
  }));
  if (corners.length > MAX_RING_CORNERS) { corners.length = MAX_RING_CORNERS; state.truncated = true; }
  return { segments: contour.segments.length, arcs, lines, corners };
}

/**
 * Summarise a Shape2D's stored contour regions (the `toContours()` value) for the
 * probe report. `isEmpty`, `area` and `bbox` are read by the caller from the shape
 * itself so this stays a pure function of plain data.
 */
export function summarizeContours(regions, { isEmpty, area, bbox }) {
  if (isEmpty || !regions?.length) return { kind: "shape2d", empty: true, area: 0, bbox: null, regions: [], truncated: false };
  const state = { truncated: false };
  const out = regions.map((rg) => ({
    outer: summarizeRing(rg.outer, state),
    holes: (rg.holes ?? []).map((h) => summarizeRing(h, state)),
  }));
  return {
    kind: "shape2d", empty: false, area: round(area),
    bbox: bbox ? { min: pt(bbox.min), max: pt(bbox.max) } : null,
    regions: out, truncated: state.truncated,
  };
}
