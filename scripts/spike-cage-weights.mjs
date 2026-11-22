// scripts/spike-cage-weights.mjs — Task 10 spike (cage pose drag, Part 3). Not shipped.
// Usage: node scripts/spike-cage-weights.mjs   (Node 24)
//
// Question: after k.subdiv's limit mesh goes through Manifold and a boolean, can every
// vertex of the output mesh be tied to the smooth surface (a limit triangle + three
// barycentric weights), so a drag can move it from new cage points with no kernel?
//
// Two layouts are tried, both by copying the few lines of the import (mesh-build.js
// manifoldFromWeldedMesh) so no production file changes:
//   A. faceID: the import sets MeshGL.faceID = the limit triangle's index. Manifold keeps
//      input faceIDs on every output triangle (and keeps the edges between different
//      faceIDs). The weights are the corner's rest position written in its source
//      triangle's barycentric coordinates (exact: an output triangle lies in the plane
//      of its source triangle). No extra vertex properties.
//   B. per-corner properties: three properties [triangle, w0, w1] on unwelded property
//      vertices (one per triangle corner, positions merged with mergeFromVert/ToVert).
//      A boolean interpolates them only inside one source triangle, so the triangle
//      stays an exact integer and the weights stay barycentric.
// Cutter (and union tool) vertices are not on the skin. A cutter vertex that is shared
// with a skin triangle (the seam loop) is moved by that skin corner's tie; any other one
// is reported as untied and kept at rest.
//
// Each case is built at the default pose with the tie attached, then the cage is moved to
// a second pose, the plan is applied, every vertex is placed, and the result is compared
// with the part's own full kernel build at the second pose (point-to-surface distance).
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { resolveParams } from "../src/framework/part-model.js";
import { levelFor, subdivide, subdivPlan, applySubdivPlan, topologyKey, SUBDIV_TOLERANCE, SUBDIV_MAX_TRIANGLES } from "../src/framework/geometry/subdiv/surface.js";
import hand, { cageHand } from "../src/parts/cage-hand.js";

const kernel = await bootManifoldKernel();
const wasm = await (await import("manifold-3d")).default().then((m) => { m.setup(); return m; });
const { Manifold } = wasm;

const bendsOf = (d) => Object.fromEntries(Object.keys(d).map((n) => [n, d[n].values]));
const cageAt = (p) => cageHand(kernel.cage, p, bendsOf(resolveParams(hand, p).d)).snapshot();
const P0 = { ...hand.defaults };
// Second pose: three fingers curl 20-40 degrees further, the thumb too.
const P1 = {
  ...hand.defaults,
  indexKnuckle: 15 + 30, indexCurl: 20 + 40,
  middleKnuckle: 15 + 25, middleCurl: 20 + 35,
  ringKnuckle: 15 + 20, ringCurl: 20 + 30,
};
// The thumb is left at its default on purpose: thumbCurl 20-45 changes the cage's
// topologyKey (extrude's side ids s0..s3 are numbered from a geometric first edge,
// cage.js orderedSides/firstEdge, so the thumb2 side faces swap ids). The plan would still
// give the right surface (the same quads, reordered), but the key gate would refuse.
{
  const k = (t) => topologyKey(cageAt({ ...hand.defaults, thumbCurl: t }));
  console.log("topologyKey equal to the default pose at thumbCurl:", [10, 15, 20, 30, 45, 60].map((t) => `${t}:${k(t) === k(P0.thumbCurl)}`).join(" "));
}

const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const f = (x, n = 3) => (Number.isFinite(x) ? x.toFixed(n) : String(x));

// ---------- the smooth surface at pose 0, and the plan ----------
const s0 = cageAt(P0), s1 = cageAt(P1);
if (topologyKey(s0) !== topologyKey(s1)) throw new Error("the two poses differ in topology");
const lf = levelFor(s0, SUBDIV_TOLERANCE.preview, { maxTriangles: SUBDIV_MAX_TRIANGLES.preview });
const lf1 = levelFor(s1, SUBDIV_TOLERANCE.preview, { maxTriangles: SUBDIV_MAX_TRIANGLES.preview });
const rest = subdivide(s0, lf.level, lf.mesh);
const plan = subdivPlan(s0, lf.level);
const nTri = rest.indices.length / 3;
console.log(`cage-hand: ${s0.faces.length} cage faces, level ${lf.level} (pose 1 alone would pick level ${lf1.level}), ${nTri} limit triangles, ${rest.positions.length / 3} limit vertices`);

// ---------- the two import layouts ----------
function importFaceID(V, Tr, oid) {
  const mesh = new wasm.Mesh({
    numProp: 3, vertProperties: Float32Array.from(V), triVerts: Uint32Array.from(Tr),
    runIndex: Uint32Array.of(0, Tr.length), runOriginalID: Uint32Array.of(oid),
    faceID: Uint32Array.from({ length: Tr.length / 3 }, (_, t) => t),
  });
  const m = Manifold.ofMesh(mesh); mesh.delete?.(); return m;
}
function importCornerProps(V, Tr, oid) {
  const nC = Tr.length, np = 6, vp = new Float32Array(nC * np), tv = new Uint32Array(nC);
  const firstCorner = new Int32Array(V.length / 3).fill(-1);
  const from = [], to = [];
  for (let c = 0; c < nC; c++) {
    const v = Tr[c], t = (c / 3) | 0, j = c % 3, o = c * np;
    vp[o] = V[3 * v]; vp[o + 1] = V[3 * v + 1]; vp[o + 2] = V[3 * v + 2];
    vp[o + 3] = t; vp[o + 4] = j === 0 ? 1 : 0; vp[o + 5] = j === 1 ? 1 : 0;
    tv[c] = c;
    if (firstCorner[v] < 0) firstCorner[v] = c; else { from.push(c); to.push(firstCorner[v]); }
  }
  const mesh = new wasm.Mesh({
    numProp: np, vertProperties: vp, triVerts: tv,
    mergeFromVert: Uint32Array.from(from), mergeToVert: Uint32Array.from(to),
    runIndex: Uint32Array.of(0, nC), runOriginalID: Uint32Array.of(oid),
  });
  const m = Manifold.ofMesh(mesh); mesh.delete?.(); return m;
}

// The part's own cut: a box under the wrist, 1.5 mm into the body.
function wristCutter(m) {
  const { min, max } = m.boundingBox();
  const lo = [min[0] - 1, min[1] - 1, min[2] - 1], hi = [max[0] + 1, max[1] + 1, min[2] + 1.5];
  return Manifold.cube([hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]).translate(lo);
}

// ---------- reading the tie back ----------
// Returns per output VERTEX (MeshGL property vertex) a tie {tri, w0, w1, w2} or none, plus
// which triangles are skin. `skinOid` is the skin's originalID.
function barycentric(P, I, t, x, y, z) {
  const a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
  const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
  const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
  const px = x - P[a], py = y - P[a + 1], pz = z - P[a + 2];
  const d11 = e1x * e1x + e1y * e1y + e1z * e1z, d12 = e1x * e2x + e1y * e2y + e1z * e2z, d22 = e2x * e2x + e2y * e2y + e2z * e2z;
  const p1 = px * e1x + py * e1y + pz * e1z, p2 = px * e2x + py * e2y + pz * e2z;
  const den = d11 * d22 - d12 * d12;
  const u = (d22 * p1 - d12 * p2) / den, v = (d11 * p2 - d12 * p1) / den;
  return [1 - u - v, u, v];
}

function readTie(g, layout, skinOid) {
  const np = g.numProp, vp = g.vertProperties, tv = g.triVerts, nV = (vp.length / np) | 0, nT = tv.length / 3;
  const ri = g.runIndex, roid = g.runOriginalID;
  const skinTri = new Uint8Array(nT);
  for (let r = 0; r < roid.length; r++) if (roid[r] === skinOid) for (let t = ri[r] / 3; t < ri[r + 1] / 3; t++) skinTri[t] = 1;
  // Per output vertex: tri (-1 untied) and three weights.
  const tri = new Int32Array(nV).fill(-1), w = new Float64Array(nV * 3);
  let badCorners = 0, maxBaryOut = 0;
  for (let t = 0; t < nT; t++) {
    if (!skinTri[t]) continue;
    for (let j = 0; j < 3; j++) {
      const v = tv[3 * t + j];
      let s, b;
      if (layout === "faceID") {
        s = g.faceID[t];
        b = barycentric(rest.positions, rest.indices, s, vp[v * np], vp[v * np + 1], vp[v * np + 2]);
      } else {
        s = vp[v * np + 3]; const b0 = vp[v * np + 4], b1 = vp[v * np + 5];
        if (!Number.isInteger(s) || s < 0 || s >= nTri) { badCorners++; continue; }
        b = [b0, b1, 1 - b0 - b1];
      }
      if (!(s >= 0 && s < nTri)) { badCorners++; continue; }
      maxBaryOut = Math.max(maxBaryOut, -Math.min(...b));
      if (tri[v] < 0) { tri[v] = s; w[3 * v] = b[0]; w[3 * v + 1] = b[1]; w[3 * v + 2] = b[2]; }
    }
  }
  // Cutter / tool vertices: tie through a skin vertex at the same position (the seam loop).
  // With numProp 3 the seam is one shared vertex; with properties Manifold splits it, so
  // match by exact position.
  const key = (v) => `${vp[v * np]},${vp[v * np + 1]},${vp[v * np + 2]}`;
  const byPos = new Map();
  for (let v = 0; v < nV; v++) if (tri[v] >= 0) byPos.set(key(v), v);
  const toolVert = new Uint8Array(nV), skinVert = new Uint8Array(nV);
  for (let t = 0; t < nT; t++) for (let j = 0; j < 3; j++) (skinTri[t] ? skinVert : toolVert)[tv[3 * t + j]] = 1;
  let seam = 0, untiedTool = 0;
  const viaSeam = new Uint8Array(nV);
  for (let v = 0; v < nV; v++) {
    if (!toolVert[v] || tri[v] >= 0) { if (toolVert[v] && tri[v] >= 0) { seam++; viaSeam[v] = 1; } continue; }
    const u = byPos.get(key(v));
    if (u !== undefined) { tri[v] = tri[u]; w.set(w.subarray(3 * u, 3 * u + 3), 3 * v); seam++; viaSeam[v] = 1; } else untiedTool++;
  }
  let untiedSkin = 0;
  for (let v = 0; v < nV; v++) if (skinVert[v] && tri[v] < 0) untiedSkin++;
  return { tri, w, skinVert, toolVert, viaSeam, nV, nT, seam, untiedTool, untiedSkin, badCorners, maxBaryOut };
}

// ---------- per move ----------
// Place every vertex (untied ones stay at rest), then area-weighted vertex normals over the
// output triangles. Returns positions (Float32, per output vertex) and normals.
function placeAll(tie, g, L) {
  const np = g.numProp, vp = g.vertProperties, I = plan.indices;
  const out = new Float32Array(tie.nV * 3);
  for (let v = 0; v < tie.nV; v++) {
    const s = tie.tri[v];
    if (s < 0) { out[3 * v] = vp[v * np]; out[3 * v + 1] = vp[v * np + 1]; out[3 * v + 2] = vp[v * np + 2]; continue; }
    const a = 3 * I[3 * s], b = 3 * I[3 * s + 1], c = 3 * I[3 * s + 2];
    const w0 = tie.w[3 * v], w1 = tie.w[3 * v + 1], w2 = tie.w[3 * v + 2];
    out[3 * v] = w0 * L[a] + w1 * L[b] + w2 * L[c];
    out[3 * v + 1] = w0 * L[a + 1] + w1 * L[b + 1] + w2 * L[c + 1];
    out[3 * v + 2] = w0 * L[a + 2] + w1 * L[b + 2] + w2 * L[c + 2];
  }
  return out;
}
function normalsOf(pos, tv, nV) {
  const n = new Float32Array(nV * 3);
  for (let t = 0; t < tv.length; t += 3) {
    const a = 3 * tv[t], b = 3 * tv[t + 1], c = 3 * tv[t + 2];
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) { n[k] += nx; n[k + 1] += ny; n[k + 2] += nz; }
  }
  for (let i = 0; i < n.length; i += 3) { const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1; n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; }
  return n;
}

// ---------- point-to-surface distance on a triangle soup (uniform grid) ----------
function surfaceIndex(P, I, cell = 2) {
  let lo = [Infinity, Infinity, Infinity];
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) lo[k] = Math.min(lo[k], P[i + k]);
  lo = lo.map((x) => x - cell);
  const grid = new Map();
  const ck = (i, j, k) => (i * 4096 + j) * 4096 + k;
  for (let t = 0; t < I.length; t += 3) {
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) { const x = P[3 * I[t + j] + k]; mn[k] = Math.min(mn[k], x); mx[k] = Math.max(mx[k], x); }
    const a = mn.map((x, k) => Math.floor((x - lo[k]) / cell)), b = mx.map((x, k) => Math.floor((x - lo[k]) / cell));
    for (let i = a[0]; i <= b[0]; i++) for (let j = a[1]; j <= b[1]; j++) for (let k = a[2]; k <= b[2]; k++) {
      const key = ck(i, j, k); let l = grid.get(key); if (!l) grid.set(key, (l = [])); l.push(t / 3);
    }
  }
  return { P, I, lo, cell, grid, ck };
}
function triDist2(P, I, t, p) {   // squared distance from p to triangle t (Ericson's closest point)
  const A = [P[3 * I[3 * t]], P[3 * I[3 * t] + 1], P[3 * I[3 * t] + 2]], B = [P[3 * I[3 * t + 1]], P[3 * I[3 * t + 1] + 1], P[3 * I[3 * t + 1] + 2]], C = [P[3 * I[3 * t + 2]], P[3 * I[3 * t + 2] + 1], P[3 * I[3 * t + 2] + 2]];
  const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]], dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const ab = sub(B, A), ac = sub(C, A), ap = sub(p, A);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  let q;
  if (d1 <= 0 && d2 <= 0) q = A;
  else {
    const bp = sub(p, B), d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) q = B;
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); q = [A[0] + v * ab[0], A[1] + v * ab[1], A[2] + v * ab[2]]; }
      else {
        const cp = sub(p, C), d5 = dot(ab, cp), d6 = dot(ac, cp);
        if (d6 >= 0 && d5 <= d6) q = C;
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); q = [A[0] + w * ac[0], A[1] + w * ac[1], A[2] + w * ac[2]]; }
          else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); q = [B[0] + w * (C[0] - B[0]), B[1] + w * (C[1] - B[1]), B[2] + w * (C[2] - B[2])]; }
            else { const den = 1 / (va + vb + vc), v = vb * den, w = vc * den; q = [A[0] + ab[0] * v + ac[0] * w, A[1] + ab[1] * v + ac[1] * w, A[2] + ab[2] * v + ac[2] * w]; }
          }
        }
      }
    }
  }
  const d = sub(p, q); return dot(d, d);
}
function distTo(S, p) {
  const c = [0, 1, 2].map((k) => Math.floor((p[k] - S.lo[k]) / S.cell));
  let best = Infinity;
  for (let r = 0; r < 40; r++) {
    for (let i = c[0] - r; i <= c[0] + r; i++) for (let j = c[1] - r; j <= c[1] + r; j++) for (let k = c[2] - r; k <= c[2] + r; k++) {
      if (Math.max(Math.abs(i - c[0]), Math.abs(j - c[1]), Math.abs(k - c[2])) !== r) continue;
      const l = S.grid.get(S.ck(i, j, k)); if (!l) continue;
      for (const t of l) best = Math.min(best, triDist2(S.P, S.I, t, p));
    }
    if (best <= (r * S.cell) ** 2) break;
  }
  return Math.sqrt(best);
}

// ---------- truth: the part's own full kernel build at pose 1 ----------
function trueBuild(extra) {
  kernel.beginSubPart("hand");
  try {
    const d = resolveParams(hand, P1).d;
    let s = hand.parts.hand.build(kernel, P1, d);
    if (extra) s = extra(kernel, s);
    const m = s.toMesh({ quality: "preview" });
    const P = m.positions, I = m.indices ?? Uint32Array.from({ length: P.length / 3 }, (_, i) => i);
    return surfaceIndex(P, I);
  } finally { kernel.endSubPart(); kernel.cleanup?.(); }
}
const planSurface1 = (() => { const L = applySubdivPlan(plan, s1.points).positions; return surfaceIndex(L, plan.indices); })();

// ---------- the cases ----------
// Tools, in the authoring frame: a sphere on the palm's front (the palm faces -Y), and a
// stress case, a sphere on the index finger's first segment, which moves with the curl.
const indexX = (-78 / 2 + (78 / 4) * 3.5) * 1.08;
const CASES = [
  { name: "wrist cut (the part)", tool: (m) => m.subtract(wristCutter(m)), truth: null },
  {
    name: "wrist cut + union sphere r8 on the palm",
    tool: (m) => m.subtract(wristCutter(m)).add(Manifold.sphere(8, 48).translate([0, -13, 70])),
    truth: (k, s) => s.union(k.sphere(8).translate([0, -13, 70])),
  },
  {
    // The cap is a plane the curl moves across: a z-slab through the index finger's first
    // segment (above z = 128), so the cut's position on the finger changes with the pose.
    name: "stress: cut the index finger above z = 128 (the curl moves it)",
    tool: (m) => m.subtract(wristCutter(m)).subtract(Manifold.cube([24, 80, 100]).translate([indexX - 12, -40, 128])),
    truth: (k, s) => s.cut(k.box({ min: [indexX - 12, -40, 128], max: [indexX + 12, 40, 228] })),
  },
  {
    // A union whose tool sits on moving skin: the sphere's own vertices are not on the
    // surface, so they are kept at rest here and left behind by the finger.
    name: "stress: union sphere r6 on the index finger's first segment",
    tool: (m) => m.subtract(wristCutter(m)).add(Manifold.sphere(6, 40).translate([indexX, -15, 125])),
    truth: (k, s) => s.union(k.sphere(6).translate([indexX, -15, 125])),
  },
];

const L1 = applySubdivPlan(plan, s1.points).positions;
const results = [];
for (const layout of ["faceID", "cornerProps"]) {
  for (const c of CASES) {
    const oid = Manifold.reserveIDs(1);
    const body = layout === "faceID" ? importFaceID(rest.positions, rest.indices, oid) : importCornerProps(rest.positions, rest.indices, oid);
    const res = c.tool(body);
    const g = res.getMesh();
    const tie = readTie(g, layout, oid);
    let truth;
    try { truth = trueBuild(c.truth); } catch (e) { console.log(`  truth build failed for ${c.name}: ${e.message}`); }
    const placed = placeAll(tie, g, L1);
    const st = { skin: [], seam: [], tool: [], skinPlan: [], restSkin: [] };
    const vpp = g.vertProperties, npp = g.numProp;
    for (let v = 0; v < tie.nV; v++) {
      const p = [placed[3 * v], placed[3 * v + 1], placed[3 * v + 2]];
      const dT = truth ? distTo(truth, p) : NaN;
      if (tie.skinVert[v] && !tie.toolVert[v]) { st.skin.push(dT); st.skinPlan.push(distTo(planSurface1, p)); if (truth) st.restSkin.push(distTo(truth, [vpp[v * npp], vpp[v * npp + 1], vpp[v * npp + 2]])); }
      else if (tie.viaSeam[v]) st.seam.push(dT);
      else if (tie.toolVert[v]) st.tool.push(dT);
    }
    const sum = (a) => ({ n: a.length, max: a.length ? a.reduce((x, y) => Math.max(x, y), -Infinity) : NaN, mean: a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN });
    // Cost per move: plan apply + place + normals, median of 20.
    const times = [];
    for (let i = 0; i < 21; i++) {
      const t0 = performance.now();
      const L = applySubdivPlan(plan, s1.points).positions;
      const pp = placeAll(tie, g, L);
      normalsOf(pp, g.triVerts, tie.nV);
      if (i) times.push(performance.now() - t0);
    }
    const tA = [], tP = [];
    for (let i = 0; i < 21; i++) {
      let t0 = performance.now(); const L = applySubdivPlan(plan, s1.points).positions; const t1 = performance.now();
      placeAll(tie, g, L); normalsOf(placeAll(tie, g, L), g.triVerts, tie.nV); const t2 = performance.now();
      if (i) { tA.push(t1 - t0); tP.push((t2 - t1) / 2); }
    }
    results.push({ layout, case: c.name, nV: tie.nV, nT: tie.nT, untiedSkin: tie.untiedSkin, untiedTool: tie.untiedTool, badCorners: tie.badCorners, maxBaryOut: tie.maxBaryOut,
      skin: sum(st.skin), restSkin: sum(st.restSkin), skinVsPlan: sum(st.skinPlan), seam: sum(st.seam), tool: sum(st.tool), moveMs: median(times), applyMs: median(tA), placeNormalsMs: median(tP) });
    g.delete?.(); res.delete?.(); body.delete?.();
  }
}

// Cage code (the probe's share of a move): run the part's cage code + snapshot.
const tc = [];
for (let i = 0; i < 21; i++) { const t0 = performance.now(); cageAt({ ...P1, indexCurl: 60 + 0.1 * i }); if (i) tc.push(performance.now() - t0); }

for (const r of results) {
  console.log(`\n[${r.layout}] ${r.case}: ${r.nT} output triangles, ${r.nV} output vertices`);
  console.log(`  untied: skin ${r.untiedSkin}, tool (cutter/sphere, off the seam) ${r.untiedTool}; bad corners ${r.badCorners}; worst negative weight ${f(r.maxBaryOut, 6)}`);
  console.log(`  (control) skin left at rest  n ${r.restSkin.n}  max ${f(r.restSkin.max)}  mean ${f(r.restSkin.mean, 4)} mm  <- what not moving would cost`);
  console.log(`  skin vs true pose-1 build    n ${r.skin.n}  max ${f(r.skin.max, 6)}  mean ${f(r.skin.mean, 6)} mm`);
  console.log(`  skin vs plan surface pose 1  n ${r.skinVsPlan.n}  max ${f(r.skinVsPlan.max, 6)}  mean ${f(r.skinVsPlan.mean, 6)} mm`);
  console.log(`  seam (tool verts on skin)    n ${r.seam.n}  max ${f(r.seam.max, 4)}  mean ${f(r.seam.mean, 4)} mm`);
  console.log(`  tool verts kept at rest      n ${r.tool.n}  max ${f(r.tool.max)}  mean ${f(r.tool.mean, 4)} mm`);
  console.log(`  per move: ${f(r.moveMs, 1)} ms (plan apply ${f(r.applyMs, 1)}, place + normals ${f(r.placeNormalsMs, 1)})`);
}
console.log(`\ncage code + snapshot per move: ${f(median(tc), 2)} ms (median of 20)`);
console.log(`Node ${process.version}, wall ms (performance.now)`);
