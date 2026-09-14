// partforge/geometry — pure 2-D profile helpers and solid patterns.
//
// DOM-free and kernel-free: this is the entry a part's build functions import
// (importing "partforge" inside a worker throws `document is not defined`).

import type {
  ArcContour,
  Contour,
  Corner2D,
  CornerSelector,
  MirrorAxis2,
  Point2,
  Point3,
  PointsContour,
  Region2D,
  Solid,
} from "./kernel.js";

export type { ArcContour, Contour, Corner2D, CornerSelector, MirrorAxis2, Point2, Point3, PointsContour, Region2D, Solid };

/**
 * Anything the 2-D editing ops below accept: a plain point list, a curve-native
 * contour, a `{outer, holes}` region, or a region array. Every op returns the
 * same shape of input it was given (a bare point list stays a point list, unless
 * the op introduces curves — e.g. a non-uniform `scaleProfile` on an arc — in
 * which case it upgrades to a `Contour`).
 */
export type ProfileInput = number[][] | Contour | Region2D | Region2D[];

/** A pie/sector wedge with its tip at the origin. */
export function piePolygon(tipR: number, arcDeg: number, segs?: number): PointsContour;

/** A regular hexagon of circumradius `r`. */
export function hexPolygon(r: number): PointsContour;

/** A `w` × `h` rectangle centred at the origin with corner radius `r`. */
export function roundedRectPolygon(w: number, h: number, r: number, segs?: number): PointsContour;

/** A regular `n`-gon of circumradius `r`; `flat: true` seats a flat side down. */
export function regularPolygon(n: number, r: number, opts?: { flat?: boolean }): PointsContour;

export function ellipsePolygon(rx: number, ry: number, segs?: number): PointsContour;

/** A stadium/slot; overall length is `length + 2r`. */
export function slotPolygon(length: number, r: number, segs?: number): PointsContour;

export function starPolygon(points: number, outerR: number, innerR: number): PointsContour;

/** An annular sector. `arcDeg` must be < 360 — a full ring is a contour-with-hole. */
export function ringSectorPolygon(innerR: number, outerR: number, arcDeg: number, segs?: number): PointsContour;

/**
 * A CCW circle of radius `r` centred at `center`, as a FACETED point list
 * (`segs` segments). For curve-exact corners use `roundedProfile`/`pathProfile`.
 */
export function circleProfile(r: number, center?: Point2, segs?: number): PointsContour;

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
 * STEP corners are faceted. Use `roundedProfile` for true circular edges.
 */
export function filletPolygon(points: PointsContour, r: number, opts?: { segs?: number }): PointsContour;

/**
 * Round corners the same way as `filletPolygon` but keep them mathematically
 * TRUE — the arc is carried symbolically, so STEP export gets real circular
 * edges. A scalar `r` rounds every corner; a per-corner `r[]` (length = points)
 * rounds selectively. Accepted by `prism`/`extrude`, not yet by `loft`.
 */
export function roundedProfile(points: PointsContour, r: number | number[]): ArcContour;

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
 * positive grows material, negative insets (regions offset material-wise).
 * Simple polygon in, simple polygon out: an offset that would collapse or split
 * the contour THROWS. Pure, so it works in `derive()` as well as `build()`.
 */
export function offsetPolygon(
  profile: PointsContour,
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
 * The corner list — `{index, point, interiorAngleDeg, convex, segTypes}[]`,
 * plus `{regionIndex, ring}` for region/regions input. This positional order
 * is what `filletProfile`/`chamferProfile`'s `{indices}` selects into.
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
