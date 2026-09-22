// The probe-report summary of a Shape2D: its arcs as centre + radius, its corners as
// point + angle. A reader asking "do these two arcs share a centre?" or "what radius
// did that fillet actually take?" reads the numbers here instead of a render.
//
// Arcs come from the contour IR, never from tessellation: a {to, via} segment is exact
// (circumcircle of from/via/to). A cubic is FITTED through its start, midpoint and end
// and tagged `fit: "cubic"` so the reader knows it is an approximation. Fillet itself
// never emits a cubic — paper.js has no arc primitive, so a shape stores one only once
// it has been through a BOOLEAN (union/cut/intersect), a non-uniform transform, or
// simplify. `fit: "cubic"` therefore means "this shape passed through one of those",
// not "this arc came from a curve-adjacent fillet". For an unclipped arc the cubic fit
// is exact to the reporting grid; when a boolean clips an arc mid-sweep the fit's error
// grows as the kept fragment shortens (measured: a r=4 fillet corner clipped at x=18
// read back centre [16.0063, 16.0184] r 3.9816; a r=100 arc clipped to a 20 mm band read
// back centre off by 0.59 mm, r 100.586) — compare centres on the UNCLIPPED shape and
// use a clip only to find which arcs to look at, never to read an exact centre off the
// clipped fragment itself. See docs/AUTHORING-PARTS.md's probes section.
//
// Either recovery (via or cubic) can also produce a near-infinite-radius circle from
// floating-point noise on a segment that is actually straight — most visibly after
// `simplify`, which can re-fit three collinear points into an almost-flat cubic. A
// segment whose sagitta (the arc's peak deviation from its own chord, r·(1 − cos(Δ/2)))
// falls below the 1e-4 mm reporting grid is reported as a line instead of a
// kilometre-radius arc.
//
// Corners are profileCorners' reader-facing fields, plus `position`: a running count
// across every ring in the summary's own order (region by region, outer then holes) —
// exactly the positional index `fillet({corners: {indices}})` and `shape.corners()`
// use (both resolve against profileCorners' own flattened order), computed by that same
// function here rather than re-derived. The `index` field (profileCorners' vertex
// number within its own contour, not a position into this list) is deliberately
// dropped — carrying it here is what invites the {indices} mistake.
//
// The summary is a FLAT list of rings (each one names its own `region`/`ring`/`hole?`)
// rather than nested `{outer, holes}` objects, and the two caps below are counted
// across the WHOLE summary, not per ring: partforge-cloud drops a probe value that
// grows past its JSON budget or nests past its depth cap. Flat, the summary bottoms
// out at rings[] → ring → arcs[] → arc → center[] — 4 containers below the summary
// object itself (5 including it), against the cloud's `DESCRIBE_MAX_DEPTH = 8`, with
// headroom even wrapped in the paired-probe `{pair: {mine, ref}}` form.
import { arcCenterAndSweep } from "../geometry/paper-bridge.js";
import { cubicAt, profileCorners } from "../geometry/contour-ops.js";

export const MAX_ARCS = 64;
export const MAX_CORNERS = 64;

const round = (x) => {
  const v = Math.round(x * 1e4) / 1e4;
  return v === 0 ? 0 : v; // normalize -0 so the report never prints a bare minus sign
};
const pt = ([x, y]) => [round(x), round(y)];
const toDeg = (rad) => (rad * 180) / Math.PI;

// A recovered circle → an arc record, or null when its sagitta (peak deviation from
// its own chord) is below the reporting grid — a near-straight segment reads as a
// line rather than a many-kilometre arc.
function arcFromCircle(c, from, to, fit) {
  const sagitta = c.r * (1 - Math.cos(Math.abs(c.dA) / 2));
  if (sagitta < 1e-4) return null;
  const rec = { center: pt(c.center), r: round(c.r), from: pt(from), to: pt(to), sweepDeg: round(toDeg(c.dA)) };
  if (fit) rec.fit = fit;
  return rec;
}

// One segment → an arc record, or null for a straight (degenerate or near-straight) segment.
function arcOf(from, seg) {
  if (seg.c1 && seg.c2) {
    const mid = cubicAt(from, seg.c1, seg.c2, seg.to, 0.5);
    const c = arcCenterAndSweep(from, mid, seg.to);
    return c ? arcFromCircle(c, from, seg.to, "cubic") : null;
  }
  if (seg.via) {
    const c = arcCenterAndSweep(from, seg.via, seg.to);
    return c ? arcFromCircle(c, from, seg.to, null) : null;
  }
  return null;
}

// One ring's segments → { segments, arcs, lines }. `state.arcsUsed` is the
// WHOLE-SUMMARY arc budget (MAX_ARCS), shared across every ring's call so the cap is
// counted across the whole summary rather than restarting per ring; `segments`/`lines`
// stay exact counts regardless of truncation.
function ringArcs(contour, state) {
  const arcs = [];
  let lines = 0;
  let from = contour.start;
  for (const seg of contour.segments) {
    const a = arcOf(from, seg);
    if (a) {
      if (state.arcsUsed < MAX_ARCS) { arcs.push(a); state.arcsUsed++; } else state.truncated = true;
    } else lines++;
    from = seg.to;
  }
  return { segments: contour.segments.length, arcs, lines };
}

// The key a ring is filed under, shared between the rings[] list this function builds
// and the bucketing of profileCorners' flattened output back onto the ring it came from.
const ringKey = (region, kind, hole) => (kind === "outer" ? `${region}:outer` : `${region}:hole:${hole}`);

/**
 * Summarise a Shape2D's stored contour regions (the `toContours()` value) for the
 * probe report. `isEmpty`, `area` and `bbox` are read by the caller from the shape
 * itself so this stays a pure function of plain data.
 */
export function summarizeContours(regions, { isEmpty, area, bbox }) {
  if (isEmpty || !regions?.length) return { kind: "shape2d", empty: true, area: 0, bbox: null, rings: [], truncated: false };
  const state = { arcsUsed: 0, truncated: false };

  // profileCorners(regions) walks every ring in the SAME region-by-region,
  // outer-then-holes order this function does, and its `position` field is already
  // the flattened index {corners: {indices}} and shape.corners() agree on — computed
  // once here, over the whole shape, rather than restarting the count per ring.
  const allCorners = profileCorners(regions);
  if (allCorners.length > MAX_CORNERS) state.truncated = true;
  const cornersByRing = new Map();
  for (let i = 0; i < allCorners.length && i < MAX_CORNERS; i++) {
    const c = allCorners[i];
    const key = c.ring === "outer" ? ringKey(c.regionIndex, "outer") : ringKey(c.regionIndex, "hole", c.ring.hole);
    const bucket = cornersByRing.get(key) ?? [];
    bucket.push({ position: c.position, point: pt(c.point), interiorAngleDeg: round(c.interiorAngleDeg), convex: c.convex });
    cornersByRing.set(key, bucket);
  }

  const rings = [];
  regions.forEach((rg, region) => {
    const outerFacts = ringArcs(rg.outer, state);
    rings.push({ region, ring: "outer", ...outerFacts, corners: cornersByRing.get(ringKey(region, "outer")) ?? [] });
    (rg.holes ?? []).forEach((h, hole) => {
      const holeFacts = ringArcs(h, state);
      rings.push({ region, ring: "hole", hole, ...holeFacts, corners: cornersByRing.get(ringKey(region, "hole", hole)) ?? [] });
    });
  });

  return {
    kind: "shape2d", empty: false, area: round(area),
    bbox: bbox ? { min: pt(bbox.min), max: pt(bbox.max) } : null,
    rings, truncated: state.truncated,
  };
}
