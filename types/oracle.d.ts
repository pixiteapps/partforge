// partforge/oracle — types for the oracle's own entry (src/oracle.js).
//
// The declarations themselves live in testing.d.ts, where this surface was first
// published; this file re-exports exactly the names src/oracle.js exports, plus the
// report/mask/gap types a caller needs to annotate results. The semantic mesh
// oracle (`describe`) is its own closed package now — its types ship with it, and
// the direction of this seam is what lets that package consume these helpers.
import type { CameraCue, Easing, Keyframes, ParamValue, PartDefinition } from "./part.js";
import type { GeometryKernel } from "./testing.js";
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
  setCoreEnabled, coreStatus, onCoreFallback, CORE_FALLBACK_REASONS, loadFullCore, loadMeshFieldBuilder,
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
 * Decide whether one of the view's animations can be baked into the preview
 * GLB — every tracked param place-only (the build reads none, and place() is a
 * rigid motion at every sample) and the shown sub-parts constant — and if so
 * sample the place matrices along its timeline. `buildReads(name)` returns the
 * param keys that sub-part's build read, or `null` when unknown. `animation`
 * (0.194.0) names the animation: omitted (or `undefined`), the view's autoplay
 * animation; a string, that animation of this view whether or not it autoplays.
 * Returns `null` when there is no such animation or any check fails; never throws.
 */
export function samplePreviewAnimation(
  part: PartDefinition,
  view: string,
  params?: Record<string, ParamValue>,
  options?: { buildReads: (name: string) => ReadonlySet<string> | null; animation?: string },
): PreviewAnimationInput | null;

/** One animation in `listViewAnimations`' catalog. */
export interface ViewAnimationEntry {
  /** The key it is declared under in the view's `animations`. */
  name: string;
  /** Its `label`, else its name. */
  label: string;
  autoplay: boolean;
}

/** One view in `listViewAnimations`' catalog. */
export interface ViewCatalogEntry {
  /** The key it is declared under in `views`. */
  name: string;
  /** Its `label`, else its name. */
  label: string;
  /** In declaration order; `[]` when the view declares none. */
  animations: ViewAnimationEntry[];
}

/** What `listViewAnimations` returns. */
export interface ViewAnimationCatalog {
  /** The view `mount()` opens on (`resolveDefaultView`); `null` for a part with no views. */
  defaultView: string | null;
  /** Every view, in declaration order. */
  views: ViewCatalogEntry[];
}

/**
 * 0.194.0: every view of a part and the animations each declares, in declaration
 * order, plus the default view — the names a host keys a per-(view, animation)
 * preview cache on. Pure: no kernel, no build. A malformed animation is left out,
 * as the viewer leaves it out (lint reports it).
 */
export function listViewAnimations(part: PartDefinition): ViewAnimationCatalog;

/**
 * The params a preview file's meshes sit at: `{ ...part.defaults, ...params }` with
 * the t = 0 values of the animation the file bakes over them. `anim` is that
 * animation (`samplePreviewAnimation(...)?.anim`), or `null` when the file bakes none
 * (the live params alone); omitted, the view's autoplay animation is assumed baked.
 */
export function openingParams(
  part: PartDefinition,
  view: string,
  params?: Record<string, ParamValue>,
  anim?: NormalizedAnimation | null,
): Record<string, ParamValue>;

/** What `dragHandle` plays: one handle, a target, and where the drag starts. */
export interface DragRequest {
  /** The handle id (a key of the part's `handles`). */
  handle: string;
  /** point / goal / angles: where the grab point goes. An axis drag projects it onto its axis line, a plane drag onto its plane. */
  to?: [number, number, number];
  /** rotary: degrees about the handle's axis, right-handed; accumulated, so 720 is two turns. */
  turn?: number;
  /** goal / angles: the joint (or "tip") grabbed. Default: a goal handle's `at`, an angles limb's tip. */
  grab?: string;
  /** Starting param overrides, merged over the part's defaults. */
  params?: Record<string, ParamValue>;
  /** The view the drag happens in (default the part's first); it must show the handle. */
  view?: string;
  /** Frames from start to target, each solved warm from the last (default 12). */
  steps?: number;
}

/** A played drag. Points are part coordinates in mm, rounded to 0.001. */
export interface DragResult {
  handle: string;
  /** The handle's drag kind: "point" | "axis" | "plane" | "rotary" | "goal" | "angles". */
  drag: string;
  /** The point grabbed: a joint name or "tip" on a limb, the handle's `at` (or "point") otherwise. */
  grab: string;
  /** The grab point at the starting params. */
  from: [number, number, number];
  /** Where it was asked to go (axis / plane: projected; rotary: the start point turned by `turn`). */
  target: [number, number, number];
  /** The grab point after the release, at the snapped values. */
  reached: [number, number, number];
  /** reached's distance from target, mm (rotary: the arc miss at the grab radius). */
  missMm: number;
  /** The snapped params whose value changed from the start. Empty: the handle wrote nothing. */
  values: Record<string, ParamValue>;
}

/**
 * Play a handle drag the way Pose mode would, with no pins: derive only, no kernel, no
 * browser. Never throws — a bad request or a failed solve returns `{ handle, error }`.
 */
export function dragHandle(part: PartDefinition, request: DragRequest): DragResult | { handle: string; error: string };

/** One pose `measure --ranges` builds: its name and the params it changes from the defaults. */
export interface RangePose {
  name: string;
  params: Record<string, ParamValue>;
}

/** What `sweepRanges` found: the poses that threw, and the cage faces their errors name. */
export interface RangesResult {
  view: string;
  poses: number;
  /**
   * `kind: "error"`: the build threw, and `error` is its first line. `kind: "warning"`: the
   * build warned that a body passes through itself, and `error` is that warning.
   */
  failed: Array<{ name: string; params: Record<string, ParamValue>; kind: "error" | "warning"; error: string }>;
  /** The faces either kind names, most often first; each counted once per pose. */
  faces: Array<{ id: string; count: number }>;
}

/**
 * The poses `measure --ranges` builds: the defaults, each ranged control at its min and max,
 * all at min, all at max, then `random` seeded random poses (default 24, seed 1).
 */
export function rangePoses(part: PartDefinition, opts?: { random?: number; seed?: number }): RangePose[];

/**
 * Build `view` at every pose of `rangePoses` and list the ones that throw, or that warn that
 * a body passes through itself. Other build warnings are not failures.
 */
export function sweepRanges(kernel: GeometryKernel, part: PartDefinition, view?: string, opts?: { random?: number; seed?: number }): RangesResult;

/** One joint of a posed limb in the measure report's `limbs`. */
export interface LimbJointFacts {
  /** The joint's frame name, `<limb>.<joint>`. */
  name: string;
  /** The joint's posed position, in part coordinates. */
  at: [number, number, number];
  /** The distance to the next joint, or to the tip for the last joint. */
  length: number;
  /** The sub-part whose cross-section goes round the joint. Absent when none does. */
  part?: string;
  /** The cross-section's size along the joint's bend axis (frame X). */
  width?: number;
  /** The cross-section's size across the bend axis (frame Z). */
  depth?: number;
}

/** One posed limb in the measure report's `limbs`. Numbers are rounded to 0.1. */
export interface LimbFacts {
  joints: LimbJointFacts[];
  tip: [number, number, number];
}

/** A plain frame: an origin and three unit axes. */
export interface SectionFrame {
  origin: [number, number, number];
  x: [number, number, number];
  y: [number, number, number];
  z: [number, number, number];
}

/**
 * The size of a mesh's cross-section at a frame: the plane through `origin` square to `y`
 * cuts the mesh, and the outline that goes round `origin` is measured along `x` (`width`)
 * and `z` (`depth`). Null when no outline goes round it. Without `indices` the positions are a
 * triangle soup, as a kernel mesh's are.
 */
export function sectionAt(mesh: { positions: ArrayLike<number>; indices?: ArrayLike<number> }, frame: SectionFrame): { width: number; depth: number } | null;

/**
 * The measure report's `limbs`: each posed limb in `d` (a value carrying `bones`, one level
 * deep or in an array there; a limb with a parent is skipped), keyed by its name. Undefined
 * when there is none. `matrix` is the sub-part's column-major place() pose (part to display
 * coordinates), or null. A second limb with a name already reported is named through `warn`.
 */
export function limbFacts(
  d: unknown,
  subparts: Array<{ name: string; mesh: { positions: ArrayLike<number>; indices?: ArrayLike<number> }; matrix: ArrayLike<number> | null }>,
  opts?: { warn?: (message: string) => void },
): Record<string, LimbFacts> | undefined;
