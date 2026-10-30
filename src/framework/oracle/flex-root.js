// src/framework/oracle/flex-root.js
// A flexing member, read off the mesh: how it meets the rest of its part, how big it is,
// and how it lies on the print bed.
//
// The failure this exists for: a snap arm, a buckle prong, a clip or a cantilever tab
// joined to its body at a sharp inside corner. Bending concentrates the stress at the
// root, and a sharp inside corner multiplies it several times over, so the member snaps
// there — often on the first flex, in FDM plastic whose layer bonds are weakest across
// exactly that corner. Seen on a real forge: a side-release buckle whose prongs, each a
// 2 mm prism unioned onto the base, broke off flush with the base face. A fillet at the
// root of about half the member's thickness spreads the stress and is what fixes it —
// and the three other ways such a member fails read off the same labelled triangles:
// too much strain for its length (verify's flexStrain, from a declared deflection),
// printed standing so the layers stack across its root (flexTilt), and thinner than
// the process prints (minWall, already).
//
// A mesh cannot tell a member that bends from a wall, a rib, a tooth or a pin — every
// one of them is a thin feature joined at a sharp corner, and a shape-only detector
// flagged most parts it was tried on. So the part SAYS which members flex
// (`verify.flex`, by feature label), and this reads only those: every edge where a
// triangle of the member meets a triangle of anything else. A root is sharp where that
// edge is concave and turns by more than SHARP_DEG. A fillet's own faces are new,
// unlabelled surfaces (or the sub-part's), and a tessellated fillet turns by a few
// degrees per facet, tangent where it meets the member and the body — so a filleted
// root reads clean, and so does a member whose faces only continue coplanar into the
// body (its top face flush with the base's top).
//
// THE ROOT RADIUS. A fillet tangent to the member's face is a circle through the
// member's boundary (where its label ends), tangent to the face there. A ray from that
// boundary, parallel to the face and lifted a small ε off it into the air, meets the
// fillet at the point where the arc has risen ε off the face: the chord from the tangent
// point to that hit is 2·r·sin(φ/2), and 2·r·(1 − cos φ) = ε, so r = chord² / (2·ε),
// exact on a circle and read off the member and the air alone — whatever the fillet's
// tessellation (mesh-fillet starts its arc past an extension sliver on the face plane, so
// nothing about the first chord row can be trusted), and whatever angle the body meets
// the member at. A root that continues flush meets nothing: it reads as the ray's reach.
// A sharp edge is r = 0; the member's radius is a low quantile, by length, of its
// boundary's readings (a corner patch reads noisily), and 0 wherever ROOT_FLOOR of
// sharp root exists at all. The rays are few — one per boundary edge, a handful per
// member — and are tested against the triangles their segments' box reaches, no index.
//
// One pass over the triangles to weld edges, pure, no BVH. Works on both mesh forms the
// oracle sees (Manifold's soup, OCCT's indexed vertices) — but only on a mesh carrying
// `featureIds`/`features` (the feature labels), which both backends attach.
//
// The declaration itself (`verify.flex` → member records) is flex-members.js, a leaf
// the linter shares; this module is the reading, loaded with the rest of the oracle.
//
// Known limits, stated: an inside corner WITHIN one label (the member and its body
// labelled alike, or a barb's own notch) is invisible — label the flexing member apart
// from the body it grows from. A label that covers the whole sub-part, or a member that
// never touches the rest of it, therefore has NO root to read: that is `attached` false,
// which verify withholds a verdict on rather than passing (a clean root and no root
// must never read alike). And a feature touching the member (a grip rib on the arm)
// counts as "the rest of the part", so its corners read as roots unless it is listed
// with the member: `flex: [["Arm", "Arm rib"]]` treats the group as one member.

// A concave edge turning more than this (degrees) is a sharp corner. A tessellated
// fillet turns a few degrees per facet (3.1° per step at the preview's 116 segments;
// 22.5° at mesh-fillet's 16-segment floor for radii under 1 mm, and the boundary edge
// turns half of one), a 45° chamfer turns 45° twice — a chamfer is a corner too, if a
// softer one.
export const SHARP_DEG = 30;
const SHARP_COS = Math.cos((SHARP_DEG * Math.PI) / 180);
// A concave edge turning less than this (degrees) is flush: a face continuing into the
// body, not a fillet's first chord. Below it the chord formula divides by ~0.
export const FLUSH_DEG = 0.25;
const FLUSH_COS = Math.cos((FLUSH_DEG * Math.PI) / 180);
// Sharp root edges shorter than this in total (mm) are boolean noise, never reported.
export const ROOT_FLOOR = 0.1;
// The radius reported is the reading this share of the rounded boundary's length sits
// under — a low quantile, so a noisy corner patch neither sets nor hides it.
const RADIUS_QUANTILE = 0.1;
// A root ray is followed this many member thicknesses (at least RAY_MIN mm): a fillet
// larger than that passes any ratio a profile asks for, and reads as that length.
const RAY_REACH = 10, RAY_MIN = 2;
// The ray's lift off the member's face, as a share of its thickness (at least LIFT_MIN
// mm): small against any fillet worth having, large against a chord's sagitta.
const LIFT = 0.05, LIFT_MIN = 0.02;
// Hits closer than this (mm) are the ray's own edge.
const HIT_EPS = 1e-4;

// Möller–Trumbore: the distance along the ray (o, d) to triangle (a, b, c), or null.
function rayTri(P, o, d, a, b, c) {
  const e1x = P[b * 3] - P[a * 3], e1y = P[b * 3 + 1] - P[a * 3 + 1], e1z = P[b * 3 + 2] - P[a * 3 + 2];
  const e2x = P[c * 3] - P[a * 3], e2y = P[c * 3 + 1] - P[a * 3 + 1], e2z = P[c * 3 + 2] - P[a * 3 + 2];
  const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const tx = o[0] - P[a * 3], ty = o[1] - P[a * 3 + 1], tz = o[2] - P[a * 3 + 2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -1e-9 || u > 1 + 1e-9) return null;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < -1e-9 || u + v > 1 + 1e-9) return null;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > HIT_EPS ? t : null;
}

// The eigenvectors of a symmetric 3×3 (cyclic Jacobi), columns of `v`, with the
// eigenvalues in `w` — a handful of sweeps on a 3×3 converges to machine precision.
function eigen3(m) {
  const a = m.map((r) => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 32; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
    if (off < 1e-24) break;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return { w: [a[0][0], a[1][1], a[2][2]], v };
}

// The member's size along its own axes: the principal axes of its vertices, and the
// extent of the vertices along each — `length` the largest, `thickness` the smallest
// (the direction a cantilever bends in), `axis` the unit direction of the largest.
function extents(P, verts) {
  const n = verts.length;
  if (n < 3) return { length: 0, thickness: 0, axis: null };
  const c = [0, 0, 0];
  for (const i of verts) for (let k = 0; k < 3; k++) c[k] += P[i * 3 + k] / n;
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const i of verts) {
    const d = [P[i * 3] - c[0], P[i * 3 + 1] - c[1], P[i * 3 + 2] - c[2]];
    for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) cov[r][s] += d[r] * d[s];
  }
  const { w, v } = eigen3(cov);
  const order = [0, 1, 2].sort((i, j) => w[j] - w[i]);
  const ext = order.map((col) => {
    const ax = [v[0][col], v[1][col], v[2][col]];
    let lo = Infinity, hi = -Infinity;
    for (const i of verts) {
      const s = ax[0] * P[i * 3] + ax[1] * P[i * 3 + 1] + ax[2] * P[i * 3 + 2];
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    return { ax, size: hi - lo };
  });
  return { length: ext[0].size, thickness: ext[2].size, axis: ext[0].ax };
}

/**
 * @param {{ positions: ArrayLike<number>, indices?: ArrayLike<number>, featureIds?: ArrayLike<number>, features?: string[] }} mesh
 * @param {string[]} group the labels making up one flexing member
 * @param {{ printMatrix?: number[]|null }} [opts] the display→print mat4 (column-major,
 *   pose.js) the member is posed by for `tilt`; null when the display pose is the print pose
 * @returns {{ found: boolean, attached: boolean, sharpLength: number, maxTurn: number|null, at: number[]|null,
 *   rootRadius: number|null, thickness: number, length: number, axis: number[]|null, tilt: number|null }}
 *   `found` false when no triangle carries any of the labels (the check cannot run);
 *   `attached` false when the member shares no edge with the rest of the mesh (nothing
 *   to read either — the label covers everything, or the member touches nothing);
 *   `sharpLength` the total length (mm) of sharp concave root edges, 0 under ROOT_FLOOR;
 *   `maxTurn` the sharpest such edge's turn in degrees and `at` the midpoint of the
 *   longest one (both null when the root is clean);
 *   `rootRadius` the root's fillet radius in mm — 0 when any of it is sharp, null when
 *   the member meets the body flush everywhere (no inside corner at all);
 *   `thickness`, `length`, `axis` the member's own extents and long direction;
 *   `tilt` the degrees that direction rises off the print bed (0 lying flat, 90
 *   standing), in the print pose.
 */
export function flexRoot(mesh, group, { printMatrix = null } = {}) {
  const { positions: P, indices: I, featureIds, features } = mesh;
  const none = { found: false, attached: false, sharpLength: 0, maxTurn: null, at: null, rootRadius: null, thickness: 0, length: 0, axis: null, tilt: null };
  const ids = new Set();
  if (featureIds && features) features.forEach((f, i) => { if (group.includes(f)) ids.add(i + 1); });
  if (!ids.size) return none;
  const nTri = I ? I.length / 3 : P.length / 9;
  const vi = (t, j) => (I ? I[t * 3 + j] : t * 3 + j);
  const key = (i) => `${Math.round(P[i * 3] * 1e4)},${Math.round(P[i * 3 + 1] * 1e4)},${Math.round(P[i * 3 + 2] * 1e4)}`;

  // Normals, areas and centroids, and every edge of a member triangle, keyed by welded endpoints.
  const inMember = (t) => ids.has(featureIds[t]);
  const normal = new Float64Array(nTri * 3), cent = new Float64Array(nTri * 3), area2 = new Float64Array(nTri);
  const edges = new Map(); // key -> { a, b, tris: [] }
  const tri = (t) => [vi(t, 0), vi(t, 1), vi(t, 2)];
  for (let t = 0; t < nTri; t++) {
    const [a, b, c] = tri(t);
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    area2[t] = len;                                               // twice the area
    normal[t * 3] = nx / len; normal[t * 3 + 1] = ny / len; normal[t * 3 + 2] = nz / len;
    for (let k = 0; k < 3; k++) cent[t * 3 + k] = (P[a * 3 + k] + P[b * 3 + k] + P[c * 3 + k]) / 3;
  }
  // Only edges touching a member triangle matter; register those first, then let any
  // triangle sharing such an edge join it. The member's welded vertices feed its extents.
  const keys = [];
  const memberVerts = new Map();                                  // welded key -> index
  for (let t = 0; t < nTri; t++) {
    const v = tri(t);
    keys.push(v.map(key));
    if (!inMember(t)) continue;
    for (let j = 0; j < 3; j++) {
      if (!memberVerts.has(keys[t][j])) memberVerts.set(keys[t][j], v[j]);
      const ka = keys[t][j], kb = keys[t][(j + 1) % 3];
      const ek = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      if (!edges.has(ek)) edges.set(ek, { a: v[j], b: v[(j + 1) % 3], tris: [] });
    }
  }
  for (let t = 0; t < nTri; t++) {
    for (let j = 0; j < 3; j++) {
      const ka = keys[t][j], kb = keys[t][(j + 1) % 3];
      const e = edges.get(ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`);
      if (e) e.tris.push(t);
    }
  }

  let sharpLength = 0, maxTurn = null, longest = 0, at = null, attached = false;
  const starts = [];                                              // rounded boundary edges: a root ray each
  for (const e of edges.values()) {
    if (e.tris.length !== 2) continue;
    const [t1, t2] = e.tris;
    if (inMember(t1) === inMember(t2)) continue;                  // inside the member, or not on it
    attached = true;                                              // a boundary, at any turn
    const d = normal[t1 * 3] * normal[t2 * 3] + normal[t1 * 3 + 1] * normal[t2 * 3 + 1] + normal[t1 * 3 + 2] * normal[t2 * 3 + 2];
    const mx = (P[e.a * 3] + P[e.b * 3]) / 2, my = (P[e.a * 3 + 1] + P[e.b * 3 + 1]) / 2, mz = (P[e.a * 3 + 2] + P[e.b * 3 + 2]) / 2;
    // Concave: the second triangle lies in front of the first one's face. Flush (the
    // face continuing into the body, or mesh-fillet's extension sliver on it) is neither.
    const front = normal[t1 * 3] * (cent[t2 * 3] - mx) + normal[t1 * 3 + 1] * (cent[t2 * 3 + 1] - my) + normal[t1 * 3 + 2] * (cent[t2 * 3 + 2] - mz);
    const flush = d > FLUSH_COS;
    if (!flush && front <= 1e-9) continue;                        // convex: an outside edge
    const len = Math.hypot(P[e.a * 3] - P[e.b * 3], P[e.a * 3 + 1] - P[e.b * 3 + 1], P[e.a * 3 + 2] - P[e.b * 3 + 2]);
    if (!(len > 0)) continue;
    if (flush || d > SHARP_COS) {                                 // rounded or flush: a root ray
      const tm = inMember(t1) ? t1 : t2;
      const nm = [normal[tm * 3], normal[tm * 3 + 1], normal[tm * 3 + 2]];
      // In the member face's plane, perpendicular to the edge, away from the member:
      // n × e, flipped if it points at the triangle's own centroid.
      const ex = (P[e.b * 3] - P[e.a * 3]) / len, ey = (P[e.b * 3 + 1] - P[e.a * 3 + 1]) / len, ez = (P[e.b * 3 + 2] - P[e.a * 3 + 2]) / len;
      let dx = nm[1] * ez - nm[2] * ey, dy = nm[2] * ex - nm[0] * ez, dz = nm[0] * ey - nm[1] * ex;
      if (dx * (cent[tm * 3] - mx) + dy * (cent[tm * 3 + 1] - my) + dz * (cent[tm * 3 + 2] - mz) > 0) { dx = -dx; dy = -dy; dz = -dz; }
      starts.push({ o: [mx, my, mz], d: [dx, dy, dz], n: nm, len });
      continue;
    }
    const turn = (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
    sharpLength += len;
    if (maxTurn == null || turn > maxTurn) maxTurn = turn;
    if (len > longest) { longest = len; at = [mx, my, mz]; }
  }
  const size = extents(P, [...memberVerts.values()]);
  let tilt = null;
  if (size.axis) {
    const [x, y, z] = size.axis, m = printMatrix;
    const pz = m ? m[2] * x + m[6] * y + m[10] * z : z;
    tilt = (Math.asin(Math.min(1, Math.abs(pz))) * 180) / Math.PI;
  }
  const base = { found: true, attached, thickness: size.thickness, length: size.length, axis: size.axis, tilt };
  if (!attached) return { ...base, sharpLength: 0, maxTurn: null, at: null, rootRadius: null };
  if (sharpLength >= ROOT_FLOOR) return { ...base, sharpLength, maxTurn, at, rootRadius: 0 };
  let rootRadius = null;
  if (starts.length) {
    const reach = Math.max(RAY_REACH * size.thickness, RAY_MIN);
    const lift = Math.max(LIFT * size.thickness, LIFT_MIN);
    // The non-member triangles any ray's segment box reaches, gathered once.
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const { o, d, n } of starts) for (let k = 0; k < 3; k++) {
      const a = o[k] + n[k] * lift;
      lo[k] = Math.min(lo[k], a, a + d[k] * reach); hi[k] = Math.max(hi[k], a, a + d[k] * reach);
    }
    const near = [];
    for (let t = 0; t < nTri; t++) {
      if (inMember(t)) continue;
      const [a, b, c] = tri(t);
      let out = false;
      for (let k = 0; k < 3 && !out; k++) {
        const x = Math.min(P[a * 3 + k], P[b * 3 + k], P[c * 3 + k]), y = Math.max(P[a * 3 + k], P[b * 3 + k], P[c * 3 + k]);
        out = y < lo[k] - 1e-6 || x > hi[k] + 1e-6;
      }
      if (!out) near.push(t);
    }
    const readings = [];                                          // [radius, length]
    for (const { o, d, n, len } of starts) {
      const origin = [o[0] + n[0] * lift, o[1] + n[1] * lift, o[2] + n[2] * lift];
      let best = Infinity;
      for (const t of near) {
        const [a, b, c] = tri(t);
        const dist = rayTri(P, origin, d, a, b, c);
        if (dist != null && dist < best) best = dist;
      }
      // chord² = s² + lift², and 2·r·lift = chord² on the circle tangent at the boundary.
      readings.push([best > reach ? reach : Math.min(reach, (best * best + lift * lift) / (2 * lift)), len]);
    }
    readings.sort((p, q) => p[0] - q[0]);
    const total = readings.reduce((s, [, l]) => s + l, 0);
    let acc = 0;
    for (const [r, l] of readings) { acc += l; rootRadius = r; if (acc >= RADIUS_QUANTILE * total) break; }
  }
  return { ...base, sharpLength: 0, maxTurn: null, at: null, rootRadius };
}
