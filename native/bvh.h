// C interface to the C++ port of partforge's triangle BVH and min-wall pass
// (src/framework/oracle/bvh.js and min-wall.js) — the hot path of the
// oracle's measure/verify.
//
// One interface, two builds: WASM (src/framework/core/) for every JS host,
// and native code in an app that binds these calls into its JS engine.
//
// Results come back through caller-provided double buffers so the same calls
// work from WASM linear memory and from a native binding.
#pragma once
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct BVH BVH;

// Build over `count` triangles, 9 coords each (v0,v1,v2 interleaved, mesh
// order) — bvh.js's triangleVertices() layout. `f64` says whether `verts`
// holds doubles (an OCCT / plain-number mesh) or floats (a Manifold soup).
// `adopt`: the BVH takes ownership of `verts` and frees it with free();
// otherwise it copies.
BVH* bvh_build(void* verts, uint32_t count, int32_t f64, int32_t adopt);
uint32_t bvh_triangle_count(const BVH*);
// out[6]: the root node's AABB.
void bvh_root_bounds(const BVH*, double* out);

// raycast: returns the hit triangle or -1; out[0] = t.
int32_t bvh_raycast(const BVH*, const double* origin, const double* dir,
                    double tMin, double tMax, int32_t skipTri, double* out);
// closestPoint: returns the triangle or -1; out = [px, py, pz, dist].
int32_t bvh_closest_point(const BVH*, const double* p, double* out);
// distanceTo: returns 0 for an empty mesh (distance Infinity), else 1;
// out = [distance, atx, aty, atz, ax, ay, az, bx, by, bz].
int32_t bvh_distance_to(const BVH*, const BVH* other, double* out);

// minWall (min-wall.js) over this BVH's own mesh. hasMaxThickness 0 = the
// default cap (root-bounds diagonal + 1); otherwise maxThickness as given
// (NaN included — the JS honours a NaN cap, which finds nothing). hasBand with bandMin/bandMax is the
// declared wall band. Returns 0 for an empty mesh (minWall's null), else 1;
// out = [value (NaN = null), locx, locy, locz, sampled, sampledTriangles,
//        totalTriangles, bandValue (NaN = null), bandLocx, bandLocy, bandLocz,
//        members]   (a location's x is NaN when it is null)
int32_t bvh_min_wall(const BVH*, int32_t hasMaxThickness, double maxThickness, double maxSamples,
                     int32_t hasBand, double bandMin, double bandMax, double* out);

// A hash of the tree itself (node boxes, links, leaf order) — for tests that
// hold this build to bvh.js's, node for node.
uint32_t bvh_fingerprint(const BVH*);

void bvh_destroy(BVH*);

#ifdef __cplusplus
}
#endif
