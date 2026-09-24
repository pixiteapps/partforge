// Policy-aware crease pass for Manifold meshes — moved out of the backend so it
// is unit-testable on plain arrays without booting WASM. Builds a non-indexed
// mesh with normals that are smooth within a single original surface but HARD
// across boolean-cut seams. Manifold's runOriginalID tells us which input solid
// each triangle came from; we average a corner's face normals only over
// incident triangles of the SAME original surface that also meet within that
// surface's policy creaseAngle — so cut seams stay crisp at any angle (even
// near-tangent), and a surface's own sharp edges stay crisp too. Each original
// surface may carry a shading policy (shading-policy.js); surfaces without one
// use SMOOTH, which reproduces the pre-policy behavior exactly.
//
// Analytic blend normals: a surface id with a registered blend-surface descriptor
// (`surfaces`, blend-surfaces.js — mesh fillet bands) shades with the EXACT normal of
// its rolling-ball surface instead of a facet average. Wherever such a surface takes
// part in a vertex's smooth group, the group's normal is the average of the analytic
// normals alone: at a band's tangent boundary that is the neighbouring face's own
// normal (the surfaces meet with zero angle), so the face side of the seam, the band
// side, and any band vertex riding a face edge as a T-junction all agree.
import { SMOOTH, COPLANAR_ANGLE, MIN_EDGE, MIN_FACE, cosDeg } from "./shading-policy.js";
import { affineAt, IDENTITY, runEvaluator } from "./blend-surfaces.js";

const COPLANAR_COS = cosDeg(COPLANAR_ANGLE);
const MIN_EDGE2 = MIN_EDGE * MIN_EDGE;
// A descriptor's normal is trusted on a triangle only while it stays within this of
// the facet: a blend facet spans at most 30° of arc (blendSegs' floor of 12), so its
// normal is ≤15° from any of its vertices' — anything further is a tool face that is
// NOT the blend wall (a filler's flush end cap, a cutter's closing wall).
const ANALYTIC_COS = cosDeg(25);
// Shading-adjacency weld radius (mm): far below anything visible, above the boolean's
// nanometre seam splits (see the weld below).
const SHADE_WELD = 5e-5;
const SHADE_CELL = 1e-3; // its hash-grid cell

export function creasedNormals(g, { policies = null, featureLabels = null, surfaces = null } = {}) {
  const np = g.numProp, vp = g.vertProperties, tris = g.triVerts;
  const nTri = (tris.length / 3) | 0, nVert = (vp.length / np) | 0;

  // per-OID policy lookup with a cached cosine per OID
  const polFor = (oid) => (policies && policies.get(oid)) || SMOOTH;
  const cosCache = new Map();
  const cosFor = (oid) => {
    let c = cosCache.get(oid);
    if (c === undefined) { c = cosDeg(polFor(oid).creaseAngle); cosCache.set(oid, c); }
    return c;
  };

  // unify any coincident vertices Manifold kept separate, for adjacency
  const remap = new Uint32Array(nVert);
  for (let i = 0; i < nVert; i++) remap[i] = i;
  const mf = g.mergeFromVert, mt = g.mergeToVert;
  if (mf && mt) for (let i = 0; i < mf.length; i++) remap[mf[i]] = mt[i];

  // per-triangle original-surface id, from the run table
  const triOID = new Uint32Array(nTri);
  const ri = g.runIndex, roid = g.runOriginalID;
  for (let r = 0; r < roid.length; r++)
    for (let t = ri[r] / 3; t < ri[r + 1] / 3; t++) triOID[t] = roid[r];

  // per-run analytic evaluators (only runs whose surface id has a descriptor), and
  // each triangle's run — evaluated lazily, memoized per (run, vertex)
  let triRun = null, runEval = null;
  if (surfaces?.size) {
    const rt = g.runTransform;
    runEval = new Array(roid.length).fill(null);
    let any = false;
    for (let r = 0; r < roid.length; r++) {
      const desc = surfaces.get(roid[r]);
      if (!desc) continue;
      runEval[r] = runEvaluator(desc, rt && rt.length >= (r + 1) * 12 ? affineAt(rt, r) : IDENTITY);
      any ||= !!runEval[r];
    }
    if (any) {
      triRun = new Uint32Array(nTri);
      for (let r = 0; r < roid.length; r++)
        for (let t = ri[r] / 3; t < ri[r + 1] / 3; t++) triRun[t] = r;
    } else runEval = null;
  }
  const analyticMemo = new Map();
  // analytic normal of triangle t at vertex v, oriented with the facet — or null
  const analyticAt = (t, v) => {
    const r = triRun[t], ev = runEval[r];
    if (!ev) return null;
    const key = r * nVert + v;
    let n = analyticMemo.get(key);
    if (n === undefined) {
      const o = v * np;
      n = ev([vp[o], vp[o + 1], vp[o + 2]]);
      analyticMemo.set(key, n);
    }
    if (!n) return null;
    const d = n[0] * fn[t * 3] + n[1] * fn[t * 3 + 1] + n[2] * fn[t * 3 + 2];
    if (Math.abs(d) < ANALYTIC_COS) return null;
    return d < 0 ? [-n[0], -n[1], -n[2]] : n;
  };

  // per-triangle face normals, plus each triangle's minimum height (2·area /
  // longest edge) — the "thinness" the feature-edge pass gates on below
  const fn = new Float32Array(nTri * 3);
  const thin = new Float32Array(nTri);
  for (let t = 0; t < nTri; t++) {
    const a = tris[t * 3] * np, b = tris[t * 3 + 1] * np, c = tris[t * 3 + 2] * np;
    const ux = vp[b] - vp[a], uy = vp[b + 1] - vp[a + 1], uz = vp[b + 2] - vp[a + 2];
    const vx = vp[c] - vp[a], vy = vp[c + 1] - vp[a + 1], vz = vp[c + 2] - vp[a + 2];
    const wx = vp[c] - vp[b], wy = vp[c + 1] - vp[b + 1], wz = vp[c + 2] - vp[b + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L0 = Math.hypot(nx, ny, nz), L = L0 || 1; // the || 1 is for the normal divide ONLY
    fn[t * 3] = nx / L; fn[t * 3 + 1] = ny / L; fn[t * 3 + 2] = nz / L;
    const longest = Math.max(ux * ux + uy * uy + uz * uz, vx * vx + vy * vy + vz * vz, wx * wx + wy * wy + wz * wz);
    // |cross| / maxEdge = min height — from the RAW cross magnitude, never the
    // guarded L: a zero-area triangle (two float32-coincident vertices — the
    // render-precision collapse of a sub-micron boolean seam sliver) must report
    // thin 0 so the feature-edge gate drops it. With L it reported 1/maxEdge and
    // sailed past the gate, and its garbage (0,0,0) normal reads as a 90° crease
    // against every neighbor — a full-weight line down an otherwise smooth wall
    // at whatever seam produced it.
    thin[t] = longest > 0 ? L0 / Math.sqrt(longest) : 0;
  }

  // Second-stage weld for SHADING adjacency only: a boolean seam whose two
  // sides land sub-micron apart keeps two distinct vertex columns that the
  // merge map does not join, yet at render (float32) precision they are the
  // same point — without this weld the facets on either side average their
  // normals separately and the seam shades as a lighting crease. The line
  // pass below deliberately keeps `remap` (Manifold's own topology): welding
  // its edge keys would make pairing at collapsed seams order-dependent and
  // could pair a boundary ring's edges away.
  //
  // The join is within SHADE_WELD, not float-exact: a seam where a fillet band meets
  // a curved flank comes out of the boolean as two or three vertex columns a few
  // NANOmetres apart (measured 0.5-4 nm on a cylinder rim fillet), so an exact key
  // left the flank's rim vertices shading on their own facet while the band beside
  // them shaded smooth — a ~1.5° lighting step along every rim, which mirror-like
  // materials show as a seam.
  const weld = Uint32Array.from(remap);
  {
    // cells SHADE_CELL wide (≫ SHADE_WELD), so a vertex probes a neighbor cell only
    // on the axes where it sits within SHADE_WELD of the cell wall — one lookup for
    // almost every vertex. Numeric hashed keys; a collision only adds candidates,
    // and every candidate is distance-checked.
    const inv = 1 / SHADE_CELL, edge = SHADE_WELD / SHADE_CELL, tol2 = SHADE_WELD * SHADE_WELD;
    const cells = new Map();
    const hash = (x, y, z) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) | 0;
    const offs = (f) => (f < edge ? [0, -1] : f > 1 - edge ? [0, 1] : [0]);
    for (let i = 0; i < nVert; i++) {
      const o = i * np, x = vp[o], y = vp[o + 1], z = vp[o + 2];
      const fx = x * inv, fy = y * inv, fz = z * inv;
      const cx = Math.floor(fx), cy = Math.floor(fy), cz = Math.floor(fz);
      let hit = -1;
      search: for (const dx of offs(fx - cx)) for (const dy of offs(fy - cy)) for (const dz of offs(fz - cz)) {
        const reps = cells.get(hash(cx + dx, cy + dy, cz + dz));
        if (!reps) continue;
        for (const j of reps) {
          const q = j * np;
          if ((vp[q] - x) ** 2 + (vp[q + 1] - y) ** 2 + (vp[q + 2] - z) ** 2 <= tol2) { hit = j; break search; }
        }
      }
      if (hit >= 0) { weld[i] = weld[hit]; continue; }
      const key = hash(cx, cy, cz);
      const reps = cells.get(key);
      if (reps) reps.push(i); else cells.set(key, [i]);
    }
  }

  // canonical vertex → incident triangles
  const incident = new Map();
  for (let t = 0; t < nTri; t++)
    for (let k = 0; k < 3; k++) {
      const cv = weld[tris[t * 3 + k]];
      const arr = incident.get(cv);
      if (arr) arr.push(t); else incident.set(cv, [t]);
    }

  const positions = new Float32Array(nTri * 9);
  const normals = new Float32Array(nTri * 9);
  for (let t = 0; t < nTri; t++) {
    const fx = fn[t * 3], fy = fn[t * 3 + 1], fz = fn[t * 3 + 2], oid = triOID[t];
    const sharpCos = cosFor(oid); // per-surface crease threshold
    for (let k = 0; k < 3; k++) {
      const v = tris[t * 3 + k];
      let nx = 0, ny = 0, nz = 0, ax = 0, ay = 0, az = 0, analytic = false;
      for (const t2 of incident.get(weld[v])) {
        // different cut surface → hard, EXCEPT when a blend surface (boundaryLines)
        // is involved on either side. Blend↔blend: one band is many tool surfaces
        // continuing each other tangentially, and hard normals at their handovers
        // would put lighting seams along a band that used to shade as one
        // re-originaled surface. Blend↔base: the band's start/end seams are TANGENT
        // by construction (that is why the line pass needs boundaryLines to draw
        // them at all), so shading them hard painted a permanent lighting ridge
        // along every fillet boundary ring. Both cases still fall to the crease
        // check below, so a genuinely sharp crossing (a chamfer's 45° shoulder, a
        // band end-cap against a wall) stays hard.
        if (triOID[t2] !== oid &&
          !(polFor(triOID[t2]).boundaryLines || polFor(oid).boundaryLines)) continue;
        if (fn[t2 * 3] * fx + fn[t2 * 3 + 1] * fy + fn[t2 * 3 + 2] * fz < sharpCos) continue; // sharp same-surface edge → hard
        nx += fn[t2 * 3]; ny += fn[t2 * 3 + 1]; nz += fn[t2 * 3 + 2];
        if (runEval) {
          const an = analyticAt(t2, weld[v]);
          if (an) { ax += an[0]; ay += an[1]; az += an[2]; analytic = true; }
        }
      }
      if (analytic && Math.hypot(ax, ay, az) > 1e-9) { nx = ax; ny = ay; nz = az; }
      const L = Math.hypot(nx, ny, nz) || 1;
      const o = (t * 3 + k) * 3, vv = v * np;
      positions[o] = vp[vv]; positions[o + 1] = vp[vv + 1]; positions[o + 2] = vp[vv + 2];
      normals[o] = nx / L; normals[o + 1] = ny / L; normals[o + 2] = nz / L;
    }
  }

  // Feature edge segments for CAD-style edge lines: draw a line where the
  // surface actually BENDS. Same-surface edges draw per the surface's policy
  // (sharper than creaseAngle, and only if the policy wants same-surface lines
  // at all — intentional facets shade flat with no wireframe). Cut seams
  // (different original surface) draw when they bend more than COPLANAR_ANGLE;
  // coplanar seams get no line, and curved-surface facets are skipped.
  const edges = [];
  const seenEdge = new Map(); // edge key → first incident triangle
  for (let t = 0; t < nTri; t++)
    for (let e = 0; e < 3; e++) {
      const i = remap[tris[t * 3 + e]], j = remap[tris[t * 3 + ((e + 1) % 3)]];
      if (i === j) continue;
      const key = i < j ? i * nVert + j : j * nVert + i;
      const prev = seenEdge.get(key);
      if (prev === undefined) { seenEdge.set(key, t); continue; }
      seenEdge.delete(key);
      // Sub-visible slivers never emit feature lines: a CSG junction between two
      // independently tessellated tangent surfaces (e.g. a corner sphere meeting
      // its edge-fillet cylinders) can leave micron-wide wall strips whose FACES
      // are invisible but whose long boundary edges would otherwise draw at full
      // line weight. A triangle thinner than MIN_FACE cannot carry a visible
      // crease — the fan slivers a boolean face-split leaves near a tool
      // crossing are 14-34µm wide with wildly tilted normals over sub-15µm of
      // actual relief (see shading-policy.js) — so its edges are noise by
      // definition. The gate is deliberately wider than the segment filter's
      // MIN_EDGE below, which stays tight so short REAL segments survive.
      const sameOID = triOID[prev] === triOID[t];
      // Blend boundary: a cross-surface seam with a BLEND policy on EXACTLY one side
      // is the start/end of a fillet band — draw it even when tangent (the band's
      // extent must be readable). It also bypasses the thin-triangle gate below:
      // simplify() cannot collapse the boolean's slivers ACROSS the blend/base run
      // boundary, so half the seam's edges border a sliver, and gating them dashed
      // the ring — those slivers ride within microns OF the seam curve, so their
      // long edges redraw it rather than add noise (the MIN_EDGE segment-length
      // filter still drops the short ones).
      const boundary = !sameOID &&
        !!polFor(triOID[prev]).boundaryLines !== !!polFor(triOID[t]).boundaryLines;
      if (!boundary && (thin[prev] < MIN_FACE || thin[t] < MIN_FACE)) continue;
      const dot = fn[prev * 3] * fn[t * 3] + fn[prev * 3 + 1] * fn[t * 3 + 1] + fn[prev * 3 + 2] * fn[t * 3 + 2];
      // A multi-hole cap triangulation can contain an opposite-wound bridge:
      // its two normals disagree by 180 degrees even though both triangles lie
      // in the same plane. Gate on the unoriented supporting-plane angle first
      // so that triangulation seam never becomes a feature line.
      const bends = Math.abs(dot) < COPLANAR_COS;
      // Two blend surfaces (a handover along one band) line-draw like ONE surface:
      // the 35° same-surface bar, not the 5° cut-seam bar — a band is many tool
      // surfaces whose overshoot crossings bend a few degrees by construction.
      const bothBlend = !sameOID &&
        !!polFor(triOID[prev]).boundaryLines && !!polFor(triOID[t]).boundaryLines;
      const hard = boundary || (bends && (sameOID || bothBlend
        ? polFor(triOID[t]).sameSurfaceLines && dot < cosFor(triOID[t])
        : true));
      if (hard) {
        const ai = i * np, bj = j * np;
        const dx = vp[ai] - vp[bj], dy = vp[ai + 1] - vp[bj + 1], dz = vp[ai + 2] - vp[bj + 2];
        if (dx * dx + dy * dy + dz * dz >= MIN_EDGE2) // skip degenerate sliver segments (noise)
          edges.push(vp[ai], vp[ai + 1], vp[ai + 2], vp[bj], vp[bj + 1], vp[bj + 2]);
      }
    }

  // Per-triangle feature attribution: map each triangle's original-surface id
  // through the label registry. Same label string → same feature entry, so a
  // pattern of solids labeled alike reads as one feature.
  let featureIds = null, features = null;
  if (featureLabels?.size) {
    const indexOf = new Map(); // label string -> 1-based feature index
    features = [];
    featureIds = new Uint16Array(nTri);
    for (let t = 0; t < nTri; t++) {
      const label = featureLabels.get(triOID[t]);
      if (label === undefined) continue;
      let fi = indexOf.get(label);
      if (fi === undefined) { features.push(label); fi = features.length; indexOf.set(label, fi); }
      featureIds[t] = fi;
    }
    if (features.length === 0) { featureIds = features = null; } // labels exist in the kernel, none in THIS mesh
  }

  const out = { positions, normals, triangles: nTri, edges: Float32Array.from(edges) }; // mesh non-indexed
  if (featureIds) { out.featureIds = featureIds; out.features = features; }
  return out;
}
