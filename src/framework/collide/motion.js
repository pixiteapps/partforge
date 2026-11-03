// Rigid-motion helpers the collision world and the drag guard share. An import-free leaf,
// so the guard can use them without loading the world (and with it the BVH).
// Matrices are column-major mat4s; `undefined` is the identity (world.js's mats contract).

export const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Point [x, y, z] placed by m (undefined: identity). */
export const applyMat = (m, [x, y, z]) => (m ? [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
] : [x, y, z]);

/**
 * The farthest a corner of `box` ([minx, miny, minz, maxx, maxy, maxz]) moves placed by m1
 * instead of m0 — the farthest any point inside it moves, since a point's motion is affine
 * and a box's worst is at a corner. A missing box bounds nothing: Infinity.
 */
export function cornerTravel(box, m0, m1) {
  if (!box) return Infinity;
  let worst = 0;
  for (const x of [box[0], box[3]]) for (const y of [box[1], box[4]]) for (const z of [box[2], box[5]]) {
    const p = applyMat(m0, [x, y, z]), q = applyMat(m1, [x, y, z]);
    worst = Math.max(worst, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
  }
  return worst;
}
