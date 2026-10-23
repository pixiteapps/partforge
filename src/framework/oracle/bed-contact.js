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
// The silhouette raster (the footprint's denominator): the finest cell pitch (mm), and
// the most cells along the longer side — so a large piece costs a 512×512 bitmap at most.
const SILHOUETTE_MIN_PITCH = 0.25;
const SILHOUETTE_CELLS = 512;

// Mark one downward triangle's xy shadow on the silhouette grid: every cell whose centre
// lies inside it. A triangle too thin to contain any centre (a wall thinner than a cell)
// marks the cells along its outline instead (sampled at half a pitch), so it is never
// dropped between centres. Marking edge cells for EVERY triangle was tried and
// over-covered a 1 mm tube wall by a third; centre sampling is unbiased along an edge.
function shadow(P, a, b, c, minX, minY, pitch, gx, gy, grid, mark) {
  const ax = P[a], ay = P[a + 1], bx = P[b], by = P[b + 1], cx = P[c], cy = P[c + 1];
  const area2 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  let hit = false;
  if (area2 !== 0) {
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - minX) / pitch));
    const i1 = Math.min(gx - 1, Math.floor((Math.max(ax, bx, cx) - minX) / pitch));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - minY) / pitch));
    const j1 = Math.min(gy - 1, Math.floor((Math.max(ay, by, cy) - minY) / pitch));
    const sgn = area2 > 0 ? 1 : -1;
    for (let j = j0; j <= j1; j++) {
      const y = minY + (j + 0.5) * pitch;
      for (let i = i0; i <= i1; i++) {
        const x = minX + (i + 0.5) * pitch;
        const w0 = ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) * sgn;
        const w1 = ((cx - bx) * (y - by) - (cy - by) * (x - bx)) * sgn;
        const w2 = ((ax - cx) * (y - cy) - (ay - cy) * (x - cx)) * sgn;
        if (w0 >= 0 && w1 >= 0 && w2 >= 0) { grid[j * gx + i] = 1; hit = true; }
      }
    }
  }
  if (hit) return;
  // The fallback samples the triangle shrunk by half toward its centroid, not its own
  // edges: a fan sliver of a disc's bottom then marks cells inside the disc, never the
  // cells its rim crosses (which over-covered a Ø5 pin by a tenth).
  const gxc = (ax + bx + cx) / 3, gyc = (ay + by + cy) / 3;
  const h = ([x, y]) => [(x + gxc) / 2, (y + gyc) / 2];
  const [pa, pb, pc] = [h([ax, ay]), h([bx, by]), h([cx, cy])];
  for (const [x0, y0, x1, y1] of [[...pa, ...pb], [...pb, ...pc], [...pc, ...pa]]) {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (pitch / 2)) + 1;
    for (let t = 0; t <= steps; t++) mark(x0 + ((x1 - x0) * t) / steps, y0 + ((y1 - y0) * t) / steps);
  }
}

/**
 * @param {{ positions: ArrayLike<number>, indices?: ArrayLike<number>, triangles: number }} mesh
 * @param {{ bedZ?: number, bedEps?: number, bedBand?: number }} [opts]
 *   `bedZ` the bed height if the caller already knows the mesh's lowest Z (else
 *   scanned); `bedEps` the footprint slack (default 0.1% of the mesh height, floored at
 *   0.01 mm and capped at MAX_BED_EPS); `bedBand` the height above the bed within which a flat face hovers
 *   (default 1 mm)
 * @returns {{ pct: number, contactArea: number, hoverArea: number, downArea: number, gap: number|null, at: number[]|null, base: number[], lowestAt: number[] }|null}
 *   `pct` 0..100, the share of the near-bed flat underside on the bed; the two areas in
 *   mm²; `gap` how far above the bed the largest hovering face sits, and `at` its
 *   centroid (null when nothing hovers past the floor); `downArea` the piece's
 *   silhouette on the bed (mm²): the UNION of every downward-facing triangle's shadow,
 *   rasterized (a closed mesh's silhouette is exactly that union, since every point of
 *   it has a bottom-most face, which faces down), and
 *   `lowestAt` the mesh's lowest vertex — measure.js's footprint cost, the contact area
 *   over `downArea`, catches what `pct` cannot: a piece with almost no flat underside
 *   at all (a sphere-tipped rod on its end) hovers nothing and reads 100. `base`, the
 *   mesh's [dx, dy] extent, is reported but no longer divided by: a tube on its rim, a
 *   frame or a diagonal bar fills little of its bounding box yet stands on all of its
 *   underside. Null for an empty mesh.
 */
export function bedContact(mesh, { bedZ, bedEps, bedBand = 1 } = {}) {
  const { positions, indices } = mesh;
  const n = indices ? indices.length : positions.length / 3;
  if (n < 3) return null;

  // One scan for the extents: the bed (lowest Z) and the slack's height when the caller
  // did not hand them in, and always the posed base (its xy extent, reported) and the
  // lowest vertex (where the footprint cost is located).
  let minZ = Infinity, maxZ = -Infinity, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, low = 0;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) { minZ = z; low = i; }
    if (z > maxZ) maxZ = z;
  }
  const base = [maxX - minX, maxY - minY];
  const lowestAt = [positions[low], positions[low + 1], positions[low + 2]];
  const bed = bedZ ?? minZ;
  const eps = bedEps ?? Math.min(MAX_BED_EPS, Math.max(0.01, 1e-3 * (maxZ - minZ)));
  const bandTop = bed + bedBand;
  // The silhouette raster: an xy grid over the base, at most ~512 cells a side.
  const pitch = Math.max(SILHOUETTE_MIN_PITCH, Math.max(base[0], base[1]) / SILHOUETTE_CELLS);
  const gx = Math.max(1, Math.ceil(base[0] / pitch) + 1), gy = Math.max(1, Math.ceil(base[1] / pitch) + 1);
  const grid = new Uint8Array(gx * gy);
  const mark = (x, y) => {
    const i = Math.min(gx - 1, Math.max(0, Math.floor((x - minX) / pitch)));
    const j = Math.min(gy - 1, Math.max(0, Math.floor((y - minY) / pitch)));
    grid[j * gx + i] = 1;
  };

  let contactArea = 0, hoverArea = 0, largest = 0, gap = null, at = null;
  for (let i = 0; i < n; i += 3) {
    const a = (indices ? indices[i] : i) * 3, b = (indices ? indices[i + 1] : i + 1) * 3, c = (indices ? indices[i + 2] : i + 2) * 3;
    const az = positions[a + 2], bz = positions[b + 2], cz = positions[c + 2];
    const cenZ = (az + bz + cz) / 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = bz - az;
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nz >= 0) continue;                                                    // not facing down
    shadow(positions, a, b, c, minX, minY, pitch, gx, gy, grid, mark);        // its shadow joins the silhouette
    if (cenZ > bandTop) continue;                                             // above the band: not the underside
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
  let cells = 0;
  for (let i = 0; i < grid.length; i++) cells += grid[i];
  const downArea = cells * pitch * pitch;
  if (hoverArea < HOVER_FLOOR) return { pct: 100, contactArea, hoverArea, downArea, gap: null, at: null, base, lowestAt };
  return { pct: (100 * contactArea) / (contactArea + hoverArea), contactArea, hoverArea, downArea, gap, at, base, lowestAt };
}
