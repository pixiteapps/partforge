// partforge/oracle — the geometric oracle as its own published entry.
//
// This is the SEAM between the oracle and everything that consumes it. The same
// modules serve three callers: the geometry worker lazy-loads them per job family
// (see jobs.js — an `inspect` pulls measure/verify/build, and the generate/export
// hot path pulls none), the CLI and Node harnesses import them here directly, and
// partforge/testing re-exports this whole surface so an existing downstream import
// keeps working. Everything below is DOM-free, three-free and node:-free —
// test/oracle-entry.test.js walks the closure and holds that, so the entry stays
// importable from a worker, a browser, or Node alike.
//
// The SEMANTIC MESH ORACLE (imported mesh -> feature report) is NOT here, and this
// framework has no verb, job or import for it: it is its own closed package, which
// peer-depends on this one and consumes exactly this entry — the mesh/BVH helpers
// and file parsers below are exported for it. A host that installs it registers its
// job through the generic `runWorker(part, { jobs })` seam (jobs.js).
export { assemblyGaps, meshGaps } from "./framework/oracle/gaps.js";
export { meshVolume, bboxSize, bounds, meshArea } from "./framework/oracle/mesh.js";
export { buildView } from "./framework/oracle/build.js";
export { measure } from "./framework/oracle/measure.js";
export { verify } from "./framework/oracle/verify.js";
export { buildBVH, meshTriangles } from "./framework/oracle/bvh.js";
export { minWall } from "./framework/oracle/min-wall.js";
export { overhang } from "./framework/oracle/overhang.js";
// Mesh file parsers — the import pipeline's own readers, browser-safe pure
// functions; the oracle package's corpus tests read real files through them.
export { parseStl } from "./framework/geometry/stl-parse.js";
export { parse3MF } from "./framework/geometry/threemf-parse.js";
// Silhouette match scoring — the `inspect` job scores `matchTargets` with exactly
// these, re-exported so a downstream harness can reproduce a score outside the job loop.
export { MATCH_VIEWS, rasterizeMeshMask, rasterizeRingsMask } from "./framework/oracle/silhouette.js";
export { matchMasks, matchViews } from "./framework/oracle/match.js";
// Sketch-annotation ray reconstruction — the consumer-side half of the
// annotation payload's camera block: rebuild the pick ray for any screen
// point, intersect it with a plane in parts-frame millimetres.
export { annotationRay, rayPlane } from "./framework/oracle/annotation-ray.js";
