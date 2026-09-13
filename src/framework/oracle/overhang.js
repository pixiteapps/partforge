// src/framework/oracle/overhang.js
// Unsupported downward-facing surface, for a part oriented for a print bed.
//
// One pass over the triangles, pure, no BVH and no rays — cheap enough to run on
// the quick lap alongside bbox and volume, and deliberately NOT sampled the way
// min-wall.js is: a sampled minimum degrades to an honest upper bound, but a
// sampled AREA is an estimate that would flicker either side of the warning
// floor between identical laps. Measured at ~13 ms on a 400k-triangle soup before
// the prefilter below, under `meshArea`'s own cost.
//
// A face is an overhang when its outward normal points down more steeply than
// the process allows: the angle is measured FROM VERTICAL, so a wall reads 0°,
// a 45° chamfer 45°, a ceiling 90°, and a face counts when its angle exceeds
// `maxAngle` (FDM's usual 45) by more than ANGLE_EPS — a chamfer authored AT the
// angle must not warn, and float32 positions perturb a computed normal by ~1e-6,
// which is a thousandth of a degree, not the nanodegree a sine-space epsilon
// would allow (measured: a 45° underside fired on 32 of 40 Z-rotations before
// the tolerance moved into angle space).
//
// Two bands of faces are excluded, both against the bed — the MESH's own lowest
// Z rather than z = 0, so an assembly's sub-parts are each judged as printed
// separately on their own base:
//   - the footprint: faces with every vertex within `bedEps` of the bed. The
//     slack scales with the part (0.1% of its height, floored at 10 µm) because a
//     single boolean-noise vertex a few microns low, or a 0.001° tilt, would
//     otherwise lift the entire bottom face off the bed and report it as a 90°
//     ceiling (measured on a 60×60×5 plate: 3600 mm² of false overhang either way).
//   - the near-bed band: faces whose centroid sits within `bedBand` (1 mm) of the
//     bed. That is the lower curl of a bottom-edge fillet or chamfer — a 20×20×5
//     plate with r=1 fillets carried 58 mm² of "overhang" there, and every FDM
//     printer lays those first layers down fine. A real ceiling under 1 mm of
//     clearance is missed by the same rule; that gap is not printable anyway.
//
// Known limit, stated rather than hidden: a bridge (a flat underside spanning two
// supports) is geometrically a ceiling, and the mesh alone cannot tell the two
// apart, so it is reported as an overhang. That is why this fact backs a WARNING
// and never a gate. Likewise the ceiling of a horizontal bore counts, which is
// usually what a print-minded author wants told.
//
// Works on both mesh forms the oracle sees (Manifold's 9-floats-per-triangle soup
// and OCCT's indexed vertices), same as min-wall.js.

const DEG = 180 / Math.PI;
// Angle-space tolerance on the threshold (degrees): well above float32 normal
// noise (~1e-3°), far below any angle an author would distinguish.
const ANGLE_EPS = 0.01;
// A face too small to have a trustworthy normal contributes its (negligible) area
// but never the reported worst angle — a float32 sliver's normal is round-off, and
// one such sliver used to report a 90° ceiling on a part with none.
const MIN_ANGLE_AREA = 1e-6; // mm²

/**
 * @param {{ positions: ArrayLike<number>, indices?: ArrayLike<number>, triangles: number }} mesh
 * @param {{ maxAngle?: number, bedZ?: number, bedEps?: number, bedBand?: number }} [opts]
 *   `maxAngle` in degrees from vertical (default 45); `bedZ` the bed height if the
 *   caller already knows the mesh's lowest Z (else scanned); `bedEps` the footprint
 *   slack (default 0.1% of the mesh height, floored at 0.01 mm); `bedBand` the
 *   near-bed band (default 1 mm)
 * @returns {{ area: number, worstAngle: number|null, at: number[]|null }|null}
 *   `area` in mm² of every offending face, `worstAngle` the steepest one found,
 *   `at` the centroid of the largest offending triangle (a place to point at);
 *   null for an empty mesh.
 */
export function overhang(mesh, { maxAngle = 45, bedZ, bedEps, bedBand = 1 } = {}) {
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
  const eps = bedEps ?? Math.max(0.01, 1e-3 * (maxZ - minZ));
  const bandTop = bed + bedBand;

  // Prefilter in sine space, generously: only faces that might exceed the angle
  // pay for the asin. The exact comparison is in degrees.
  const nearLimit = Math.sin(Math.max(0, maxAngle - 1) / DEG);
  let area = 0, worst = -1, largest = 0, at = null;
  for (let i = 0; i < n; i += 3) {
    const a = (indices ? indices[i] : i) * 3, b = (indices ? indices[i + 1] : i + 1) * 3, c = (indices ? indices[i + 2] : i + 2) * 3;
    const az = positions[a + 2], bz = positions[b + 2], cz = positions[c + 2];
    if (az - bed <= eps && bz - bed <= eps && cz - bed <= eps) continue;     // the footprint
    if ((az + bz + cz) / 3 <= bandTop) continue;                              // the near-bed band
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = bz - az;
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nz >= 0) continue;                                                    // not facing down
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) continue;                                                 // degenerate: no normal
    const down = -nz / len;
    if (down <= nearLimit) continue;
    const angle = Math.asin(Math.min(1, down)) * DEG;
    if (angle <= maxAngle + ANGLE_EPS) continue;
    const triArea = len / 2;
    area += triArea;
    if (triArea >= MIN_ANGLE_AREA && angle > worst) worst = angle;
    if (triArea > largest) {
      largest = triArea;
      at = [(positions[a] + positions[b] + positions[c]) / 3,
            (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3,
            (az + bz + cz) / 3];
    }
  }
  return { area, worstAngle: worst < 0 ? null : worst, at };
}
