// src/framework/oracle/bed-contact.js
// How much of a printed piece's flat underside actually rests on the bed.
//
// The failure this exists for: a piece whose big flat bottom sits a fraction of a
// millimetre ABOVE its lowest point, because something smaller pokes lower — a
// horizontal knuckle or pin whose cylinder dips under the plate, lettering embossed
// on the underside, a boss. Every exporter and slicer
// lays a piece on its lowest point, so that small feature becomes the only thing on
// the bed and the flat face prints in mid-air: the first layer is laid onto nothing,
// strings and spaghettis, and what does print has a ruined bottom surface. Seen on a
// real forge (a print-in-place toggle latch whose lever knuckle sat lower than the
// lever body): the flat underside hovered 0.1-0.3 mm and the print failed. Every
// other check passed it — overhang.js deliberately skips the first millimetre above
// the bed (the near-bed band), so a hovering face is exactly what it cannot see.
//
// One pass over the triangles, pure, no BVH — the same cost class as overhang.js and
// run beside it. Two areas, both of downward-facing FLAT faces (normal within FLAT_TOL
// of straight down — so the lower curl of a bottom fillet or chamfer, and a cylinder's
// side, count as neither):
//   - contact: the footprint, flat faces with every vertex within `bedEps` of the bed. The
//     slack starts as overhang.js's (0.1% of the mesh height, floored at 10 µm — boolean
//     noise a few microns low must not lift a whole face off the bed) but is CAPPED at
//     MAX_BED_EPS: overhang can let it grow with the part because it only excludes the
//     footprint, whereas here it decides what counts as touching, and a 200 mm tall piece
//     would otherwise call a face 0.15 mm up "on the bed" — the very gap this exists for;
//   - hover: LEVEL faces (within LEVEL_TOL, a tenth of a degree) with EVERY vertex
//     above the footprint slack and the centroid within `bedBand` (1 mm, overhang.js's
//     near-bed band) of the bed — a face floating clear of the bed, as a plate over a
//     lower knuckle or emboss is. Above the band a face is a ceiling, which is
//     overhang.js's to judge. The two extra conditions are what keep a curved surface
//     resting on the bed (a cylinder on its side, a sphere, a dome) from reading as
//     hovering, since its lowest facets are near level too. A face that hovers because
//     of a lower feature is a plane the author made horizontal, level to float
//     precision; a curved surface's facet is level only where it contains the lowest
//     point — where it touches the bed — and every facet clear of the bed is tilted by
//     about one tessellation step or more (3.1° at the preview's 116 segments, 0.75° at
//     the print tier's 480, geometry/circle-segs.js): a Ø120 cylinder's facets beside
//     its lowest line are 1.55° off and touch the bed there, and a sphere's second ring
//     around its pole is clear of the bed but just as tilted. Every vertex, besides,
//     so a facet that does reach the bed is never hover, however it is tilted.
// `pct` is the share of that near-bed flat underside which touches: 100 when nothing
// hovers, near 0 for a plate resting on a knuckle. A hover total under HOVER_FLOOR is
// noise and reads as 100.
//
// Known limit, stated rather than hidden: a recess meant to clear the bed (a foot ring
// with a shallow pocket inside it) hovers by design, and is reported. A pocket that
// shallow is a long bridge laid in the first layers and rarely prints well, so the
// default threshold stands; a part that means it lowers its own `bedContactPct`. And
// a flat bottom TILTED off level (one edge on the bed, the rest rising) is not caught:
// it is not level, which is exactly the signature of curvature above, and telling the
// two apart would need the mesh's connectivity.
//
// Works on both mesh forms the oracle sees (Manifold's soup, OCCT's indexed vertices).

// A face counts as flat (contact) when its normal is within FLAT_TOL degrees of straight
// down, and as level (hover) within LEVEL_TOL. LEVEL_TOL is far above float32 normal
// noise (~1e-4°) and far below any tessellation step a curved surface is made of (see
// the hover rule above).
const FLAT_TOL = 2;
const FLAT_COS = Math.cos((FLAT_TOL * Math.PI) / 180);
const LEVEL_TOL = 0.1;
const LEVEL_COS = Math.cos((LEVEL_TOL * Math.PI) / 180);
// Hovering area below this, in mm², is noise and never reported.
export const HOVER_FLOOR = 1;
// The footprint slack never exceeds this (mm): well under a first layer, and under the
// smallest hover worth reporting, so a tall piece is judged the way a short one is.
export const MAX_BED_EPS = 0.05;

/**
 * @param {{ positions: ArrayLike<number>, indices?: ArrayLike<number>, triangles: number }} mesh
 * @param {{ bedZ?: number, bedEps?: number, bedBand?: number }} [opts]
 *   `bedZ` the bed height if the caller already knows the mesh's lowest Z (else
 *   scanned); `bedEps` the footprint slack (default 0.1% of the mesh height, floored at
 *   0.01 mm and capped at MAX_BED_EPS); `bedBand` the height above the bed within which a flat face hovers
 *   (default 1 mm)
 * @returns {{ pct: number, contactArea: number, hoverArea: number, gap: number|null, at: number[]|null }|null}
 *   `pct` 0..100, the share of the near-bed flat underside on the bed; the two areas in
 *   mm²; `gap` how far above the bed the largest hovering face sits, and `at` its
 *   centroid (null when nothing hovers past the floor); null for an empty mesh.
 */
export function bedContact(mesh, { bedZ, bedEps, bedBand = 1 } = {}) {
  const { positions, indices } = mesh;
  const n = indices ? indices.length : positions.length / 3;
  if (n < 3) return null;

  let minZ = Infinity, maxZ = -Infinity;
  if (bedZ === undefined || bedEps === undefined) {
    for (let i = 2; i < positions.length; i += 3) {
      const z = positions[i];
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  const bed = bedZ ?? minZ;
  const eps = bedEps ?? Math.min(MAX_BED_EPS, Math.max(0.01, 1e-3 * (maxZ - minZ)));
  const bandTop = bed + bedBand;

  let contactArea = 0, hoverArea = 0, largest = 0, gap = null, at = null;
  for (let i = 0; i < n; i += 3) {
    const a = (indices ? indices[i] : i) * 3, b = (indices ? indices[i + 1] : i + 1) * 3, c = (indices ? indices[i + 2] : i + 2) * 3;
    const az = positions[a + 2], bz = positions[b + 2], cz = positions[c + 2];
    const cenZ = (az + bz + cz) / 3;
    if (cenZ > bandTop) continue;                                             // above the band: not the underside
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = bz - az;
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nz >= 0) continue;                                                    // not facing down
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) continue;                                                 // degenerate: no normal
    const triArea = len / 2;
    if (-nz / len < FLAT_COS) continue;                                       // slanted: a fillet curl, a cylinder's side
    const lowest = Math.min(az, bz, cz) - bed, highest = Math.max(az, bz, cz) - bed;
    if (highest <= eps) { contactArea += triArea; continue; }                 // the footprint
    if (lowest <= eps) continue;                                              // touching at an edge or vertex: neither
    if (-nz / len < LEVEL_COS) continue;                                      // near level but tilted: a curved surface's facet
    hoverArea += triArea;
    if (triArea > largest) {
      largest = triArea;
      gap = cenZ - bed;
      at = [(positions[a] + positions[b] + positions[c]) / 3,
            (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3,
            cenZ];
    }
  }
  if (hoverArea < HOVER_FLOOR) return { pct: 100, contactArea, hoverArea, gap: null, at: null };
  return { pct: (100 * contactArea) / (contactArea + hoverArea), contactArea, hoverArea, gap, at };
}
