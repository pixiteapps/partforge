// src/framework/oracle/min-wall.js
// Min wall thickness by ray/shot on a triangle BVH (see the spec's spike: this beat the
// voxel/SDF approach on both accuracy and speed). For each surface triangle, cast a ray
// inward (reverse of its outward normal) from the centroid; the nearest hit is the local
// material thickness. The minimum across samples is the reported min wall.
// Works with both Manifold non-indexed meshes and OCCT indexed meshes (via the BVH's
// flat vertex store — never materialize a triangle-per-object list here, that is the
// allocation this pass exists to avoid).
//
// SAMPLING CONTRACT. One ray per triangle is unbounded work, and a dense mesh makes it
// the dominant cost of the inspect job: ~1.9 s and hundreds of megabytes of transient
// garbage at 400k triangles on a laptop, several times that on a phone. Past
// MAX_SAMPLES triangles the pass casts from a spread subset instead, and SAYS SO —
// the result always carries { sampled, sampledTriangles, totalTriangles }, so a
// report consumer can tell a guaranteed minimum from a lower-confidence one. A
// sampled reading is an upper bound on the true minimum: it can miss a thin spot,
// never invent one. `sampledTriangles` is the SAMPLE BUDGET — how many triangles
// the walk selected — not a count of rays actually cast: a degenerate (zero-area)
// triangle has no normal to cast along and is skipped without a ray.
//
// Only an EMPTY mesh reads as no result at all (`null`). A mesh whose sampled rays
// all miss returns the usual object with `value: null`, because the sampling
// accounting is exactly what a reader needs in that case — "we looked at 50k of
// 400k triangles and found no wall" is a very different statement from "nobody
// measured", and the two used to be indistinguishable downstream.
import { buildBVH, readTriangleInto } from "./bvh.js";

// Triangle budget above which minWall samples. Chosen so the parts people actually
// author stay exact: everything in src/parts/ is 200–10,000 triangles, and a
// preview-quality mesh of a fairly ornate part lands in the low tens of thousands.
// 50,000 is comfortably above both while capping the pass at roughly a quarter
// second — dense enough meshes (a high-facet lathe, a big imported STEP tessellation)
// are the only ones that engage it. Override per call with `{ maxSamples }`.
const MAX_SAMPLES = 50_000;

// The budget for a min-wall reading NOTHING GATES ON — a fact the report carries so
// the model can notice a thin feature, rather than a number a declared minimum is
// checked against. A tenth the rays, and the reading is stamped `sampled` either way,
// so no consumer can mistake it for exact. measure() picks between the two by asking
// gates.js whether the part declares a min-wall gate; a part that does gets
// MAX_SAMPLES, unchanged.
//
// The win is real but bounded, and the bound is worth knowing before tuning this
// number: the RAYS get ten times cheaper, the BVH they cast into does not, and it is
// roughly half the pass. Measured on src/parts/screw.js (210k triangles, same code
// path, gated vs not): measure() 837 ms → 458 ms, reporting the identical 0.008 mm.
// Dropping the index too means not measuring min wall at all, which is the quick
// lap's business (see jobs.js), not this constant's.
const DIAGNOSTIC_SAMPLES = 5_000;

export { MAX_SAMPLES, DIAGNOSTIC_SAMPLES };

const gcd = (a, b) => { while (b) { const t = a % b; a = b; b = t; } return a; };

// Stride for the sampling walk: near n/φ and coprime to n, so stepping by it visits
// a permutation of the triangle list — the first `budget` steps are distinct and, by
// the three-distance theorem, near-uniformly spread over the WHOLE mesh (measured
// max gap on a 480-triangle mesh sampled 100 times: 8). A contiguous slice would
// read one region of the surface, and a plain n/budget stride can beat against a
// mesh's own periodicity (a lathed part's segment count) and sample one side of it.
// No RNG anywhere, so the same mesh always reads the same wall.
function sampleStride(n) {
  let s = Math.max(1, Math.round(n * 0.6180339887498949)) % n || 1;
  while (gcd(s, n) !== 1) s = s + 1 < n ? s + 1 : 1;
  return s;
}

// Membership window for a declared wall band: a ray reading inside
// [BAND_FLOOR × min, BAND_CEIL × max] belongs to that wall; anything outside is another
// feature (a thinner floor, a solid boss) and is ignored. Constants, not knobs: a part
// that needs two bands declares two sub-parts.
export const BAND_FLOOR = 0.75;
export const BAND_CEIL = 1.5;

// `bvh` is an already-built index for THIS mesh — one mesh, one index, so there is
// nothing to key here: measure() resolves it out of the Map it shares with meshGaps
// (see cachedBVH for why that Map is the caller's) and passes the value. Omit it and
// one is built. It does not interact with sampling — sampling picks WHICH rays to
// cast, not how the index is built, so a shared BVH is equally valid sampled or exact.
export function minWall(mesh, { maxThickness, maxSamples = MAX_SAMPLES, bvh = buildBVH(mesh), band = null } = {}) {
  const n = bvh.triangleCount;
  if (n === 0) return null;
  const V = bvh.vertices;

  // bbox diagonal as the default cap (a ray exiting into open air gets no hit
  // anyway). The BVH's root node bounds ARE that box, already computed — rescanning
  // mesh.positions would be an O(n) pass on the hot path for a number we have. (On
  // an indexed mesh they are also marginally tighter, since unreferenced vertices
  // are not in the tree; that only shrinks a ray cap, never a reading.)
  if (maxThickness == null) {
    const rb = bvh.rootBounds;
    maxThickness = Math.hypot(rb[3] - rb[0], rb[4] - rb[1], rb[5] - rb[2]) + 1;
  }

  // `maxSamples: 0` (or any non-positive) is the explicit "no cap, cast everything"
  // escape hatch — the exact reading, however long it takes.
  const budget = maxSamples > 0 && n > maxSamples ? Math.floor(maxSamples) : n;
  const sampled = budget < n;
  const stride = sampled ? sampleStride(n) : 1;   // stride 1 = every triangle, in mesh order

  // Band tracking: the member farthest from the band, or — while every member is
  // inside it — farthest from its midpoint. One comparison per ray, no new rays.
  const bandLo = band ? BAND_FLOOR * band.min : 0, bandHi = band ? BAND_CEIL * band.max : 0;
  const bandMid = band ? (band.min + band.max) / 2 : 0;
  let bandWorst = -1, bandValue = null, bandLoc = null, members = 0;
  const bandScore = (x) => x > band.max ? 1 + (x - band.max) : x < band.min ? 1 + (band.min - x) : Math.abs(x - bandMid) / (band.max - band.min + 1e-9);

  let best = Infinity, loc = null, t = 0;
  const tri = new Float64Array(9);                  // reused per triangle; no per-ray garbage
  for (let s = 0; s < budget; s++, t = t + stride < n ? t + stride : t + stride - n) {
    readTriangleInto(V, t, tri);
    const v0x = tri[0], v0y = tri[1], v0z = tri[2];
    const e1x = tri[3] - v0x, e1y = tri[4] - v0y, e1z = tri[5] - v0z;
    const e2x = tri[6] - v0x, e2y = tri[7] - v0y, e2z = tri[8] - v0z;
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) continue;                       // degenerate triangle: no normal, no ray
    nx /= len; ny /= len; nz /= len;                // outward normal (manifold winding)
    const c = [(v0x + tri[3] + tri[6]) / 3, (v0y + tri[4] + tri[7]) / 3, (v0z + tri[5] + tri[8]) / 3];
    const dir = [-nx, -ny, -nz];                    // inward
    const origin = [c[0] + dir[0] * 1e-4, c[1] + dir[1] * 1e-4, c[2] + dir[2] * 1e-4];
    const hit = bvh.raycast(origin, dir, { tMax: maxThickness, skipTri: t });
    if (hit && hit.t < best) { best = hit.t; loc = c; }
    if (band && hit && hit.t >= bandLo && hit.t <= bandHi) {
      members++;
      const s = bandScore(hit.t);
      if (s > bandWorst) { bandWorst = s; bandValue = hit.t; bandLoc = c; }
    }
  }
  // No hit anywhere still reports HOW it looked (see the header): a `value: null`
  // with the sampling accounting intact, never a bare null that reads downstream as
  // "min wall was never measured".
  return {
    value: best === Infinity ? null : best, location: loc, sampled, sampledTriangles: budget, totalTriangles: n,
    band: band ? { value: bandValue, location: bandLoc, members } : null,
  };
}
