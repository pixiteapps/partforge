// partforge/oracle — types for the oracle's own entry (src/oracle.js).
//
// The declarations themselves live in testing.d.ts, where this surface was first
// published; this file re-exports exactly the names src/oracle.js exports, plus the
// report/mask/gap types a caller needs to annotate results. The semantic mesh
// oracle (`describe`) is its own closed package now — its types ship with it, and
// the direction of this seam is what lets that package consume these helpers.
import type { CameraCue, Easing, Keyframes, ParamValue, PartDefinition } from "./part.js";
export type { GeometryKernel, Mesh, PartDefinition, ResolvedParams, Solid } from "./testing.js";
export {
  // measurement + verification
  measure, verify, buildView,
  type MeasureReport, type SubPartFacts, type SheetFacts, type AggregateFacts, type BuiltSubPart,
  type VerifyReport, type VerifyCaseResult, type VerifyCheck, type CheckStatus,
  // change tracking
  createChangeTracker,
  type ChangeTracker, type ChangesReport, type SubPartChange, type ChangeRegion, type ChangeOpRef,
  // mesh facts, gaps, BVH, min wall
  meshVolume, bboxSize, bounds, meshArea, assemblyGaps, meshGaps, buildBVH, meshTriangles, minWall, overhang,
  // the native core's switch
  setCoreEnabled, coreStatus, onCoreFallback, CORE_FALLBACK_REASONS,
  type CoreStatus, type CoreFallback, type CoreFallbackReason,
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

/** One step of a normalized animation (every optional field filled in). */
export interface NormalizedAnimationStep {
  /** `null` for the single anonymous step of a bare-`tracks` animation. */
  label: string | null;
  duration: number;
  easing: Easing;
  tracks: Record<string, Keyframes>;
  opacity: Record<string, Keyframes>;
  camera: CameraCue | null;
}

/** A camera cue on the normalized timeline: fires at `t`, sweeping for `sweep` seconds. */
export interface NormalizedAnimationCue {
  t: number;
  view: CameraCue;
  /** Seconds; `null` for a lone intro angle. */
  sweep: number | null;
}

/** An animation in the canonical shape every consumer (playback, lint, CLI, preview) works against. */
export interface NormalizedAnimation {
  name: string;
  label: string;
  description: string | null;
  loop: boolean;
  autoplay: boolean;
  steps: NormalizedAnimationStep[];
  /** Each step's start as normalized t. */
  stepStarts: number[];
  /** Seconds. */
  totalDuration: number;
  cues: NormalizedAnimationCue[];
  /** Params any step tracks. */
  trackedKeys: string[];
  /** Sub-parts any step fades. */
  opacityKeys: string[];
}

/** One sampled instant of a baked preview animation. */
export interface PreviewAnimationSample {
  /** Normalized time in [0, 1]. */
  t: number;
  /** Sub-part name → column-major model-frame place matrix (16 numbers). */
  poses: Record<string, number[]>;
  /** Sub-part name → opacity 0–1; `{}` when the animation declares no fades. */
  opacity: Record<string, number>;
}

/** What `samplePreviewAnimation` returns for a bakeable autoplay animation. */
export interface PreviewAnimationInput {
  anim: NormalizedAnimation;
  /** Sorted by `t`; the first has `t === 0`, the last `t === 1`. */
  samples: PreviewAnimationSample[];
  /** Sub-part name → place matrix at the params handed in. */
  base: Record<string, number[]>;
}

/** Sampling grid rate over the animation's real duration, in Hz. */
export const PREVIEW_SAMPLE_HZ: 30;
/** Most samples one preview animation carries; the grid thins, keyframe times never do. */
export const PREVIEW_SAMPLE_CAP: 600;

/**
 * Decide whether the view's autoplay animation can be baked into the preview
 * GLB — every tracked param place-only (the build reads none, and place() is a
 * rigid motion at every sample) and the shown sub-parts constant — and if so
 * sample the place matrices along its timeline. `buildReads(name)` returns the
 * param keys that sub-part's build read, or `null` when unknown. Returns `null`
 * when there is no autoplay animation or any check fails; never throws.
 */
export function samplePreviewAnimation(
  part: PartDefinition,
  view: string,
  params?: Record<string, ParamValue>,
  options?: { buildReads: (name: string) => ReadonlySet<string> | null },
): PreviewAnimationInput | null;
