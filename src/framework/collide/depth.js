// How far two placed pieces press into each other: the collision world's depth reading
// (world.depth). Distances (world.distances) are unsigned and read 0 for any overlap; this
// says how much. Pure JS over the indexes' own triangle data (a core index is read through
// its JS twin), so it gives the same answer whether or not the native core is running.
//
// The estimate, in each direction: sample points of one mesh — every vertex, and the
// midpoint of the stretch of each edge that lies inside the other's box — and take the
// largest distance to the other's surface among the samples that lie INSIDE it (a parity
// test, as world.inside uses). The edge stretches are what catch a crossing where no vertex
// of either piece is inside the other (two bars crossed), and a press whose vertices all sit
// on the other's faces (two equal boxes pushed together face on). The answer is the larger
// of the two directions. It is a lower bound on how deep the pieces press, not the distance
// that would separate them; for a press that is small beside the pieces (the case it is for:
// a contact along a sweep) the two agree to within the meshes' faceting.
//
// Cost: one closest-point query per sample inside the other's box, then an inside test per
// sample in order of that distance, deepest first, until one is inside (that one is the
// answer). The inside test is the face's side when the nearest point is a face's foot (read
// against the mesh's winding, its signed volume, once per index) and a parity test only at
// an edge or a corner. A pair whose boxes do not overlap costs nothing.
import { insideShared } from "../oracle/bvh.js";
import { invertRigid, mulMat4 } from "../geometry/pose.js";
import { IDENTITY } from "./motion.js";

/** A depth (mm) at or below this is touching, not pressing in. */
export const TOUCH_TOL_MM = 0.02;

const jsOf = (bvh) => (bvh?.jsIndex ? bvh.jsIndex() : bvh);

function placedBox(box, m) {
  const out = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const x of [box[0], box[3]]) for (const y of [box[1], box[4]]) for (const z of [box[2], box[5]]) {
    const q = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
    for (let j = 0; j < 3; j++) { out[j] = Math.min(out[j], q[j]); out[j + 3] = Math.max(out[j + 3], q[j]); }
  }
  return out;
}

const overlaps = (a, b) => [0, 1, 2].every((j) => a[j] <= b[j + 3] && b[j] <= a[j + 3]);
const inBox = (b, p) => p[0] >= b[0] && p[0] <= b[3] && p[1] >= b[1] && p[1] <= b[4] && p[2] >= b[2] && p[2] <= b[5];

// The part of segment p→q inside box b, as [t0, t1] along it, or null (slab clipping).
function clip(b, p, q) {
  let t0 = 0, t1 = 1;
  for (let j = 0; j < 3; j++) {
    const d = q[j] - p[j];
    if (d === 0) { if (p[j] < b[j] || p[j] > b[j + 3]) return null; continue; }
    let u = (b[j] - p[j]) / d, v = (b[j + 3] - p[j]) / d;
    if (u > v) [u, v] = [v, u];
    if (u > t0) t0 = u;
    if (v < t1) t1 = v;
    if (t0 > t1) return null;
  }
  return [t0, t1];
}

// The sample points of `src` (a JS index) carried by R into the other's frame, inside box b:
// each vertex, and each edge's midpoint within b, once each (a vertex or edge shared by
// several triangles carries to bit-identical coordinates). Flat, 3 per point.
function samples(src, R, b) {
  const V = src.vertices;
  let pts = new Float64Array(3 * 1024), n = 0;
  let table = new Int32Array(4096).fill(-1); // open addressing over point indexes
  const slot = (x, y, z) => {
    const h = (Math.imul(Math.round(x * 4096) | 0, 73856093) ^ Math.imul(Math.round(y * 4096) | 0, 19349663) ^ Math.imul(Math.round(z * 4096) | 0, 83492791)) >>> 0;
    let i = h & (table.length - 1);
    for (;;) {
      const k = table[i];
      if (k === -1 || (pts[3 * k] === x && pts[3 * k + 1] === y && pts[3 * k + 2] === z)) return i;
      i = (i + 1) & (table.length - 1);
    }
  };
  const add = (x, y, z) => {
    const i = slot(x, y, z);
    if (table[i] !== -1) return;
    if (3 * n === pts.length) { const grown = new Float64Array(2 * pts.length); grown.set(pts); pts = grown; }
    pts[3 * n] = x; pts[3 * n + 1] = y; pts[3 * n + 2] = z;
    table[i] = n++;
    if (2 * n > table.length) { // keep the table at most half full
      table = new Int32Array(2 * table.length).fill(-1);
      for (let k = 0; k < n; k++) table[slot(pts[3 * k], pts[3 * k + 1], pts[3 * k + 2])] = k;
    }
  };
  const tri = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let o = 0; o < V.length; o += 9) {
    for (let k = 0; k < 3; k++) {
      const x = V[o + 3 * k], y = V[o + 3 * k + 1], z = V[o + 3 * k + 2], t = tri[k];
      t[0] = R[0] * x + R[4] * y + R[8] * z + R[12];
      t[1] = R[1] * x + R[5] * y + R[9] * z + R[13];
      t[2] = R[2] * x + R[6] * y + R[10] * z + R[14];
    }
    for (let k = 0; k < 3; k++) {
      const p = tri[k], q = tri[(k + 1) % 3];
      if (inBox(b, p)) add(p[0], p[1], p[2]);
      const s = clip(b, p, q);
      if (!s) continue;
      const t = (s[0] + s[1]) / 2;
      add(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t);
    }
  }
  return pts.subarray(0, 3 * n);
}

// +1 when a JS index's triangles wind outward (positive signed volume), -1 inward, 0 for
// no volume. Read once per index.
const WINDING = new WeakMap();
function windingOf(ix) {
  let w = WINDING.get(ix);
  if (w !== undefined) return w;
  const V = ix.vertices;
  let vol = 0;
  for (let o = 0; o < V.length; o += 9) {
    const ax = V[o], ay = V[o + 1], az = V[o + 2], bx = V[o + 3], by = V[o + 4], bz = V[o + 5], cx = V[o + 6], cy = V[o + 7], cz = V[o + 8];
    vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  w = vol > 0 ? 1 : vol < 0 ? -1 : 0;
  WINDING.set(ix, w);
  return w;
}

// Whether point p, whose nearest surface point is q on triangle `tri` of `dst`, is inside
// dst. When p - q runs along the triangle's normal (q is p's foot on that face), the side of
// the face decides it, read against the mesh's winding; otherwise (q on an edge or a corner,
// where one face's normal says nothing) a parity test does.
function isInside(dst, wind, p, q, tri) {
  if (wind !== 0) {
    const V = dst.vertices, o = tri * 9;
    const ux = V[o + 3] - V[o], uy = V[o + 4] - V[o + 1], uz = V[o + 5] - V[o + 2];
    const vx = V[o + 6] - V[o], vy = V[o + 7] - V[o + 1], vz = V[o + 8] - V[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const dx = p[0] - q[0], dy = p[1] - q[1], dz = p[2] - q[2];
    const nn = Math.hypot(nx, ny, nz), dd = Math.hypot(dx, dy, dz);
    const along = nn > 0 && dd > 0 ? (nx * dx + ny * dy + nz * dz) / (nn * dd) : 0;
    if (Math.abs(along) > 1 - 1e-9) return along * wind < 0;
  }
  return insideShared(dst, p, IDENTITY);
}

// The deepest sample of `src` (placed into dst's frame by R) inside `dst`, or `floor` when
// none inside is deeper than it.
function deepestInside(src, dst, dstBox, R, floor) {
  const pts = samples(src, R, dstBox);
  const count = pts.length / 3;
  const near = new Array(count);
  const keep = [];
  for (let i = 0; i < count; i++) {
    const p = [pts[3 * i], pts[3 * i + 1], pts[3 * i + 2]];
    const c = dst.closestPoint(p);
    near[i] = { p, c };
    if (c.dist > floor) keep.push(i);
  }
  keep.sort((x, y) => near[y].c.dist - near[x].c.dist);
  const wind = windingOf(dst);
  for (const i of keep) {
    const { p, c } = near[i];
    if (isInside(dst, wind, p, c.point, c.tri)) return c.dist;
  }
  return floor;
}

/**
 * How far (mm) mesh A (index bvhA, own-frame box boxA) placed by ma presses into mesh B
 * placed by mb: 0 when apart, about 0 when touching (at or below TOUCH_TOL_MM).
 */
export function penetrationDepth(bvhA, boxA, ma, bvhB, boxB, mb) {
  if (!boxA || !boxB || !overlaps(placedBox(boxA, ma), placedBox(boxB, mb))) return 0;
  const A = jsOf(bvhA), B = jsOf(bvhB);
  const aInB = mulMat4(invertRigid(mb), ma), bInA = mulMat4(invertRigid(ma), mb);
  const ab = deepestInside(A, B, boxB, aInB, 0);
  return deepestInside(B, A, boxA, bInA, ab);
}
