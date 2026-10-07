// creasedNormals(g, opts) on the native core (native/creased_normals.cpp) —
// same arguments, same result object, same bits as the JS in
// geometry/creased-normals.js, which dispatches here when the core is on.
//
// JS keeps only per-SURFACE work: the shading-policy table (Map lookups and
// Math.cos, so no second libm decides a cosine), the feature label strings, and
// flattening each fillet descriptor (blend-surfaces.js) into numbers once.
// Everything per vertex or per triangle runs in C++.
import { SMOOTH, COPLANAR_ANGLE, cosDeg } from "../geometry/shading-policy.js";
import { releaseIfIdle } from "./core.js";

const COPLANAR_COS = cosDeg(COPLANAR_ANGLE);
const ANALYTIC_COS = cosDeg(25); // creased-normals.js's ANALYTIC_COS
const EMPTY = new Uint32Array(0);
const KIND = { line: 1, point: 2, circle: 3, path: 4, spine: 5, planes: 6 };

// native/blend_surfaces.h's flat layout: [kind, closed, n, ...kind fields].
// An unknown kind flattens to 0, which evaluates to "no normal" — exactly what
// surfaceNormal does with one.
function flattenDescriptor(desc, out) {
  const kind = KIND[desc.kind] ?? 0;
  const pts = desc.pts ?? [];
  const v = (p) => out.push(p[0], p[1], p[2]);
  if (kind === 6) {
    out.push(kind, 0, desc.planes.length, desc.tol);
    for (const pl of desc.planes) { v(pl.n); out.push(pl.d); }
    return;
  }
  out.push(kind, desc.closed ? 1 : 0, pts.length);
  switch (kind) {
    case 1: v(desc.p); v(desc.d); break;
    case 2: v(desc.c); break;
    case 3: v(desc.c); v(desc.a); out.push(desc.R); break;
    case 4: out.push(desc.kf, desc.kd); v(desc.f); pts.forEach(v); desc.dirs.forEach(v); break;
    case 5: out.push(desc.r); pts.forEach(v); break;
  }
}

// Can the core take this mesh? The C++ reads the arrays' raw bytes and trusts
// their indices, where the JS tolerated (or simply read undefined from) a
// malformed mesh — so anything but Manifold's own MeshGL shape, typed exactly
// and with every index in range, goes to the JS pass instead. Cheap: O(runs +
// merges), never O(triangles).
export function coreAccepts(g) {
  const vp = g?.vertProperties, tris = g?.triVerts, ri = g?.runIndex, roid = g?.runOriginalID;
  if (!(vp instanceof Float32Array) || !(tris instanceof Uint32Array)) return false;
  if (!(ri instanceof Uint32Array) || !(roid instanceof Uint32Array) || ri.length !== roid.length + 1) return false;
  if (!(g.numProp >= 3) || tris.length % 3 !== 0) return false;
  const nVert = (vp.length / g.numProp) | 0;
  for (let r = 0; r < roid.length; r++) if (ri[r] > ri[r + 1] || ri[r + 1] > tris.length) return false;
  const mf = g.mergeFromVert, mt = g.mergeToVert;
  if (mf != null || mt != null) {
    if (!(mf instanceof Uint32Array) || !(mt instanceof Uint32Array) || mf.length !== mt.length) return false;
    for (let i = 0; i < mf.length; i++) if (mf[i] >= nVert || mt[i] >= nVert) return false;
  }
  // Triangle indices are range-checked in C++ (one pass it already makes);
  // see cn_create. Here: the cheap structural facts.
  return true;
}

// Returns null when the core refuses the mesh (see cn_create); the caller then
// runs the JS pass.
export function creasedNormalsCore(c, g, { policies = null, featureLabels = null, surfaces = null } = {}) {
  const { x } = c;
  const np = g.numProp, vp = g.vertProperties, tris = g.triVerts;
  const nTri = (tris.length / 3) | 0, nVert = (vp.length / np) | 0;
  const roid = g.runOriginalID, ri = g.runIndex;
  const mf = g.mergeFromVert ?? EMPTY, mt = g.mergeToVert ?? EMPTY;

  // Policy table: every surface id in this mesh, then the SMOOTH default row.
  const oidList = [...new Set(roid)];
  const n = oidList.length + 1;
  const oids = new Uint32Array(n), creaseCos = new Float64Array(n), flags = new Uint8Array(n), labelIds = new Int32Array(n);
  const labelOf = new Map(), labels = [];
  const row = (i, pol, label) => {
    creaseCos[i] = cosDeg(pol.creaseAngle);
    flags[i] = (pol.boundaryLines ? 1 : 0) | (pol.sameSurfaceLines ? 2 : 0);
    if (label === undefined) { labelIds[i] = -1; return; }
    let id = labelOf.get(label);
    if (id === undefined) { id = labels.length; labels.push(label); labelOf.set(label, id); }
    labelIds[i] = id;
  };
  oidList.forEach((oid, i) => {
    oids[i] = oid;
    row(i, (policies && policies.get(oid)) || SMOOTH, featureLabels?.size ? featureLabels.get(oid) : undefined);
  });
  row(n - 1, SMOOTH, undefined);

  // Fillet surfaces: one flattened copy per distinct descriptor, run → descriptor
  // index, and each run's transform (IDENTITY when the mesh carries none for it).
  let runDesc = null, runXf = null, descData = null, descOffsets = null;
  if (surfaces?.size) {
    const index = new Map(), flat = [], offsets = [0];
    runDesc = new Int32Array(roid.length).fill(-1);
    for (let r = 0; r < roid.length; r++) {
      const desc = surfaces.get(roid[r]);
      if (!desc) continue;
      let di = index.get(desc);
      if (di === undefined) { di = index.size; index.set(desc, di); flattenDescriptor(desc, flat); offsets.push(flat.length); }
      runDesc[r] = di;
    }
    if (index.size) {
      const rt = g.runTransform;
      runXf = new Float64Array(roid.length * 12);
      for (let r = 0; r < roid.length; r++) {
        if (rt && rt.length >= (r + 1) * 12) for (let k = 0; k < 12; k++) runXf[r * 12 + k] = rt[r * 12 + k];
        else runXf.set([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], r * 12);
      }
      descData = Float64Array.from(flat);
      descOffsets = Uint32Array.from(offsets);
    } else runDesc = null;
  }

  // Inputs are borrowed by the state until destroy; free them after.
  const inputs = [c.copyIn(vp), c.copyIn(tris), c.copyIn(mf), c.copyIn(mt), c.copyIn(ri), c.copyIn(roid)];
  const state = x.cn_create(inputs[0], np, nVert, inputs[1], nTri, inputs[2], inputs[3], mf.length, inputs[4], inputs[5], roid.length);
  if (!state) { // a triangle index out of range: not a mesh the core takes
    for (const p of inputs) if (p) x.free(p);
    return null;
  }
  const args = [c.copyIn(oids), c.copyIn(creaseCos), c.copyIn(flags), c.copyIn(labelIds),
    c.copyIn(runDesc), c.copyIn(runXf), c.copyIn(descData), c.copyIn(descOffsets)];
  try {
    x.cn_finish(state, args[0], args[1], args[2], args[3], n, COPLANAR_COS, ANALYTIC_COS,
      args[4], args[5], args[6], args[7], descOffsets ? descOffsets.length - 1 : 0);
    const nf = x.cn_feature_count(state);
    const out = {
      positions: c.copyOut(Float32Array, x.cn_positions(state), nTri * 9),
      normals: c.copyOut(Float32Array, x.cn_normals(state), nTri * 9),
      triangles: nTri,
      edges: c.copyOut(Float32Array, x.cn_edges(state), x.cn_edge_floats(state)),
    };
    if (nf) {
      out.featureIds = c.copyOut(Uint16Array, x.cn_feature_ids(state), nTri);
      out.features = [...c.copyOut(Int32Array, x.cn_feature_labels(state), nf)].map((id) => labels[id]);
    }
    return out;
  } finally {
    x.cn_destroy(state);
    for (const p of [...inputs, ...args]) if (p) x.free(p);
    releaseIfIdle(c);
  }
}
