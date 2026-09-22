// partforge/testing — headless helpers for building, measuring and verifying a
// part with no browser.
//
// Most of what this barrel re-exports is NOT test-only: the oracle
// (measure/verify/buildView/gaps/BVH/min-wall) also runs inside the browser
// geometry worker. Only the two kernel booters and the PNG renderer are
// Node-bound.

import type { GeometryKernel, Mesh, Point3, Solid } from "./kernel.js";
import type { Derived, FontSource, PartDefinition, ResolvedParams } from "./part.js";

export type { Derived, GeometryKernel, Mesh, PartDefinition, ResolvedParams, Solid };

// --- kernels ----------------------------------------------------------------

/**
 * Wrap an already-instantiated Manifold WASM module as a `GeometryKernel`.
 * `wasm` is the value of `await Module()` from `manifold-3d`, after `setup()`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the opaque manifold-3d WASM module
export function createManifoldKernel(wasm: any, opts?: { quality?: "preview" | "print" }): GeometryKernel;

/**
 * Boot the Manifold WASM module in a Node process and return a ready kernel.
 * OCCT must NOT be booted in the same process — keep OCCT tests in their own
 * files (vitest isolates per file).
 */
export function bootManifoldKernel(opts?: {
  quality?: "preview" | "print";
  fonts?: Record<string, FontSource>;
}): Promise<GeometryKernel>;

/** Boot OCCT/replicad in a Node process and return a ready kernel. */
export function bootOcctKernel(opts?: { fonts?: Record<string, FontSource> }): Promise<GeometryKernel>;

// --- the job loop -----------------------------------------------------------

/**
 * A reference shape for the `inspect` job to score the part's silhouettes against.
 * A `profile` is millimetres and so is compared at absolute scale too; an `image`
 * is a photo mask with no scale, compared on shape alone.
 */
export type MatchTarget =
  | { kind: "profile"; rings: Array<Array<[number, number]>> }
  | { kind: "image"; mask: { data: Uint8Array; width: number; height: number } };

/** A job the worker loop accepts. */
export interface WorkerJob {
  type: "generate" | "export-stl" | "export-step" | "export-3mf" | "inspect";
  view?: string;
  params?: ResolvedParams;
  /** `generate`: which sub-parts to build. */
  subparts?: string[];
  /** Export: an explicit sub-part selection, overriding the view's. */
  parts?: string[];
  quality?: "preview" | "print";
  cache?: boolean;
  /** Correlation id echoed on every reply. */
  jobId?: number;
  /** Single-file export name base. */
  name?: string;
  /**
   * `inspect`: score the part's six canonical silhouettes against these. Absent or
   * empty leaves `match` off the report entirely.
   *
   * A target that cannot be scored — malformed, or with no foreground to score
   * against — is DROPPED rather than reported as a zero, so `report.match` is not
   * index-aligned with this list. Attribute a result by its `kind` and by the
   * relative order of the targets sharing that kind, never by index.
   */
  matchTargets?: MatchTarget[];
}

/**
 * Run one worker job against `kernel`/`part`, posting replies through `post`.
 * The same loop the geometry Web Worker runs, exposed so a test can exercise an
 * export end to end without a Worker.
 */
export function handle(
  kernel: GeometryKernel,
  part: PartDefinition,
  msg: WorkerJob,
  post: (message: Record<string, unknown>, transfer?: Transferable[]) => void,
  opts?: { isStale?: () => boolean },
): Promise<void>;

// --- the part model ---------------------------------------------------------

/** The sub-parts a view shows, in definition order. */
export function viewSubParts(part: PartDefinition, view: string, params: ResolvedParams): string[];

/** Resolve a part's `derive` into the `d` object builds receive. */
export function resolveDerived(part: Pick<PartDefinition, "derive">, p: ResolvedParams): Derived;

/** Returned instead of a key set when the relevance analysis could not run. */
export const RELEVANT_ALL: unique symbol;

/**
 * Which raw parameters affect the parts on screen in `view` — a `Set` of param
 * keys, or `RELEVANT_ALL` when the build could not be analyzed.
 */
export function relevantParamKeys(
  part: PartDefinition,
  view: string,
  params: ResolvedParams,
): Set<string> | typeof RELEVANT_ALL;

// --- assembly checks --------------------------------------------------------

/** One interpenetrating pair. `location` is the intersection bbox centre. */
export interface Overlap {
  a: string;
  b: string;
  /** Intersection volume in mm³. */
  volume: number;
  location: Point3 | null;
}

/** One measured pair distance. `distance` 0 = touching or interpenetrating. */
export interface Gap {
  a: string;
  b: string;
  distance: number;
  /** The midpoint between the pair's closest surface points. */
  at: Point3 | null;
}

/**
 * Build every sub-part of a view in its assembly pose and return the pairs whose
 * solid-intersection volume exceeds `tolerance` mm³. Manifold-only (needs
 * `Solid.intersect`).
 */
export function assemblyOverlaps(
  kernel: GeometryKernel,
  part: PartDefinition,
  view: string,
  params?: ResolvedParams,
  opts?: { tolerance?: number },
): Overlap[];

/**
 * The complement of `assemblyOverlaps`: sub-part pairs that ALMOST touch
 * (0 < distance < `threshold` mm) in the display pose. Pure mesh math, so it
 * runs on both backends.
 */
export function assemblyGaps(
  kernel: GeometryKernel,
  part: PartDefinition,
  view: string,
  params?: ResolvedParams,
  opts?: { threshold?: number },
): Gap[];

/** One sub-part built in its display pose, as `buildView` returns it. */
export interface BuiltSubPart {
  name: string;
  /** LIVE — valid only until `kernel.cleanup()`. */
  solid: Solid;
  /** JS-owned arrays; survives `cleanup()`. */
  mesh: Mesh;
}

/**
 * Minimum surface-to-surface distance for every pair of pre-built posed meshes.
 * Pairs involving an empty mesh are skipped. `bvhCache` is a caller-owned `Map`
 * so each mesh is indexed once across passes.
 */
export function meshGaps(built: BuiltSubPart[], opts?: { bvhCache?: Map<Mesh, BVH> }): Gap[];

/**
 * Build every sub-part of a view in its display pose. Keeps solids LIVE (does
 * NOT call `kernel.cleanup()`) so callers can read exact solid facts first.
 */
export function buildView(
  kernel: GeometryKernel,
  part: PartDefinition,
  view: string,
  params?: ResolvedParams,
): BuiltSubPart[];

// --- mesh math --------------------------------------------------------------

/** Signed-tetrahedron volume of a triangle mesh. Omit `indices` for a flat soup. */
export function meshVolume(positions: ArrayLike<number>, indices?: ArrayLike<number>): number;

/** `[dx, dy, dz]` extent of a flat position array. */
export function bboxSize(positions: ArrayLike<number>): [number, number, number];

/** World-frame axis-aligned bounds of a flat position array. */
export function bounds(positions: ArrayLike<number>): { min: [number, number, number]; max: [number, number, number] };

/** Total surface area of an indexed (or soup, when `indices` is omitted) triangle mesh, mm². */
export function meshArea(positions: ArrayLike<number>, indices?: ArrayLike<number>): number;

/** Triangles as `[v0, v1, v2]` coordinate triples, from an indexed mesh or a soup. */
export function meshTriangles(mesh: Mesh): [number, number, number][][];

/** Parse a binary or ASCII STL into a welded, indexed mesh. */
export function parseStl(bytes: Uint8Array | ArrayBuffer): { positions: Float32Array; indices: Uint32Array };

/** Parse a 3MF archive's first mesh object into a welded, indexed mesh. */
export function parse3MF(bytes: Uint8Array | ArrayBuffer): { positions: Float32Array; indices: Uint32Array };

// --- the BVH ----------------------------------------------------------------

/** A triangle BVH over one mesh — nearest ray hit, nearest point, exact mesh distance. */
export interface BVH {
  /** Nearest hit along `dir` from `origin`, or `null`. `t` is the distance, `tri` the mesh triangle id. */
  raycast(
    origin: Point3,
    dir: Point3,
    opts?: { tMin?: number; tMax?: number; skipTri?: number },
  ): { t: number; tri: number } | null;
  /** Nearest surface point to `p`. */
  closestPoint(p: Point3): { point: number[] | null; dist: number; tri: number };
  /** Exact minimum surface-to-surface distance to another BVH. */
  distanceTo(other: BVH): {
    distance: number;
    at: number[] | null;
    pointA: number[] | null;
    pointB: number[] | null;
  };
  triangleCount: number;
  /** Flat, 9 coords per triangle, in mesh order. READ-ONLY — writing invalidates the tree. */
  vertices: Float32Array | Float64Array;
  /** The root AABB, `[minx, miny, minz, maxx, maxy, maxz]` (a copy). */
  rootBounds: number[];
  /** Diagnostic self-report of the four typed arrays' byte lengths. */
  bytesAllocated: number;
}

/** Index a mesh (Manifold soup or OCCT indexed form) for spatial queries. */
export function buildBVH(mesh: Mesh): BVH;

/**
 * Min wall thickness by inward ray-casting per surface triangle. `null` only for
 * an EMPTY mesh; a mesh whose rays all miss returns `value: null` WITH the
 * sampling accounting, so "we looked and found nothing" stays distinguishable
 * from "nobody looked". A sampled reading is an upper bound on the true minimum.
 */
export function minWall(
  mesh: Mesh,
  opts?: { maxThickness?: number; maxSamples?: number; bvh?: BVH },
): {
  value: number | null;
  location: Point3 | null;
  sampled: boolean;
  /** The sample BUDGET — triangles selected, not rays actually cast. */
  sampledTriangles: number;
  totalTriangles: number;
} | null;

/**
 * Unsupported downward-facing surface (oracle/overhang.js): the mm² of faces
 * steeper than `maxAngle` from vertical, excluding the footprint on the bed
 * (`bedZ`, else the mesh's lowest Z) and a near-bed band. One pass, no index;
 * `null` only for an empty mesh. Bridges and bore ceilings count.
 */
export function overhang(
  mesh: Mesh,
  opts?: { maxAngle?: number; bedZ?: number; bedEps?: number; bedBand?: number },
): { area: number; worstAngle: number | null; at: Point3 | null } | null;

// --- measure ----------------------------------------------------------------

export interface SubPartFacts {
  name: string;
  /** Size only — `[dx, dy, dz]`. */
  bbox: number[];
  /** Where the geometry sits. */
  bounds: { min: number[]; max: number[] };
  /** Volume-weighted centroid, or `null` for a degenerate/zero-volume sub-part. */
  centerOfMass: number[] | null;
  volume: number;
  surfaceArea: number;
  triangleCount: number;
  /** Manifold-only; `null` on OCCT. */
  watertight: boolean | null;
  /** Through-hole count (genus). Manifold-only; `null` on OCCT. */
  holes: number | null;
  /** `null` exactly when no reading exists. */
  minWall: number | null;
  minWallAt: number[] | null;
  minWallSampled: boolean;
  minWallSamples: { sampled: number; total: number } | null;
  /**
   * Unsupported downward-facing area in mm² (oracle/overhang.js), `null` when the
   * part is not laid out for a bed (`verify.orientation: "print"` under a
   * profile with an `overhang` angle). Bridges and bore ceilings count.
   */
  overhangArea: number | null;
  /** Steepest offending face, degrees from vertical; `null` when none. */
  overhangAngle: number | null;
  /** Centroid of the largest offending face; `null` when none. */
  overhangAt: number[] | null;
}

export interface AggregateFacts {
  bbox: number[];
  bounds: { min: number[]; max: number[] };
  centerOfMass: number[] | null;
  volume: number;
  surfaceArea: number;
  triangleCount: number;
}

/** One arc of a probed `Shape2D` ring: centre and radius from the contour IR. */
export interface ProbeArc {
  center: [number, number];
  r: number;
  from: [number, number];
  to: [number, number];
  /** Signed; positive counter-clockwise. */
  sweepDeg: number;
  /** Present when the segment was a cubic and the circle is a fit, not a construction. */
  fit?: "cubic";
}

export interface ProbeRing {
  /** Total segment count, before any cap. */
  segments: number;
  /** At most 64; `truncated` on the summary says when the list was cut. */
  arcs: ProbeArc[];
  /** Straight segments, count only. */
  lines: number;
  corners: Array<{ point: [number, number]; interiorAngleDeg: number; convex: boolean }>;
}

/** What a `Shape2D` returned from a probe becomes in the report. */
export interface ShapeProbeFacts {
  kind: "shape2d";
  empty: boolean;
  area: number;
  bbox: { min: [number, number]; max: [number, number] } | null;
  regions: Array<{ outer: ProbeRing; holes: ProbeRing[] }>;
  truncated: boolean;
}

export interface MeasureReport {
  /** `part.meta.title`, falling back to the view name. */
  part: string;
  view: string;
  /** Whether this run cast min-wall rays at all. */
  measuredMinWall: boolean;
  /** The overhang angle every sub-part's `overhangArea` was measured against, `null` when the pass did not run. */
  measuredOverhang: number | null;
  subparts: SubPartFacts[];
  aggregate: AggregateFacts;
  overlaps: Overlap[];
  /** Every sub-part pair's minimum surface distance. */
  gaps: Gap[];
  /** The pairs with an unintended-looking gap under the threshold. */
  nearMisses: Gap[];
  /**
   * Declared probes' values, present only when the part declares probes and this
   * run evaluated them. A Solid in a probe's return value becomes a fact object, a
   * Shape2D becomes a `ShapeProbeFacts`, plain JSON passes through, a throw is `{error}`.
   */
  probes?: Record<string, unknown>;
  /** Every sub-part watertight and nothing interpenetrating. Near misses never affect it. */
  ok: boolean;
}

/** Headless geometric report for one view of a part. */
export function measure(
  kernel: GeometryKernel,
  part: PartDefinition,
  view?: string,
  params?: ResolvedParams,
  opts?: {
    minWall?: boolean;
    /**
     * The overhang angle to measure against (degrees from vertical), or `null`
     * for "not checked". Omitted, measure derives it from the part's own
     * `verify` block the way verify does.
     */
    overhang?: number | null;
    gapThreshold?: number;
    /**
     * A build of this view the caller already has, measured instead of building a
     * second time. It is trusted, not checked against `view`/`params` — hand in a
     * build of the same view you are asking about.
     */
    built?: BuiltSubPart[];
  },
): MeasureReport;

// --- verify -----------------------------------------------------------------

export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export interface VerifyCheck {
  /** `"part"` is the vacuous-verify notice; `"case"` the quick-lap "not measured" marker. */
  scope: "view" | "subpart" | "part" | "case";
  /** The sub-part name, `"a×b"` for a pair check, or `null` for a scalar view metric. */
  subpart: string | null;
  metric: string;
  /** `gate` failures set a non-zero exit code; `warn` never blocks. */
  kind: "gate" | "warn";
  /** The asserted expression, stringified. */
  expr: string;
  actual: unknown;
  status: CheckStatus;
  pass: boolean | null;
  message: string;
  /** One self-contained corrective sentence (part-authored `hint` wins). */
  hint?: string;
  /** A stable ERROR-PATTERNS.md entry id. */
  pattern?: string;
  /** A measurement caveat or companion reading — `minWall` (sampling) and `overhangArea` (the steepest angle) set one. */
  note?: string;
  /** `[x, y, z]` in mm, for the metrics that have one. */
  location?: number[] | null;
}

export interface VerifyCaseResult {
  /** `"defaults"` or a preset name. */
  name: string;
  params: ResolvedParams;
  checks: VerifyCheck[];
}

export interface VerifyReport {
  /**
   * Tri-state: `true` when every declared check passed, `false` on any gate
   * failure, `null` when no verdict can be given — a quick lap that could not
   * measure a gate, or a part that declared no expectations at all (`declared`
   * is 0 and `warnings` carries a `no expectations declared` notice). Never read
   * `null` as a pass.
   */
  ok: boolean | null;
  view: string;
  cases: VerifyCaseResult[];
  /** Every failing check, flattened, each tagged with its `case`. */
  failures: Array<VerifyCheck & { case: string }>;
  warnings: Array<VerifyCheck & { case: string }>;
  /** Checks a quick lap could not evaluate. */
  unevaluated: Array<VerifyCheck & { case: string }>;
  /** Check instances the part or its profile declared, across cases (near-miss notices excluded). */
  declared: number;
  /** Of `declared`, how many were actually answered — a skipped or unevaluated check is not. Zero withholds `ok`. */
  evaluated: number;
}

/**
 * Enforce a part's `verify` block across the default config plus every preset
 * (or its declared `cases`).
 *
 * `seed` lets a caller that has already measured the part hand the result in so
 * verify does not recompute it. It is consulted only when the seed was measured
 * with min wall (or this run needs none) and for the same view.
 */
export function verify(
  kernel: GeometryKernel,
  part: PartDefinition,
  opts?: {
    /** Force or override the DFM profile. */
    process?: string | Record<string, unknown>;
    view?: string;
    measureFn?: typeof measure;
    seed?: { params?: ResolvedParams; result: MeasureReport };
  },
): VerifyReport;

// --- silhouette match scoring -----------------------------------------------

/**
 * A binary silhouette. `data` is 0 or 255, one byte per pixel, row 0 at the TOP.
 * `minX`/`minY` are the projected-plane coordinates of the image's BOTTOM-LEFT
 * corner. A mask with no `mmPerPx` carries no scale (a photo), which is what makes
 * the scale-aware comparison unavailable for it.
 */
export interface SilhouetteMask {
  data: Uint8Array;
  width: number;
  height: number;
  mmPerPx?: number;
  minX?: number;
  minY?: number;
}

/** The six canonical orthographic views a part is rasterized into for matching. */
export const MATCH_VIEWS: string[];

/**
 * Project posed meshes onto one of `MATCH_VIEWS` and scanline-fill the silhouette.
 * `null` when there is nothing to draw or the projection has zero extent.
 */
export function rasterizeMeshMask(
  meshes: Array<Pick<Mesh, "positions" | "indices">>,
  view: string,
  size?: number,
): SilhouetteMask | null;

/**
 * Fill a set of closed 2-D rings (millimetres) into a mask. All rings share one
 * even-odd group, so a ring inside another is a hole. `null` when nothing fills.
 */
export function rasterizeRingsMask(
  rings: Array<Array<[number, number]>>,
  size?: number,
): SilhouetteMask | null;

/**
 * Per-pixel comparison of the two masks: `0` background, `1` overlap, `2` missing
 * (reference only), `3` excess (candidate only).
 */
export interface MatchDelta {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * How close a candidate silhouette is to a reference one. Shape is compared
 * pose-normalized, so `iou` and `boundaryIoU` ignore position and size. `iouScale`
 * appears only for a scale-aware comparison, which also makes `contourDist` a real
 * millimetre distance instead of a percentage of the reference's bbox diagonal.
 */
export interface MatchScores {
  iou: number;
  boundaryIoU: number;
  contourDist: number;
  contourUnit: "mm" | "%bbox-diag";
  iouScale?: number;
  delta: MatchDelta;
}

/**
 * Score one candidate mask against a reference. `null` when either has no
 * foreground at all — unscoreable is not the same as scoring zero.
 *
 * `scaleAware` is the caller's promise that both masks are in millimetres; it takes
 * effect only when both actually carry a finite `mmPerPx`.
 */
export function matchMasks(
  candidate: SilhouetteMask | null | undefined,
  reference: SilhouetteMask | null | undefined,
  opts?: { scaleAware?: boolean },
): MatchScores | null;

/**
 * Score every view's mask against one reference and name the best. Unscoreable
 * views are left out of `views` entirely; `best` is `null` when none scored.
 */
export function matchViews(
  viewMasks: Record<string, SilhouetteMask | null>,
  reference: SilhouetteMask | null | undefined,
  opts?: { scaleAware?: boolean },
): { best: ({ view: string } & MatchScores) | null; views: Record<string, number> };


// --- rendering --------------------------------------------------------------

/** The canonical angle names `renderViews` accepts. */
export const RENDER_VIEWS: string[];

/**
 * Render canonical-angle PNGs of one view with a pure-JS software rasterizer —
 * no native module, no browser. Returns the written file paths.
 */
export function renderViews(
  kernel: GeometryKernel,
  part: PartDefinition,
  view?: string,
  opts?: {
    views?: string[];
    out?: string;
    size?: [number, number];
    edges?: boolean;
    params?: ResolvedParams;
    /** Frame suffix in the written filename (`<part>-<view>-<angle>-<tag>.png`). */
    tag?: string;
    /**
     * Per-sub-part opacity, keyed by sub-part name (an animation `evaluate()`
     * result). `0` omits the sub-part entirely; `0 < v < 1` fades it toward the
     * background. Absent keys render solid.
     */
    opacity?: Record<string, number>;
  },
): Promise<string[]>;

// --- sketch-annotation rays --------------------------------------------------
export interface AnnotationRay { origin: [number, number, number]; dir: [number, number, number] }
export interface RayPlaneHit { point: [number, number, number]; t: number }
export type PlaneSpec =
  | { point: [number, number, number]; normal: [number, number, number] }
  | "xy" | "yz" | "zx";
/** Rebuild the pick ray for a screen point of an ANNOTATION_VERSION 3 payload. */
export function annotationRay(
  payload: { camera: unknown; viewport: { aspect: number } },
  screen: [number, number] | { screen: [number, number] },
  opts?: { frame?: "parts" | "world" },
): AnnotationRay;
/** Intersect a ray with a plane; null on parallel / behind-origin misses. */
export function rayPlane(ray: AnnotationRay, plane: PlaneSpec): RayPlaneHit | null;
