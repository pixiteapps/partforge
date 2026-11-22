// Re-posing a subdivision-cage body's last exact mesh from moved cage points, with no
// kernel (docs/superpowers/specs/2026-11-22-cage-pose-drag-design.md). The skin controller
// (skin-drag.js) holds one CAGE BASE per sub-part: the subdiv plan built from the base
// delivery's own cage snapshot at the ties' level, and the delivery's ties. A deform
// applies the plan to the live cage's points (the smooth surface at the new pose, one
// triangle order for the whole drag), then places every delivered vertex from its tie
// (subdiv/ties.js's rule: x = w0·A + w1·B + (1 − w0 − w1)·C on its limit triangle).
//
// Normals: vertex normals of the moved limit mesh, interpolated with the same weights and
// normalised. A vertex normal is the sum of its triangles' UNIT normals, the rule the exact
// build shades with (creased-normals.js: every incident triangle gets one vote), so at the
// base's own pose the deformed normals are the delivered ones (within 0.03° on the cage
// hand). Area weighting was measured too: 2.25° off at rest at the hand's extraordinary
// points, because the exact build does not weight by area. A cut face's vertices take the
// skin's normal there too (the cut is not redone during a drag; the mesh is display only).
//
// A live cage whose topology is not the base's (an extrude a slider added, a face count
// changed) is refused: deformCage writes nothing and answers false, and the controller
// falls back to the exact build.
//
// Pure: no DOM, no kernel, worker-safe.
import { subdivPlan, applySubdivPlan, topologyKey, sameTopology } from "../geometry/subdiv/surface.js";
import { TIE_WEIGHTS } from "../geometry/subdiv/ties.js";
import { dragValidity } from "../geometry/subdiv/index.js";

const sameFaces = (a, b) => {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const f = a[i], g = b[i];
    if (f.length !== g.length) return false;
    for (let j = 0; j < f.length; j++) if (f[j] !== g[j]) return false;
  }
  return true;
};

// Is `live` the base cage's topology? Exact, never a hash. The common case (the same
// faces listed in the same order, no creases) is answered without re-canonicalising
// the base; anything else goes to sameTopology.
function sameCage(base, live) {
  if (!live || !Array.isArray(live.points) || live.points.length !== base.pointCount) return false;
  const noCreases = !(base.snapshot.creases?.length) && !(live.creases?.length);
  if (noCreases && sameFaces(base.snapshot.faces, live.faces)) return true;
  return sameTopology(base.snapshot, live);
}

/**
 * A cage base for a delivery's ties, or null when the ties were not made against this
 * snapshot's topology (or do not fit its plan).
 * @param {{ points: number[][], faces: number[][], creases?: number[][] }} snapshot  the
 *   cage at the base delivery's own params (its plan's triangle order is the ties')
 * @param {{ key: string, level: number, tri: Uint32Array, w: Float32Array }} ties
 */
export function makeCageBase(snapshot, ties) {
  if (!snapshot || !ties || !(ties.tri instanceof Uint32Array) || !(ties.w instanceof Float32Array)) return null;
  if (ties.w.length !== TIE_WEIGHTS * ties.tri.length) return null;
  if (topologyKey(snapshot) !== ties.key) return null;
  let plan;
  try { plan = subdivPlan(snapshot, ties.level); } catch { return null; }
  const nTri = plan.indices.length / 3;
  for (let v = 0; v < ties.tri.length; v++) if (ties.tri[v] >= nTri) return null;
  let nLimit = 0;
  for (let i = 0; i < plan.indices.length; i++) if (plan.indices[i] >= nLimit) nLimit = plan.indices[i] + 1;
  return {
    snapshot, plan, ties, pointCount: snapshot.points.length,
    // Scratch for the limit mesh's vertex normals, reused by every deform.
    limitNormals: new Float64Array(3 * nLimit),
  };
}

// Vertex normals of a triangle mesh, into `out`: each triangle adds its unit normal to
// its three corners (a degenerate triangle adds nothing), then each sum is normalised.
function vertexNormals(P, I, out) {
  out.fill(0);
  for (let t = 0; t < I.length; t += 3) {
    const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2];
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(l > 0)) continue;
    nx /= l; ny /= l; nz /= l;
    out[a] += nx; out[a + 1] += ny; out[a + 2] += nz;
    out[b] += nx; out[b + 1] += ny; out[b + 2] += nz;
    out[c] += nx; out[c + 1] += ny; out[c + 2] += nz;
  }
  // Normalised before interpolation, so a corner with many triangles around it does not
  // outweigh the vertex's own place on its triangle.
  for (let i = 0; i < out.length; i += 3) {
    const len = Math.sqrt(out[i] * out[i] + out[i + 1] * out[i + 1] + out[i + 2] * out[i + 2]);
    if (len > 0) { out[i] /= len; out[i + 1] /= len; out[i + 2] /= len; }
  }
  return out;
}

/**
 * Whether the base may draw `snapshot`'s pose (the drag validity check, subdiv/index.js's
 * dragValidity, on the base's plan). Undefined when `snapshot` is not the base's topology
 * (deformCage refuses it, and the exact build takes over); null for a valid pose; else
 * `{ message }`, meshSubdiv's own wording.
 */
export function cagePoseValidity(base, snapshot) {
  if (!base || !sameCage(base, snapshot)) return undefined;
  // The plan's triangles name the BASE snapshot's faces (a pose may list them in another order).
  return dragValidity(base.plan, snapshot.points, { ids: base.snapshot.ids ?? [] });
}

/**
 * Every delivered vertex of the base, re-posed on the smooth surface of `snapshot`'s
 * points, into `outPositions` / `outNormals` (3 per vertex, the delivery's layout).
 * @returns {boolean} false, writing nothing, when `snapshot` is not the base's topology
 *   or its points are not usable
 */
export function deformCage(base, snapshot, outPositions, outNormals) {
  if (!base || !sameCage(base, snapshot)) return false;
  const { tri, w } = base.ties;
  if (outPositions.length !== 3 * tri.length || outNormals.length !== 3 * tri.length) return false;
  let L;
  try { L = applySubdivPlan(base.plan, snapshot.points); } catch { return false; }
  const P = L.positions, I = base.plan.indices;
  const N = vertexNormals(P, I, base.limitNormals);
  for (let v = 0; v < tri.length; v++) {
    const s = 3 * tri[v], a = 3 * I[s], b = 3 * I[s + 1], c = 3 * I[s + 2];
    const w0 = w[2 * v], w1 = w[2 * v + 1], w2 = 1 - w0 - w1, o = 3 * v;
    outPositions[o] = w0 * P[a] + w1 * P[b] + w2 * P[c];
    outPositions[o + 1] = w0 * P[a + 1] + w1 * P[b + 1] + w2 * P[c + 1];
    outPositions[o + 2] = w0 * P[a + 2] + w1 * P[b + 2] + w2 * P[c + 2];
    const nx = w0 * N[a] + w1 * N[b] + w2 * N[c];
    const ny = w0 * N[a + 1] + w1 * N[b + 1] + w2 * N[c + 1];
    const nz = w0 * N[a + 2] + w1 * N[b + 2] + w2 * N[c + 2];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    outNormals[o] = nx / len; outNormals[o + 1] = ny / len; outNormals[o + 2] = nz / len;
  }
  return true;
}
