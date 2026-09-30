// partforge/geometry — pure 2-D profile helpers and solid patterns.
//
// DOM-free and kernel-free: this is the entry a part's build functions import
// (importing "partforge" inside a worker throws `document is not defined`).

import type {
  ArcContour,
  Contour,
  Corner2D,
  CornerSelector,
  GeometryKernel,
  MirrorAxis2,
  Point2,
  Point3,
  PointsContour,
  Region2D,
  Shape2D,
  Solid,
} from "./kernel.js";
import type {
  AxisWord,
  Derived,
  PlaceContext,
  ResolvedParams,
  SheetPose,
  SheetScoreEntry,
  SubPartDefinition,
} from "./part.js";

export type { ArcContour, Contour, Corner2D, CornerSelector, MirrorAxis2, Point2, Point3, PointsContour, Region2D, Solid };
export type { AxisWord, SheetPose };

/**
 * Anything the 2-D editing ops below accept: a plain point list, a curve-native
 * contour, a `{outer, holes}` region, or a region array. Every op returns the
 * same shape of input it was given (a bare point list stays a point list, unless
 * the op introduces curves — e.g. a non-uniform `scaleProfile` on an arc — in
 * which case it upgrades to a `Contour`).
 */
export type ProfileInput = number[][] | Contour | Region2D | Region2D[];

/**
 * A pie/sector wedge with its tip at the origin, as a FACETED point list.
 * @deprecated Use `pieProfile` — its arc is exact and refined at export; this
 * one's facets (32 per circle) are exported exactly as written.
 */
export function piePolygon(tipR: number, arcDeg: number, segs?: number): PointsContour;

/** A regular hexagon of circumradius `r`. */
export function hexPolygon(r: number): PointsContour;

/**
 * A `w` × `h` rectangle centred at the origin with corner radius `r`, as a FACETED point list.
 * @deprecated Use `roundedRectProfile` — exact corner arcs, refined at export.
 */
export function roundedRectPolygon(w: number, h: number, r: number, segs?: number): PointsContour;

/** A regular `n`-gon of circumradius `r`; `flat: true` seats a flat side down. */
export function regularPolygon(n: number, r: number, opts?: { flat?: boolean }): PointsContour;

/** An ellipse as a FACETED point list (`segs`, default 48) — there is no exact-curve form. */
export function ellipsePolygon(rx: number, ry: number, segs?: number): PointsContour;

/**
 * A stadium/slot; overall length is `length + 2r`, as a FACETED point list.
 * @deprecated Use `slotProfile` — exact semicircles, refined at export.
 */
export function slotPolygon(length: number, r: number, segs?: number): PointsContour;

export function starPolygon(points: number, outerR: number, innerR: number): PointsContour;

/**
 * An annular sector, as a FACETED point list (32 facets per circle).
 * @deprecated Use `ringSectorProfile` — exact arcs, refined at export.
 */
export function ringSectorPolygon(innerR: number, outerR: number, arcDeg: number, segs?: number): PointsContour;

/**
 * A CCW circle of radius `r` centred at `center`, as a FIXED point list of `segs`
 * vertices (default 48), starting at angle 0. The point-list circle: for a deliberately
 * faceted circle or point math of your own (mapping, indexing).
 */
export function circlePolygon(r: number, center?: Point2, segs?: number): PointsContour;

/**
 * An exact circle of radius `r` centred at `center`: a path contour of two semicircles
 * starting at angle 0, which the kernel facets per tier (finer at export) and OCCT keeps as
 * a true circle. Not an array — use `circlePolygon` for point math. (Until 0.132 this
 * returned `circlePolygon`'s 48 points; it takes no `segs`.)
 */
export function circleProfile(r: number, center?: Point2): ArcContour;

/**
 * Per-corner rounding geometry shared by `filletPolygon` and `roundedProfile`:
 * the incoming/outgoing tangent points, the arc centre, the clamped radius, the
 * short sweep and its start angle — or `null` for a corner that stays sharp.
 */
export function cornerArc(
  p0: Point2,
  p1: Point2,
  p2: Point2,
  r: number,
): { a: number[]; b: number[]; c: number[]; rr: number; dA: number; a0: number } | null;

/**
 * Round every corner of a CCW polygon, BAKING each arc into line facets — so
 * STEP corners are faceted and export never refines them.
 * @deprecated Use `roundedProfile` — the same corners, carried as exact arcs.
 */
export function filletPolygon(points: PointsContour, r: number, opts?: { segs?: number }): PointsContour;

/**
 * Round corners the same way as `filletPolygon` but keep them mathematically
 * TRUE — the arc is carried symbolically, so STEP export gets real circular
 * edges. A scalar `r` rounds every corner; a per-corner `r[]` (length = points)
 * rounds selectively. Accepted by `prism`/`extrude`, not yet by `loft`.
 */
export function roundedProfile(points: PointsContour, r: number | number[]): ArcContour;

// ── Exact-curve profiles ──────────────────────────────────────────────────────
// The naming rule: `*Profile` helpers return exact curves (a path contour whose arcs
// the kernel facets per quality tier, finer at export, and OCCT keeps as true circles);
// `*Polygon` helpers return straight-edged point lists, exported exactly as written.
// Each of these traces the same outline as its `*Polygon` namesake.

/** An annular sector from angle 0 to `arcDeg` (0 < arcDeg < 360; 0 < innerR < outerR). */
export function ringSectorProfile(innerR: number, outerR: number, arcDeg: number): ArcContour;

/** A circular sector ("pie slice") from the origin, radius `tipR`, from angle 0 to `arcDeg`. */
export function pieProfile(tipR: number, arcDeg: number): ArcContour;

/** A stadium slot: semicircle centres `length` apart (overall `length + 2r`); length 0 is a circle. */
export function slotProfile(length: number, r: number): ArcContour;

/** A `w` × `h` rectangle centred at the origin with radius-`r` corners (clamped to min(w, h)/2). */
export function roundedRectProfile(w: number, h: number, r: number): ArcContour;

/** The fluent builder `pathProfile` returns. `close()` snapshots the contour. */
export interface PathProfileBuilder {
  lineTo(to: Point2): PathProfileBuilder;
  /** A circular arc to `to` passing through `via`. */
  arcTo(to: Point2, via: Point2): PathProfileBuilder;
  /** A circular arc to `to` of radius `r`; `via` is computed from the current point. */
  arcTo(to: Point2, arc: { r: number; sweep?: "ccw" | "cw"; large?: boolean }): PathProfileBuilder;
  /** A cubic Bézier to `to` with control points `c1`/`c2`. */
  cubicTo(to: Point2, c1: Point2, c2: Point2): PathProfileBuilder;
  /** Close the contour and return it. Needs at least one segment. */
  close(): ArcContour;
}

/**
 * A fluent builder for a curve-native path contour. Cubic segments become exact
 * B-rep spline edges on OCCT and facet at mesh LOD on Manifold.
 */
export function pathProfile(start: Point2): PathProfileBuilder;

/** Convex-corner style for `offsetPolygon`. */
export type OffsetCorners = "round" | "chamfer" | "sharp";

/**
 * Offset a point-list polygon or an `{ outer, holes }` region by `delta` mm —
 * positive grows material, negative insets (regions offset material-wise). A path
 * contour (or a region of them) is sampled to points first, 48 per circle, and the
 * result is always point lists; `k.shape2d(profile).offset(delta)` keeps arcs exact.
 * Simple polygon in, simple polygon out: an offset that would collapse or split
 * the contour THROWS. Pure, so it works in `derive()` as well as `build()`.
 */
export function offsetPolygon(
  profile: PointsContour | ArcContour,
  delta: number,
  opts?: { corners?: OffsetCorners; segs?: number },
): PointsContour;
export function offsetPolygon(
  profile: Region2D,
  delta: number,
  opts?: { corners?: OffsetCorners; segs?: number },
): Region2D;

/** `count` copies of `solid` translated by `i * step`. Feed to `k.union` / `s.cutAll`. */
export function linearPattern(solid: Solid, count: number, step: Point3): Solid[];

/**
 * `count` copies spaced `angle / count` degrees apart around `axis` through
 * `center`. `rotateCopies: false` keeps each copy's original orientation.
 */
export function circularPattern(
  solid: Solid,
  count: number,
  opts?: {
    center?: Point3;
    axis?: "X" | "Y" | "Z" | Point3;
    angle?: number;
    rotateCopies?: boolean;
  },
): Solid[];

// ── 2-D editing ops ──────────────────────────────────────────────────────────
// Polymorphic input contract: every op below accepts a point list, a curve-native
// contour, a region, or a region array, and returns the same shape of input it
// was given — except the arc-length queries (profileLength/profilePointAt/
// profileTangentAt), which are single-contour by nature and throw on a region.

/** Translate every contour by `[dx, dy]`. Exact on all segment types. */
export function translateProfile(input: ProfileInput, delta: Point2): ProfileInput;

/** Rotate `deg` degrees about `center` (default the origin). Arcs stay arcs. */
export function rotateProfile(input: ProfileInput, deg: number, center?: Point2): ProfileInput;

/**
 * Scale by a uniform or per-axis factor about `center` (default the origin).
 * A non-uniform `[sx, sy]` converts `{to, via}` arcs to cubics (an ellipse is
 * not a circular arc). Scale factors must be finite and non-zero.
 */
export function scaleProfile(input: ProfileInput, s: number | Point2, center?: Point2): ProfileInput;

/** Reflect across `"x"`, `"y"`, or an arbitrary `{point, dir}` line. */
export function mirrorProfile(input: ProfileInput, axis: MirrorAxis2): ProfileInput;

/**
 * Round selected corners with true arcs. `r` may be an array paired
 * positionally with `{indices}`. Throws if no corner matches, or if `r`
 * does not fit against its neighboring segments.
 */
export function filletProfile(input: ProfileInput, r: number | number[], opts?: { corners?: CornerSelector }): ProfileInput;

/**
 * Bevel selected corners with a straight chord (symmetric setback). `dist`
 * may be an array paired positionally with `{indices}`. Throws if no corner
 * matches, or if `dist` does not fit against its neighboring segments.
 */
export function chamferProfile(input: ProfileInput, dist: number | number[], opts?: { corners?: CornerSelector }): ProfileInput;

/**
 * The corner list — `{index, position, point, interiorAngleDeg, convex,
 * segTypes}[]`, plus `{regionIndex, ring}` for region/regions input. `position`
 * (the entry's place in this list) is what `filletProfile`/`chamferProfile`'s
 * `{indices}` selects by; `index` is the joint's vertex number within its
 * contour, and the two diverge past any smooth joint.
 */
export function profileCorners(input: ProfileInput): Corner2D[];

/** Total arc length of a single contour, in mm. */
export function profileLength(contour: Contour): number;

/** The point at normalized position `t` (0..1) or absolute arc `length` along a single contour. */
export function profilePointAt(contour: Contour, opts: { t: number } | { length: number }): Point2;

/** The unit tangent at normalized position `t` (0..1) or absolute arc `length` along a single contour. */
export function profileTangentAt(contour: Contour, opts: { t: number } | { length: number }): Point2;

/**
 * The closest point on `input` to `[x, y]` — the pick-resolution primitive.
 * Accepts regions (unlike the arc-length queries above); `contourIndex`/
 * `segmentIndex` follow the same flattened outer-then-holes-per-region order
 * `validateProfile` uses. `t` is normalized 0..1, but for a `{to, via}` arc
 * segment (expanded internally into ≤90° cubic pieces that share one
 * `segmentIndex`) it is local to whichever piece the nearest point landed
 * on, not a position along the arc's full sweep.
 */
export function profileNearestPoint(
  input: ProfileInput,
  p: Point2,
): { point: Point2; distance: number; contourIndex: number; segmentIndex: number; t: number };

/** Curve-exact axis-aligned bounds across every contour in `input`. */
export function profileBounds(input: ProfileInput): { min: Point2; max: Point2 };

/** Net curve-exact area (Σ|outers| − Σ|holes|), mm². */
export function profileArea(input: ProfileInput): number;

/** Curve-aware point-in-shape test (inside an outer, not inside a hole). */
export function profileContains(input: ProfileInput, p: Point2): boolean;

/**
 * Corner-preserving decimation/refit within `tolerance` mm: splits at corners,
 * then reduces or refits each run independently, reassembling with corner
 * points bit-exact preserved. A run that gains curves upgrades a point-list
 * input to a `Contour`.
 */
export function simplifyProfile(input: ProfileInput, tolerance: number): ProfileInput;

/** One issue `validateProfile` reports. Never thrown — only returned. */
export interface ProfileIssue {
  type: "degenerate" | "self-intersection" | "winding" | "nesting";
  contourIndex: number;
  segmentIndex?: number;
  point?: Point2;
  message: string;
}

/**
 * Geometric sanity checks (degenerate segments/area, self-intersection,
 * winding, nesting) against `input`'s sampled approximation. Never throws on
 * geometric badness — only an unrecognized `input` shape throws.
 */
export function validateProfile(input: ProfileInput): { ok: boolean; issues: ProfileIssue[] };

// --- sheet parts (docs/AUTHORING-PARTS.md "Sheet parts") --------------------

/**
 * What `sheetPart` accepts. A field needing the kernel is `(k, p, d)`; a plain value
 * is a literal or `(p, d)`. Unknown keys throw at load and name the fix (`kerf` is
 * chosen at download, `outline`/`cut` are `profile`, `build` is supplied).
 */
export interface SheetPartSpec<P = ResolvedParams, D = Derived> {
  /** Stock label ("birch plywood"); groups pieces in the kit. The LOOK is `display.material`. */
  material: string | ((p: P, d: D) => string);
  /** The MEASURED sheet thickness in mm: the extrusion depth and every joint's depth. */
  thickness: number | ((p: P, d: D) => number);
  /** The CUT layer: outline plus holes, seen from the laser face. */
  profile: (k: GeometryKernel, p: P, d: D) => Shape2D | ProfileInput;
  /** Exactly two points is a line; any other entry is a shape whose boundaries are scored. */
  score?: ((k: GeometryKernel, p: P, d: D) => SheetScoreEntry[] | null) | null;
  /** Filled regions burned into the laser face (`k.text2d`, `k.vector2d`, a Shape2D). */
  engrave?: ((k: GeometryKernel, p: P, d: D) => Shape2D | ProfileInput | null) | null;
  /** Where the piece sits, for display AND export. Omitted: flat, no transform. */
  pose?: SheetPose | ((p: P, d: D) => SheetPose | null) | null;
  process?: "laser";
  label?: string;
  views: string[];
  display?: SubPartDefinition<P, D>["display"];
  export?: { name: string };
  enabled?: (p: P) => unknown;
  exportable?: boolean;
  reference?: string;
  /** Your own placement; runs AFTER the pose. */
  place?: (solid: Solid, ctx: PlaceContext<P, D>) => Solid;
}

/** A sub-part cut from flat stock: an ordinary sub-part with `build`, `place` and `sheet` filled in. */
export function sheetPart<P = ResolvedParams, D = Derived>(spec: SheetPartSpec<P, D>): SubPartDefinition<P, D>;

/** A metric screw size `tSlots` knows. */
export type ScrewSize = "M2.5" | "M3" | "M4";

/** One edge's joint — plain, JSON-safe data (it lives in `derive()` output). A plain edge is `undefined`. */
export type EdgeJoint =
  | { joint: "fingers"; thickness: number; clearance: number; finger: number; side: "outer" | "inner" }
  | { joint: "tabs"; thickness: number; count: number; width: number }
  | { joint: "tslots"; thickness: number; screw: ScrewSize; screwLength: number; at: number[]; clearance: number };

/** Finger joint. `clearance` is the TOTAL play per finger; outer fingers protrude, inner ones notch. */
export function fingers(opts: { thickness: number; clearance?: number; finger?: number; side?: "outer" | "inner" }): Extract<EdgeJoint, { joint: "fingers" }>;

/** Tongues protruding `thickness` from the edge, `count` of them, each `width` wide. */
export function tabs(opts: { thickness: number; count?: number; width?: number }): Extract<EdgeJoint, { joint: "tabs" }>;

/** A screw-and-nut joint: a shank slot crossed by a nut trap, at fractions `at` along the edge. */
export function tSlots(opts: { thickness: number; screw?: ScrewSize; screwLength?: number; at?: number[]; clearance?: number }): Extract<EdgeJoint, { joint: "tslots" }>;

/** A panel's four edges, in CCW order; an omitted edge is plain. */
export interface SheetPanelEdges {
  bottom?: EdgeJoint;
  right?: EdgeJoint;
  top?: EdgeJoint;
  left?: EdgeJoint;
}

/** A panel outline: nominal box [0, W] × [0, H] with each edge's joint; `size` includes protrusions. */
export function sheetPanel(opts: { width: number; height: number; edges?: SheetPanelEdges }): { outline: PointsContour; size: [number, number] };

/** The holes the OTHER panel needs for a tabs or T-slot edge; `line` is the tabbed panel's mid-plane in this panel's frame. */
export function matchingSlots(joint: EdgeJoint, opts: { line: [Point2, Point2]; clearance?: number }): Contour[];

/** One `fingerBox` panel: its outline in its own frame (bbox [0, 0]–size) and where it goes. */
export interface FingerBoxPanel {
  outline: PointsContour;
  size: [number, number];
  pose: SheetPose;
}

/** An open-top finger-jointed box, W × D × H outside: five panels, every corner owned once. */
export function fingerBox(opts: {
  width: number;
  depth: number;
  height: number;
  thickness: number;
  clearance?: number;
  finger?: number;
}): Record<"bottom" | "front" | "back" | "left" | "right", FingerBoxPanel>;

/** A slot and the printed tongue that keys into it, from one spec; all the play is on the slot. */
export function printedTab(opts: { size: [number, number]; thickness: number; clearance?: number }): { slot: PointsContour; tongue: [number, number, number] };

/** An arc-exact round hole (a CCW circle of two arcs) for a sheet part's profile: `circleProfile(d / 2, at)`, named by diameter. */
export function sheetHole(opts: { d: number; at: Point2 }): ArcContour;

/** Clearance holes (ISO 273 medium) and hex nuts (ISO 4032) for `tSlots`, mm. */
export const JOINERY_SCREWS: Readonly<Record<ScrewSize, { readonly hole: number; readonly nut: { readonly flats: number; readonly height: number } }>>;

/**
 * A drawing point on a posed sheet (`depth` mm into the material) → world [x, y, z].
 * `pose` null (`FLAT_POSE`) is the canonical frame; it needs the sheet's `thickness`,
 * since the laser face then sits at z = thickness. Otherwise `thickness` is unused.
 */
export function sheetToWorld(pose: SheetPose | null, uv: Point2, depth?: number, thickness?: number): [number, number, number];

/** A world point → where it lands on a posed sheet's drawing, [u, v]. `pose` null is the canonical frame. */
export function worldToSheet(pose: SheetPose | null, xyz: Point3): [number, number];
