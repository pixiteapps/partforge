// src/framework/oracle/flex-root.js
// Whether a flexing member meets the rest of its part through a rounded root.
//
// The failure this exists for: a snap arm, a buckle prong, a clip or a cantilever tab
// joined to its body at a sharp inside corner. Bending concentrates the stress at the
// root, and a sharp inside corner multiplies it several times over, so the member snaps
// there — often on the first flex, in FDM plastic whose layer bonds are weakest across
// exactly that corner. Seen on a real forge: a side-release buckle whose prongs, each a
// 2 mm prism unioned onto the base, broke off flush with the base face. A fillet at the
// root of about half the member's thickness spreads the stress and is what fixes it.
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
// One pass over the triangles to weld edges, pure, no BVH. Works on both mesh forms the
// oracle sees (Manifold's soup, OCCT's indexed vertices) — but only on a mesh carrying
// `featureIds`/`features` (the feature labels), which both backends attach.
//
// Known limits, stated: an inside corner WITHIN one label (the member and its body
// labelled alike, or a barb's own notch) is invisible — label the flexing member apart
// from the body it grows from. And a feature touching the member (a grip rib on the arm)
// counts as "the rest of the part", so its corners read as roots unless it is listed
// with the member: `flex: [["Arm", "Arm rib"]]` treats the group as one member.

// A concave edge turning more than this (degrees) is a sharp corner. A tessellated
// fillet turns a few degrees per facet (3.1° per step at the preview's 116 segments), a
// 45° chamfer turns 45° twice — a chamfer is a corner too, if a softer one.
export const SHARP_DEG = 30;
const SHARP_COS = Math.cos((SHARP_DEG * Math.PI) / 180);
// Sharp root edges shorter than this in total (mm) are boolean noise, never reported.
export const ROOT_FLOOR = 0.1;

/** The member groups `verify.flex` declares: each entry a label or a list of labels. */
export function flexGroups(flex) {
  if (!Array.isArray(flex)) return [];
  return flex.map((e) => (Array.isArray(e) ? e : [e])).filter((g) => g.length && g.every((l) => typeof l === "string" && l));
}

/** The name a member group is reported under: its first label. */
export const groupName = (group) => group[0];

/**
 * @param {{ positions: ArrayLike<number>, indices?: ArrayLike<number>, featureIds?: ArrayLike<number>, features?: string[] }} mesh
 * @param {string[]} group the labels making up one flexing member
 * @returns {{ found: boolean, sharpLength: number, maxTurn: number|null, at: number[]|null }}
 *   `found` false when no triangle carries any of the labels (the check cannot run);
 *   `sharpLength` the total length (mm) of sharp concave root edges, 0 under ROOT_FLOOR;
 *   `maxTurn` the sharpest such edge's turn in degrees and `at` the midpoint of the
 *   longest one (both null when the root is clean).
 */
export function flexRoot(mesh, group) {
  const { positions: P, indices: I, featureIds, features } = mesh;
  const ids = new Set();
  if (featureIds && features) features.forEach((f, i) => { if (group.includes(f)) ids.add(i + 1); });
  if (!ids.size) return { found: false, sharpLength: 0, maxTurn: null, at: null };
  const nTri = I ? I.length / 3 : P.length / 9;
  const vi = (t, j) => (I ? I[t * 3 + j] : t * 3 + j);
  const key = (i) => `${Math.round(P[i * 3] * 1e4)},${Math.round(P[i * 3 + 1] * 1e4)},${Math.round(P[i * 3 + 2] * 1e4)}`;

  // Normals and centroids, and every edge of a member triangle, keyed by welded endpoints.
  const inMember = (t) => ids.has(featureIds[t]);
  const normal = new Float64Array(nTri * 3), cent = new Float64Array(nTri * 3);
  const edges = new Map(); // key -> { a, b, tris: [] }
  const tri = (t) => [vi(t, 0), vi(t, 1), vi(t, 2)];
  for (let t = 0; t < nTri; t++) {
    const [a, b, c] = tri(t);
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    normal[t * 3] = nx / len; normal[t * 3 + 1] = ny / len; normal[t * 3 + 2] = nz / len;
    for (let k = 0; k < 3; k++) cent[t * 3 + k] = (P[a * 3 + k] + P[b * 3 + k] + P[c * 3 + k]) / 3;
  }
  // Only edges touching a member triangle matter; register those first, then let any
  // triangle sharing such an edge join it.
  const keys = [];
  for (let t = 0; t < nTri; t++) {
    const v = tri(t);
    keys.push(v.map(key));
    if (!inMember(t)) continue;
    for (let j = 0; j < 3; j++) {
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

  let sharpLength = 0, maxTurn = null, longest = 0, at = null;
  for (const e of edges.values()) {
    if (e.tris.length !== 2) continue;
    const [t1, t2] = e.tris;
    if (inMember(t1) === inMember(t2)) continue;                  // inside the member, or not on it
    const d = normal[t1 * 3] * normal[t2 * 3] + normal[t1 * 3 + 1] * normal[t2 * 3 + 1] + normal[t1 * 3 + 2] * normal[t2 * 3 + 2];
    if (d > SHARP_COS) continue;                                  // shallow: a fillet facet, a flush face
    const mx = (P[e.a * 3] + P[e.b * 3]) / 2, my = (P[e.a * 3 + 1] + P[e.b * 3 + 1]) / 2, mz = (P[e.a * 3 + 2] + P[e.b * 3 + 2]) / 2;
    // Concave: the second triangle lies in front of the first one's face.
    const front = normal[t1 * 3] * (cent[t2 * 3] - mx) + normal[t1 * 3 + 1] * (cent[t2 * 3 + 1] - my) + normal[t1 * 3 + 2] * (cent[t2 * 3 + 2] - mz);
    if (front <= 1e-9) continue;                                  // convex: an outside edge
    const len = Math.hypot(P[e.a * 3] - P[e.b * 3], P[e.a * 3 + 1] - P[e.b * 3 + 1], P[e.a * 3 + 2] - P[e.b * 3 + 2]);
    const turn = (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
    sharpLength += len;
    if (maxTurn == null || turn > maxTurn) maxTurn = turn;
    if (len > longest) { longest = len; at = [mx, my, mz]; }
  }
  if (sharpLength < ROOT_FLOOR) return { found: true, sharpLength: 0, maxTurn: null, at: null };
  return { found: true, sharpLength, maxTurn, at };
}
