// partforge/oracle — types for the oracle's own entry (src/oracle.js).
//
// The declarations themselves live in testing.d.ts, where this surface was first
// published; this file re-exports exactly the names src/oracle.js exports, plus the
// report/mask/gap types a caller needs to annotate results. The semantic mesh
// oracle (`describe`) is its own closed package now — its types ship with it, and
// the direction of this seam is what lets that package consume these helpers.
export type { GeometryKernel, Mesh, PartDefinition, ResolvedParams, Solid } from "./testing.js";
export {
  // measurement + verification
  measure, verify, buildView,
  type MeasureReport, type SubPartFacts, type AggregateFacts, type BuiltSubPart,
  type VerifyReport, type VerifyCaseResult, type VerifyCheck, type CheckStatus,
  // mesh facts, gaps, BVH, min wall
  meshVolume, bboxSize, bounds, meshArea, assemblyGaps, meshGaps, buildBVH, meshTriangles, minWall, overhang,
  type Gap, type BVH,
  // mesh file parsers (the import pipeline's own readers)
  parseStl, parse3MF,
  // silhouette match scoring
  MATCH_VIEWS, rasterizeMeshMask, rasterizeRingsMask, matchMasks, matchViews,
  type SilhouetteMask, type MatchScores, type MatchDelta,
  // sketch-annotation rays
  annotationRay, rayPlane,
  type AnnotationRay, type RayPlaneHit, type PlaneSpec,
} from "./testing.js";
