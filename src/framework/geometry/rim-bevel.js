// Rim bevel for extruded profiles — extrude({ profile, h, bevel }). Composed
// entirely from existing kernel ops (extrude + loft + intersect/cut) at the
// backend-shared front, so both backends get identical semantics for free and
// the probe sees no CAD-only op: a beveled extrusion stays on the fast Manifold
// backend instead of routing the whole part to OCCT. (OCCT's native chamfer is
// per-edge; on a many-point profile rim — a gear — one call costs seconds. The
// loft envelope costs one boolean regardless of point count.)
//
// Accepted profiles: point array, arc/curve contour, { outer, holes } region,
// or a Shape2D (multi-region Shape2Ds bevel each region and union). Curved
// profiles are MATERIALIZED to point rings first — the loft envelope needs
// rings in 1:1 point correspondence — so a beveled extrusion is faceted at the
// sampling LOD even in STEP export (the same fidelity class as loft rings).
// Arc contours sample at a fixed pure-JS LOD (backend-identical, like hull);
// a Shape2D materializes via its own backend's toRegions (hull's Shape2D
// parity class). The body is built from the SAME materialized rings as the
// envelope — mixing a curve-exact body with a faceted envelope would leave
// sliver artifacts where the smooth wall crosses the faceted one.
//
// Geometry: a 45° bevel, exactly what chamfer({d, edges:{inPlane}}) would cut.
// The outer rim insets toward the material; a hole's rim flares the other way
// (the opening is larger at the face). Outer bevels come from intersecting a
// loft envelope extended 1 mm past both faces (so its end caps never coincide
// with the extrusion's faces — coincident caps leave sliver-triangle shading
// artifacts). Hole bevels are separate per-rim flare cutters that meet the
// hole wall only along a ring (a curve, not a face), keeping the booleans away
// from coincident-face degeneracies on the B-rep backend.
import { offsetPolygon } from "./polygon.js";
import { tessellateProfile } from "./profile.js";
import { ringArea } from "./shape2d-regions.js";

// Fixed pure-JS sampling LOD for arc/curve contours — hull.js precedent: not a
// backend's own segment count, so both backends materialize bit-identically.
const BEVEL_SEGS = 64;

// Normalize `bevel` (number = both rims, {bottom, top} = per rim) and validate
// against the height. Exported for direct unit testing.
export function resolveBevel(bevel, h) {
  let bottom, top;
  if (typeof bevel === "number") { bottom = bevel; top = bevel; }
  else if (bevel !== null && typeof bevel === "object") {
    for (const key of Object.keys(bevel)) if (key !== "bottom" && key !== "top")
      throw new Error(`extrude: unknown bevel option ${JSON.stringify(key)} (valid: bottom, top)`);
    bottom = bevel.bottom ?? 0; top = bevel.top ?? 0;
  } else throw new Error("extrude: bevel must be a number or { bottom?, top? }");
  if (!(Number.isFinite(bottom) && bottom >= 0) || !(Number.isFinite(top) && top >= 0))
    throw new Error("extrude: bevel distances must be finite numbers >= 0");
  if (bottom + top >= h)
    throw new Error("extrude: bevel must fit the height (bottom + top < h)");
  return { bottom, top };
}

// offsetPolygon needs CCW input; toRegions/hand-written holes may wind either
// way. Tessellated arc contours close back onto their start point — drop that
// duplicate, or the offset ring's point count never matches and fit() gives up.
const ccw = (r) => {
  const [x0, y0] = r[0], [xn, yn] = r[r.length - 1];
  const ring = Math.abs(x0 - xn) < 1e-9 && Math.abs(y0 - yn) < 1e-9 ? r.slice(0, -1) : r;
  return ringArea(ring) >= 0 ? ring : [...ring].reverse();
};

// The largest offset (inset for the outer rim, outset for a hole rim — the sign
// of `delta`) the ring can take, starting from the requested distance. Narrow
// features cap the bevel (the same geometric limit OCCT's chamfer hits — see
// ERROR-PATTERNS.md#chamfer-rescue-bisection), but each attempt here is pure JS
// on the 2-D outline, not a kernel op, so backing off is effectively free. The
// loop is deterministic, preserving build purity. `corners: "sharp"` keeps the
// offset 1:1 with the input points — loft stitching requires every ring to
// share the profile's exact point count (a mismatch is treated as a failed try).
const fit = (ring, delta, what, record) => {
  const requested = Math.abs(delta), sign = Math.sign(delta);
  let c = requested;
  for (;;) {
    try {
      const off = offsetPolygon(ring, sign * c, { corners: "sharp" });
      if (off.length === ring.length) {
        if (c < requested)
          record(`extrude bevel ${requested} exceeds what the ${what} can take — reduced to ${c.toFixed(2)}`);
        return { ring: off, c };
      }
    } catch { /* offset collapsed or self-intersected — try smaller */ }
    c *= 0.85;
    if (c < 0.05) {
      record(`extrude bevel ${requested} has no valid offset for this ${what} — rim left square`);
      return null;
    }
  }
};

const outerRings = (outer, h, b, t) => {
  const rings = [];
  if (b) rings.push({ polygon: b.ring, z: -1 }, { polygon: b.ring, z: 0 }, { polygon: outer, z: b.c });
  else rings.push({ polygon: outer, z: -1 });
  if (t) rings.push({ polygon: outer, z: h - t.c }, { polygon: t.ring, z: h }, { polygon: t.ring, z: h + 1 });
  else rings.push({ polygon: outer, z: h + 1 });
  return rings;
};

const bevelRegion = (k, region, h, bottom, top, record) => {
  const outer = ccw(region.outer);
  const holes = (region.holes ?? []).map(ccw);
  let s = k.extrude({ profile: holes.length ? { outer, holes } : outer, h });
  const b = bottom > 0 ? fit(outer, -bottom, "profile", record) : null;
  const t = top > 0 ? fit(outer, -top, "profile", record) : null;
  // shading: "smooth" on all three internal lofts — a bevel band inherits the
  // profile's own shading intent (sharp corners at the bevel's start/end
  // rings, as a real chamfer would look), not the loft op's own facet-vs-
  // smooth ring-count inference. Left to infer, a <32-point profile (any
  // ordinary polygon) registers FACETED, which drops the bevel band's own
  // corner crease lines, and a label() would carry that faceted policy
  // over to the band's faces 1:1.
  if (b || t) s = s.intersect(k.loft({ rings: outerRings(outer, h, b, t), shading: "smooth" }));
  const cutters = [];
  for (const hole of holes) {
    const hb = bottom > 0 ? fit(hole, bottom, "hole", record) : null;
    if (hb) cutters.push(k.loft({ rings: [
      { polygon: hb.ring, z: -1 }, { polygon: hb.ring, z: 0 }, { polygon: hole, z: hb.c },
    ], shading: "smooth" }));
    const ht = top > 0 ? fit(hole, top, "hole", record) : null;
    if (ht) cutters.push(k.loft({ rings: [
      { polygon: hole, z: h - ht.c }, { polygon: ht.ring, z: h }, { polygon: ht.ring, z: h + 1 },
    ], shading: "smooth" }));
  }
  return cutters.length ? s.cutAll(cutters) : s;
};

// `record` reports the two ways a rim bevel degrades — reduced to what the ring
// can take, or skipped entirely with the rim left square. Both used to reach only
// console.warn, which meant a build could come back ok:true with a bevel the part
// asked for and never got, invisible to the caller (and to the cloud agent). The
// kernel supplies its own recorder; the default keeps the historical console.warn
// for a direct call with no kernel recorder behind it.
export function beveledExtrude(k, { profile, h, twist, scaleTop, bevel },
                               record = k?._recordWarning ?? ((m) => console.warn(`partforge: ${m}`))) {
  if (twist !== undefined || scaleTop !== undefined)
    throw new Error("extrude: bevel cannot combine with twist or scaleTop");
  const { bottom, top } = resolveBevel(bevel, h);
  // bevel: 0 must hash identically to the plain call — hand the original
  // profile straight through (curve-exact on OCCT, no materialization).
  if (bottom === 0 && top === 0) return k.extrude({ profile, h });
  const regions = profile != null && typeof profile.toRegions === "function"
    ? profile.toRegions()
    : [tessellateProfile(profile, BEVEL_SEGS)];
  if (regions.length === 0) throw new Error("extrude: bevel profile produced no regions");
  return regions.map((r) => bevelRegion(k, r, h, bottom, top, record)).reduce((a, x) => a.union(x));
}
