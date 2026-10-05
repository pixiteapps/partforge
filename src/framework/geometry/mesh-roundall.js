// Morphological whole-solid rounding on the mesh backend: close-then-open with
// a ball — dilate(+r), erode(2r), dilate(+r) via Manifold's native Minkowski
// sum/difference. Rounds EVERY edge (convex and concave) at radius ≈ r and
// consumes features smaller than the ball (walls < 2r melt, holes < 2r seal) —
// that is the op's contract, not a defect (docs/roundall-design.md).
//
// simplify() between steps is mandatory, not an optimization: the naive
// Minkowski (hull-of-triangle-pairs) emits sliver-degenerate meshes whose
// complexity compounds through the chain — the design spike measured 106s and
// 761k broken-topology triangles without it vs 2.4s and 340 clean triangles
// with it, on the same torture case. asOriginal() first, because simplify()
// will not collapse triangles across run (originalID) boundaries and the
// Minkowski output is stitched from many.
//
// This op must NEVER throw KernelCapabilityError / NEEDS_OCCT: the mesh
// backend is roundAll's reference implementation — rerouting to OCCT would
// trade a correct result for a skip (occt-roundall.js can only skip where
// morphology exceeds what B-rep offsets support).
//
// INVARIANT — both balls share ONE segment count. Minkowski support functions
// add, so the chain displaces a face with normal n by 2·h_r(n) − h_2r(n), where
// h is the ball's support. Manifold spheres built with equal `segs` are similar
// (the 2r ball is the r ball scaled by two), so h_2r = 2·h_r and the term is
// exactly zero in EVERY direction — the input's planar faces return to their
// original planes. Give the two balls different segment counts and the term is
// only zero where a vertex happens to line up: axis-aligned boxes still look
// right while off-axis faces drift (measured 0.07mm at preview, r=2). The count
// is sized from the erosion ball (2r), the larger of the two, so the coarser of
// the two facetings still meets the tier's sagitta tolerance.

import { segsForSagitta } from "./circle-segs.js";
import { SMOOTH, cosDeg } from "./shading-policy.js";

// Sphere tessellation from the facet sagitta r·(1 − cos(π/segs)): pick the
// fewest segments that keep it under the quality tier's tolerance — its own
// tolerance table and 12..64 window, on the shared formula.
const SAGITTA_TOL = { preview: 0.05, print: 0.01 }; // mm
export function roundAllSegs(r, quality) {
  return segsForSagitta(r, SAGITTA_TOL[quality] ?? SAGITTA_TOL.preview, 12, 64);
}

export function meshRoundAll(wasm, m, r, quality) {
  if (!Number.isFinite(r) || r <= 0) throw new Error("roundAll: r must be a finite number > 0 (r = 0 is handled as the identity by the caller)");
  const segs = roundAllSegs(2 * r, quality); // ONE count for BOTH balls — see the invariant above
  // Simplify tolerance: max(r/100, 0.01) mm, but never enough to collapse the
  // rim ring of a rounded edge into the next ring up. That ring sits
  // r·(1 − cos(2π/segs)) above the face plane, and it is what holds a planar
  // face at its exact position; collapsing it shaves the face inward (print
  // tier, r = 2: segs 45 puts the ring 0.0195 mm up, and a flat 0.02 tolerance
  // pulled every face of a box in by 0.034 mm). Half that spacing keeps margin.
  const tol = Math.min(Math.max(r / 100, 0.01), 0.5 * r * (1 - Math.cos((2 * Math.PI) / segs)));
  const step = (input, sphere, op) => {
    const raw = op === "sum" ? input.minkowskiSum(sphere) : input.minkowskiDifference(sphere);
    let orig;
    try {
      orig = raw.asOriginal();
    } finally {
      raw.delete?.();
    }
    try {
      return orig.simplify(tol);
    } finally {
      orig.delete?.();
    }
  };
  const sphR = wasm.Manifold.sphere(r, segs);
  const sph2R = wasm.Manifold.sphere(2 * r, segs);
  try {
    const a = step(m, sphR, "sum");          // dilate: rounds convex, seals holes < 2r
    let b;
    try {
      b = step(a, sph2R, "diff");        // erode 2r: melts walls < 2r
    } finally {
      a.delete?.();
    }
    try {
      return step(b, sphR, "sum");          // dilate back: final radius ≈ r everywhere
    } finally {
      b.delete?.();
    }
  } finally {
    sphR.delete?.();
    sph2R.delete?.();
  }
}

// ---------------------------------------------------------------------------
// Flat-face shading. The reference path's result is one fresh surface, shaded
// SMOOTH (35° crease), and the rounding ball's facets bend far less than that, so
// a flat face used to share its corner normals with the band facets around it.
// The vertex sum is unweighted, so a large face split into two triangles — a
// sloped palm plate's top — took a several-degree tilt at each corner and showed
// it as a shading gradient across the whole face (cloud feedback #167).
//
// The cure rests on the invariant above: the chain returns every planar face of
// the input to its own plane. So the input's flat faces, found here, say exactly
// where the result is flat; the backend registers them as an analytic "planes"
// descriptor (blend-surfaces.js), and creased-normals then shades every vertex on
// one of those planes — the band's seam vertices too, since the band is tangent
// there — with the plane's normal, the same way a fillet band's seam agrees with
// its face.
//
// "Flat" means flat the way the INPUT shades it: a coplanar group counts only if
// every edge bounding it is one creased-normals would shade hard (a bend past the
// surface's crease angle, or a cut seam). A rod's wall facets, or a slot's sides
// running tangentially into its round ends, meet their neighbours softly — the
// input already shades them as part of a curved surface, and pinning them to
// their own planes would facet the rounded result.
//
// `g` is a MeshGL (or the same fields on plain arrays); `policyFor(oid)` returns
// that surface's shading policy. Returns [{ n, d }] with n·x = d on the plane.
const PLANE_COS = cosDeg(0.05); // coplanar neighbours: a boolean split, not a bend
export function flatFacePlanes(g, { policyFor = () => SMOOTH } = {}) {
  const np = g.numProp, vp = g.vertProperties, tris = g.triVerts;
  const nTri = (tris.length / 3) | 0, nVert = (vp.length / np) | 0;
  const remap = new Uint32Array(nVert);
  for (let i = 0; i < nVert; i++) remap[i] = i;
  const mf = g.mergeFromVert, mt = g.mergeToVert;
  if (mf && mt) for (let i = 0; i < mf.length; i++) remap[mf[i]] = mt[i];
  const triOID = new Uint32Array(nTri);
  const ri = g.runIndex, roid = g.runOriginalID;
  if (ri && roid) for (let r = 0; r < roid.length; r++)
    for (let t = ri[r] / 3; t < ri[r + 1] / 3; t++) triOID[t] = roid[r];

  // facet normals, areas and centroids; a degenerate triangle has no normal and
  // takes no part — it neither joins a face nor disqualifies one
  const fn = new Float64Array(nTri * 3), area = new Float64Array(nTri), cen = new Float64Array(nTri * 3);
  let span = 0;
  for (let t = 0; t < nTri; t++) {
    const a = tris[t * 3] * np, b = tris[t * 3 + 1] * np, c = tris[t * 3 + 2] * np;
    const ux = vp[b] - vp[a], uy = vp[b + 1] - vp[a + 1], uz = vp[b + 2] - vp[a + 2];
    const vx = vp[c] - vp[a], vy = vp[c + 1] - vp[a + 1], vz = vp[c + 2] - vp[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz);
    area[t] = L / 2;
    if (L > 0) { fn[t * 3] = nx / L; fn[t * 3 + 1] = ny / L; fn[t * 3 + 2] = nz / L; }
    for (let k = 0; k < 3; k++) cen[t * 3 + k] = (vp[a + k] + vp[b + k] + vp[c + k]) / 3;
    span = Math.max(span, Math.abs(vp[a]), Math.abs(vp[a + 1]), Math.abs(vp[a + 2]));
  }
  const live = (t) => area[t] > 1e-9;
  const dot = (t, u) => fn[t * 3] * fn[u * 3] + fn[t * 3 + 1] * fn[u * 3 + 1] + fn[t * 3 + 2] * fn[u * 3 + 2];

  // edge → incident triangles, on welded vertex ids
  const edges = new Map();
  for (let t = 0; t < nTri; t++) for (let k = 0; k < 3; k++) {
    const p = remap[tris[t * 3 + k]], q = remap[tris[t * 3 + ((k + 1) % 3)]];
    const key = p < q ? p * nVert + q : q * nVert + p;
    const list = edges.get(key);
    if (list) list.push(t); else edges.set(key, [t]);
  }

  // coplanar groups (union-find over shared edges)
  const parent = new Int32Array(nTri);
  for (let t = 0; t < nTri; t++) parent[t] = t;
  const find = (t) => { while (parent[t] !== t) { parent[t] = parent[parent[t]]; t = parent[t]; } return t; };
  for (const list of edges.values()) {
    if (list.length !== 2) continue;
    const [t, u] = list;
    if (live(t) && live(u) && dot(t, u) > PLANE_COS) parent[find(t)] = find(u);
  }

  // a group is a flat face only if every edge leaving it would shade hard
  const soft = new Uint8Array(nTri); // indexed by group root
  const hard = (t, u) => {
    const pt = policyFor(triOID[t]) ?? SMOOTH, pu = policyFor(triOID[u]) ?? SMOOTH;
    if (triOID[t] !== triOID[u] && !(pt.boundaryLines || pu.boundaryLines)) return true;
    return dot(t, u) < cosDeg(pt.creaseAngle);
  };
  for (const list of edges.values()) {
    if (list.length !== 2) continue; // non-manifold: no smooth neighbour to share with
    const [t, u] = list;
    if (!live(t) || !live(u) || find(t) === find(u)) continue;
    if (!hard(t, u)) soft[find(t)] = 1;
    if (!hard(u, t)) soft[find(u)] = 1;
  }

  // one area-weighted plane per surviving group, merged where two groups share a
  // plane (a degenerate triangle can split one face into two)
  const acc = new Map();
  for (let t = 0; t < nTri; t++) {
    if (!live(t)) continue;
    const root = find(t);
    if (soft[root]) continue;
    let e = acc.get(root);
    if (!e) acc.set(root, (e = { n: [0, 0, 0], c: [0, 0, 0], a: 0 }));
    for (let k = 0; k < 3; k++) { e.n[k] += fn[t * 3 + k] * area[t]; e.c[k] += cen[t * 3 + k] * area[t]; }
    e.a += area[t];
  }
  const dTol = Math.max(1e-6, span * 1e-7);
  const planes = [];
  for (const e of acc.values()) {
    const L = Math.hypot(...e.n);
    if (!(L > 0)) continue;
    const n = e.n.map((x) => x / L);
    const d = (n[0] * e.c[0] + n[1] * e.c[1] + n[2] * e.c[2]) / e.a;
    const dup = planes.find((p) => p.n[0] * n[0] + p.n[1] * n[1] + p.n[2] * n[2] > PLANE_COS && Math.abs(p.d - d) < dTol);
    if (!dup) planes.push({ n, d });
  }
  return planes;
}

// ---------------------------------------------------------------------------
// Prism detection for the fast path (manifold-backend.js). The Minkowski chain
// above is seconds-per-thousand-triangles, but roundAll's expensive real-world
// inputs are almost always Z-prisms (text backings, plates, extruded outlines) —
// and on a prism the ball morphology decomposes exactly into the 2-D disk
// morphology of the cross-section plus rim fillets, all of which are fast. This
// function answers "is m a Z-prism, and what is its constant cross-section?"
//
// Detection is deliberately behavioral, not structural: three slices must have
// equal area AND vanishing symmetric difference (a sheared prism has equal-area
// TRANSLATED sections — the subtract catches it), and the solid's volume must
// equal section × height (a bulge parked between the slice planes would pass the
// slice checks alone). Any failure returns null and the caller keeps the
// reference morphology — the fast path may only ever substitute, never widen.
//
// On success the returned CrossSection is the CALLER's to delete.
export function prismSection(wasm, m, relTol = 1e-4) {
  const bb = m.boundingBox();
  const z0 = bb.min[2], h = bb.max[2] - z0;
  if (!(h > 0)) return null;
  const volume = m.volume();
  if (!(volume > 0)) return null;
  const slices = [0.25, 0.5, 0.75].map((t) => m.slice(z0 + t * h));
  try {
    const area = slices[1].area();
    if (!(area > 0)) return null;
    for (const s of slices) if (Math.abs(s.area() - area) > relTol * area) return null;
    for (const s of [slices[0], slices[2]]) {
      const d1 = slices[1].subtract(s), d2 = s.subtract(slices[1]);
      const diff = d1.area() + d2.area();
      d1.delete?.();
      d2.delete?.();
      if (diff > relTol * area) return null;
    }
    if (Math.abs(volume - area * h) > 10 * relTol * area * h) return null;
    const cs = slices[1];
    slices[1] = null; // ownership moves to the caller
    return { cs, z0, h };
  } finally {
    for (const s of slices) s?.delete?.();
  }
}
