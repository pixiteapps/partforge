// C interface to the C++ port of partforge's creasedNormals
// (src/framework/geometry/creased-normals.js).
//
// One interface, two builds: WASM (src/framework/core/) for every JS host,
// and native code in an app that binds these calls into its JS engine.
//
// cn_create does the topology (merge map, face normals, the shading weld,
// incidence); cn_finish produces the shaded mesh, feature edges and feature
// ids, evaluating the analytic fillet normals itself (blend_surfaces.cpp, the
// port of blend-surfaces.js) from flattened descriptors.
//
// Inputs are NOT copied: every pointer passed to cn_create must stay valid
// until cn_destroy. Every output pointer is owned by the state.
#pragma once
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct CNState CNState;

// Manifold's MeshGL fields, as getMesh() returns them.
CNState* cn_create(const float* vertProperties, uint32_t numProp, uint32_t numVert,
                   const uint32_t* triVerts, uint32_t numTri,
                   const uint32_t* mergeFromVert, const uint32_t* mergeToVert, uint32_t numMerge,
                   const uint32_t* runIndex, const uint32_t* runOriginalID, uint32_t numRun);

// Policy table: one row per original surface id seen in the mesh. Every
// cosine is computed by the CALLER (JS Math.cos), so the C++ never has to
// agree with another libm. flags: bit 0 boundaryLines, bit 1 sameSurfaceLines.
// labelIds: interned feature label per row, -1 for none. The LAST row is the
// SMOOTH default for any surface not in the table (its oid is ignored).
// Fillet surfaces: runDesc (numRun entries) names each run's descriptor, -1
// for none; runXf is each run's 3x4 column-major runTransform (numRun*12);
// descData holds the descriptors back to back in blend_surfaces.h's flat
// layout, descriptor i at [descOffsets[i], descOffsets[i+1]). All may be null
// with numDesc 0 when the mesh has no fillet surfaces.
void cn_finish(CNState*, const uint32_t* oids, const double* creaseCos, const uint8_t* flags,
               const int32_t* labelIds, uint32_t numOids,
               double coplanarCos, double analyticCos,
               const int32_t* runDesc, const double* runXf,
               const double* descData, const uint32_t* descOffsets, uint32_t numDesc);

const float* cn_positions(const CNState*);        // numTri * 9
const float* cn_normals(const CNState*);          // numTri * 9
const float* cn_edges(const CNState*);
uint32_t cn_edge_floats(const CNState*);          // length of cn_edges
const uint16_t* cn_feature_ids(const CNState*);   // numTri, or null when no feature
uint32_t cn_feature_count(const CNState*);
const int32_t* cn_feature_labels(const CNState*); // label id per feature (1-based order)

void cn_destroy(CNState*);

#ifdef __cplusplus
}
#endif
