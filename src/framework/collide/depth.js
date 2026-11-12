// How far two placed pieces press into each other: the collision world's depth reading
// (world.depth). Distances (world.distances) are unsigned and read 0 for any overlap; this
// says how much. Pure JS over the indexes' own triangle data (a core index is read through
// its JS twin), so it gives the same answer whether or not the native core is running.
//
// The estimate, in each direction: sample points of one mesh, and take the largest distance
// to the other's surface among the samples that lie INSIDE it. The samples are every vertex,
// and for each edge, the midpoint of every stretch between the places it crosses the other
// mesh's surface (a ray query along the edge, clipped to the other's box). Those stretches
// are what catch a crossing where no vertex of either piece is inside the other (two bars
// crossed; a bar or pin ploughing through two walls or knuckles of ONE mesh, where one
// midpoint of the edge would land in the gap between them), and a press whose vertices all
// sit on the other's faces (two equal boxes pushed together face on). The answer is the
// larger of the two directions. It is a lower bound on how deep the pieces press, not the
// distance that would separate them; for a press that is small beside the pieces (the case
// it is for: a contact along a sweep) the two agree to within the meshes' faceting. Known
// limit: a press whose deepest point is inside a coarse face, with no vertex there and no
// edge of either mesh crossing the other near it, reads only as deep as the samples it has.
//
// The inside test is the face's side when the nearest surface point is a face's foot, read
// against the mesh's winding (its signed volume, once per index), so it assumes each mesh is
// consistently wound (kernel output is); at an edge or a corner, and on a mesh with no
// volume, it is a parity test as world.inside uses.
//
// Cost: a pair whose boxes do not overlap costs nothing, and one whose surfaces neither
// touch nor nest one in the other costs a distance check (0). Otherwise one ray query per
// edge through the other's box, and per sample a nearest-point query capped at the best
// depth found so far (a sample with surface that near cannot raise it), then, for the rest,
// the full query and the inside test.
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

// A set of k-tuples of numbers (exact equality), open-addressed: add() says whether new.
function tupleSet(k) {
  let keys = new Float64Array(k * 1024), n = 0;
  let table = new Int32Array(4096).fill(-1);
  const hashAt = (src, o) => {
    let h = 0;
    for (let j = 0; j < k; j++) h = Math.imul(h ^ (Math.round(src[o + j] * 4096) | 0), 0x9e3779b1);
    return h >>> 0;
  };
  const same = (i, src, o) => { for (let j = 0; j < k; j++) if (keys[k * i + j] !== src[o + j]) return false; return true; };
  const slot = (src, o) => {
    let i = hashAt(src, o) & (table.length - 1);
    for (;;) {
      const e = table[i];
      if (e === -1 || same(e, src, o)) return i;
      i = (i + 1) & (table.length - 1);
    }
  };
  return {
    add(src, o = 0) {
      const i = slot(src, o);
      if (table[i] !== -1) return false;
      if (k * n === keys.length) { const g = new Float64Array(2 * keys.length); g.set(keys); keys = g; }
      for (let j = 0; j < k; j++) keys[k * n + j] = src[o + j];
      table[i] = n++;
      if (2 * n > table.length) { // keep the table at most half full
        table = new Int32Array(2 * table.length).fill(-1);
        for (let e = 0; e < n; e++) table[slot(keys, k * e)] = e;
      }
      return true;
    },
  };
}

// Ray steps past a hit (in units of the edge's length): past rounding, never past a
// neighbouring hit that matters (two hits this close bound no stretch worth sampling).
const STEP_T = 1e-9;
const MAX_HITS = 256;
// How finely the depth is resolved (mm): a sample deeper than the best so far by less than
// this is not looked at again. Far under TOUCH_TOL_MM and any mesh's faceting.
const DEPTH_RES_MM = 1e-4;

// The sample points of `src` (a JS index) carried by R into dst's frame, inside dst's box b:
// each vertex once, and for each edge once, the midpoint of every stretch of its part inside
// b between consecutive crossings of dst's surface.
function samples(src, dst, R, b) {
  const V = src.vertices;
  const pointSeen = tupleSet(3), edgeSeen = tupleSet(6);
  const out = [];
  const add = (p) => { if (pointSeen.add(p)) out.push(p); };
  const tri = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const edge = new Float64Array(6);
  for (let o = 0; o < V.length; o += 9) {
    for (let k = 0; k < 3; k++) {
      const x = V[o + 3 * k], y = V[o + 3 * k + 1], z = V[o + 3 * k + 2], t = tri[k];
      t[0] = R[0] * x + R[4] * y + R[8] * z + R[12];
      t[1] = R[1] * x + R[5] * y + R[9] * z + R[13];
      t[2] = R[2] * x + R[6] * y + R[10] * z + R[14];
    }
    for (let k = 0; k < 3; k++) {
      let p = tri[k], q = tri[(k + 1) % 3];
      if (inBox(b, p)) add([p[0], p[1], p[2]]);
      // one direction per edge, whichever triangle meets it first
      if (p[0] > q[0] || (p[0] === q[0] && (p[1] > q[1] || (p[1] === q[1] && p[2] > q[2])))) [p, q] = [q, p];
      edge[0] = p[0]; edge[1] = p[1]; edge[2] = p[2]; edge[3] = q[0]; edge[4] = q[1]; edge[5] = q[2];
      const s = clip(b, p, q);
      if (!s || !edgeSeen.add(edge)) continue;
      const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
      const at = (t) => [p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t];
      let from = s[0], tMin = s[0];
      for (let h = 0; h < MAX_HITS; h++) {
        const hit = dst.raycast(p, d, { tMin, tMax: s[1] });
        if (!hit) break;
        if (hit.t - from > STEP_T) add(at((from + hit.t) / 2));
        from = hit.t;
        tMin = hit.t + STEP_T;
      }
      if (s[1] - from > STEP_T || from === s[0]) add(at((from + s[1]) / 2));
    }
  }
  return out;
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
  const wind = windingOf(dst);
  let best = floor;
  for (const p of samples(src, dst, R, dstBox)) {
    // surface within reach of best: this sample cannot raise it by more than DEPTH_RES_MM
    if (best > 0 && dst.closestPoint(p, best + DEPTH_RES_MM).tri !== -1) continue;
    const c = dst.closestPoint(p);
    if (c.dist > best && isInside(dst, wind, p, c.point, c.tri)) best = c.dist;
  }
  return best;
}

/**
 * How far (mm) mesh A (index bvhA, own-frame box boxA) placed by ma presses into mesh B
 * placed by mb: 0 when apart, about 0 when touching (at or below TOUCH_TOL_MM).
 */
export function penetrationDepth(bvhA, boxA, ma, bvhB, boxB, mb) {
  if (!boxA || !boxB || !overlaps(placedBox(boxA, ma), placedBox(boxB, mb))) return 0;
  const A = jsOf(bvhA), B = jsOf(bvhB);
  // surfaces that neither touch nor cross: apart, unless one is wholly inside the other
  if (!A.withinDistancePosed(B, ma, mb, 0) && !A.insideOf(B, ma, mb) && !B.insideOf(A, mb, ma)) return 0;
  const aInB = mulMat4(invertRigid(mb), ma), bInA = mulMat4(invertRigid(ma), mb);
  const ab = deepestInside(A, B, boxB, aInB, 0);
  return deepestInside(B, A, boxA, bInA, ab);
}
