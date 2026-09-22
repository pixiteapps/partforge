// Type declarations for the backend-agnostic geometry kernel.
//
// This is the TypeScript half of the contract stated twice already: the
// `@typedef`s in src/framework/geometry/kernel.js (signatures) and
// docs/KERNEL-CONTRACT.md (prose semantics). The op LISTS in kernel.js
// (KERNEL_OPS / KERNEL_OPTIONAL_OPS / SOLID_OPS / SOLID_OPTIONAL_OPS /
// SHAPE2D_OPS / OCCT_ONLY_OPS) are data, and test/types-surface.test.js holds
// the interfaces below to them member-for-member — so an op added to the kernel
// cannot silently go undeclared here.
//
// Units are millimetres throughout.

/** A 2-D point, `[x, y]`. */
export type Point2 = [number, number] | number[];
/** A 3-D point or vector, `[x, y, z]`. */
export type Point3 = [number, number, number] | number[];

/** A closed CCW contour as a plain point list (the `polygon.js` helpers' output). */
export type PointsContour = Point2[];

/**
 * A curve-native contour that carries arcs/béziers SYMBOLICALLY — the output of
 * `roundedProfile()` and `pathProfile(...).close()`. OCCT turns these into exact
 * B-rep edges (true circles in STEP); Manifold tessellates them at mesh LOD.
 */
export interface ArcContour {
  start: Point2;
  segments: Array<{ to: Point2; via?: Point2; c1?: Point2; c2?: Point2 }>;
  /** Set by `roundedProfile`; absent on a `pathProfile` contour. */
  arc?: boolean;
}

/** Either contour form. */
export type Contour = PointsContour | ArcContour;

/** A polygon-with-holes region: one outer contour and any number of hole contours. */
export interface Region2D {
  outer: Contour;
  holes?: Contour[];
}

/** Anything the kernel accepts where a 2-D profile is wanted. */
export type ProfileInput = Contour | Region2D | Shape2D;

/** Mesh level of detail. Manifold bakes this in at primitive creation. */
export type MeshQuality = "preview" | "print";

/** A triangle soup (Manifold) or an indexed mesh (OCCT), as `Solid.toMesh()` returns it. */
export interface Mesh {
  positions: Float32Array;
  normals: Float32Array;
  /** Present on the OCCT backend; absent for a Manifold non-indexed soup. */
  indices?: Uint32Array;
  triangles: number;
  /** Feature-edge line segments (Manifold). */
  edges?: Float32Array;
}

/** The indexed mesh 3MF export needs. */
export interface IndexedMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/** Axis-aligned bounds of a solid. */
export interface BoundingBox3 {
  min: number[];
  max: number[];
  center: number[];
  size: number[];
}

/** Axis-aligned bounds of a 2-D shape. */
export interface BoundingBox2 {
  min: number[];
  max: number[];
}

/** A materialized region: point rings only, arcs already flattened. */
export interface MaterializedRegion {
  outer: number[][];
  holes: number[][][];
}

/** Which geometry backend a part builds on. */
export type BackendName = "manifold" | "occt";

/** Cardinal direction for `Solid.along()`. */
export type AxisDirection = "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z";
/** A mirror plane. */
export type MirrorPlane = "XY" | "XZ" | "YZ";
/** A named world axis. */
export type AxisName = "X" | "Y" | "Z";

/** Convex-corner style for an offset. */
export type OffsetCorners = "round" | "chamfer" | "sharp";

/** A stored contour-IR region: curve-native contours, nothing flattened. */
export interface ContourRegion {
  outer: ArcContour;
  holes: ArcContour[];
}

/** One corner of a `Shape2D`, as `Shape2D.corners()` reports it. */
export interface Corner2D {
  /**
   * The joint's vertex number within its own contour. NOT what `fillet`/
   * `chamfer`'s `{ indices }` takes — that is `position`. The two diverge as
   * soon as a contour has a smooth joint (a collinear midpoint, a G1 arc-line
   * join), and on region input `index` restarts per ring.
   */
  index: number;
  /** This corner's place in the `corners()` list — what `{ indices }` selects by. */
  position: number;
  point: Point2;
  interiorAngleDeg: number;
  convex: boolean;
  /** Segment kinds meeting here, incoming then outgoing. */
  segTypes: Array<"line" | "arc" | "cubic">;
  /** Present only for multi-region shapes. */
  regionIndex?: number;
  /** Present only for multi-region shapes. */
  ring?: "outer" | { hole: number };
}

/** Which corners a `Shape2D` `fillet`/`chamfer` applies to. Default `"all"`. */
export type CornerSelector =
  | "all"
  | "convex"
  | "concave"
  /**
   * Each corner's `position` in `corners()` (never its `index`); a per-corner
   * `r`/`d` array pairs with these. Any entry out of range throws.
   */
  | { indices: number[] }
  /**
   * The `count` (default 1) corners nearest `near`, optionally only those
   * `within` mm of it. Without `within` the nearest corner is always selected,
   * however far away it is.
   */
  | { near: Point2; count?: number; within?: number };

/** A mirror line for `Shape2D.mirror`. */
export type MirrorAxis2 = "x" | "y" | { point: Point2; dir: Point2 };

// --- edge / face selectors --------------------------------------------------

/**
 * Which edges a `fillet`/`chamfer` applies to. Omit for every edge. The object
 * forms are portable across backends-by-contract; a raw replicad finder callback
 * is an OCCT-only escape hatch (see docs/KERNEL-CONTRACT.md).
 */
export type EdgeSelector =
  | { dir: AxisName }
  | { inPlane: MirrorPlane; at?: number }
  | { near: Point3 }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- an opaque replicad EdgeFinder
  | ((finder: any) => any);

/** Which face(s) `shell` opens. Same forms as `EdgeSelector`. */
export type FaceSelector = EdgeSelector;

// --- Shape2D ----------------------------------------------------------------

/**
 * A 2-D sketch value: booleans, transforms, corner ops and queries. ONE shared
 * implementation on both backends — storage is the curve-native contour IR, so
 * arcs and béziers survive every op and results are backend-identical except
 * `offset`. No backend geometry exists until the shape is extruded/revolved or
 * materialized via `toRegions()`. `_`-prefixed keys are internals, not declared.
 *
 * Every op returns a NEW `Shape2D`; no operand is ever mutated.
 */
export interface Shape2D {
  union(other: Shape2D | Contour): Shape2D;
  cut(other: Shape2D | Contour): Shape2D;
  /** Batch subtract. */
  cutAll(others: Array<Shape2D | Contour>): Shape2D;
  intersect(other: Shape2D | Contour): Shape2D;
  /**
   * Grow (`delta > 0`) or inset (`delta < 0`). The one backend-specific op:
   * curve-preserving on OCCT, faceted at mesh LOD on Manifold. Throws if the
   * offset collapses the shape.
   */
  offset(delta: number, opts?: { corners?: OffsetCorners; segs?: number }): Shape2D;
  /** Net area (outers minus holes), mm². Curve-exact — not measured off a tessellation. */
  area(): number;
  /** Axis-aligned 2-D bounds, curve-exact. */
  boundingBox(): BoundingBox2;
  /** Materialize into point-ring region arrays, tessellating curves at the backend's LOD. */
  toRegions(): MaterializedRegion[];
  /** The stored contour IR — curve-native and lossless. A deep copy, safe to mutate. */
  toContours(): ContourRegion[];
  /** `toRegions()` unwrapped — throws unless there is exactly one region. */
  simple(): MaterializedRegion;
  /** Scission: each disjoint region as its own live `Shape2D`. */
  regions(): Shape2D[];
  clone(): Shape2D;
  /** Translate by `[dx, dy]`. */
  translate(v: Point2): Shape2D;
  /** Rotate `deg` about `center` (default the origin). */
  rotate(deg: number, center?: Point2): Shape2D;
  /** Scale about `center` (default the origin). A single `number` scales uniformly; `[sx, sy]` scales each axis independently. */
  scale(factor: number | [number, number], center?: Point2): Shape2D;
  /** Reflect across an axis line. */
  mirror(axis: MirrorAxis2): Shape2D;
  /** Round selected corners with true arcs. `r` may be an array paired with `{ indices }`. */
  fillet(r: number | number[], opts?: { corners?: CornerSelector }): Shape2D;
  /** Bevel selected corners with straight chords. `d` may be an array paired with `{ indices }`. */
  chamfer(d: number | number[], opts?: { corners?: CornerSelector }): Shape2D;
  /** Corner-preserving decimation/refit within `tolerance` mm. */
  simplify(tolerance: number): Shape2D;
  /** The corner list; each entry's `position` is what `fillet`/`chamfer`'s `{ indices }` selects by. */
  corners(): Corner2D[];
  /** Is `[x, y]` inside the shape (inside an outer, not inside a hole)? */
  contains(p: Point2): boolean;
  /** No regions left (a cut/intersect removed everything)? Guard before `extrude`/`revolve`, which throw on an empty shape. */
  isEmpty(): boolean;
  /** Sugar for `k.extrude({ profile: this, ... })`. Throws if the shape is empty — guard with `isEmpty()`. */
  extrude(opts: { h: number; twist?: number; scaleTop?: number }): Solid;
  /** Sugar for `k.revolve({ profile: this, ... })`. Throws if the shape is empty — guard with `isEmpty()`. */
  revolve(opts?: { degrees?: number }): Solid;
}

// --- Solid ------------------------------------------------------------------

/**
 * An opaque handle to a backend solid. `_`-prefixed keys are backend internals
 * and are not declared.
 *
 * On the OCCT backend a transform CONSUMES its operand — never reuse a solid
 * after transforming it; `.clone()` first.
 */
export interface Solid {
  cut(tool: Solid): Solid;
  /** Batch subtract (backend-optimized). */
  cutAll(tools: Solid[]): Solid;
  intersect(other: Solid): Solid;
  /** Boolean union with one other solid (n-ary: `k.union([...])`). */
  union(other: Solid): Solid;
  /** Independent copy. */
  clone(): Solid;
  /**
   * Name this solid's surface for hover/pick feature attribution. Survives
   * transforms and booleans; the same name on several solids merges into one
   * feature.
   */
  label(name: string): Solid;
  /** Axis-aligned bounds (a query, not a transform). */
  boundingBox(): BoundingBox3;
  /** Volume in mm³. */
  volume(): number;
  translate(v: Point3): Solid;
  /** Internal primitive — prefer `rotateX`/`rotateY`/`rotateZ`/`rotateAbout`. */
  rotate(deg: number, center: Point3, axis: Point3): Solid;
  rotateX(deg: number): Solid;
  rotateY(deg: number): Solid;
  rotateZ(deg: number): Solid;
  /** General rotation: `axis` names a world axis or gives a vector. */
  rotateAbout(o: { axis: AxisName | Point3; deg: number; through?: Point3 }): Solid;
  /** Orient the canonical +Z build axis along `dir`. */
  along(dir: AxisDirection): Solid;
  /** Place an origin-built solid at point `v` (readable alias of `translate`). */
  at(v: Point3): Solid;
  mirror(plane: MirrorPlane): Solid;
  /** Uniform scale about `center` (default origin). */
  scale(factor: number, center?: Point3): Solid;
  toMesh(opts?: { quality?: MeshQuality }): Mesh;
  toSTL(opts?: { quality?: MeshQuality }): Promise<ArrayBuffer>;
  toIndexedMesh(): IndexedMesh;
  /**
   * Round edges. Manifold handles straight and circular chains natively and
   * triggers an automatic OCCT fallback for unsupported edge classes. Legacy
   * `(r, selector)` is accepted until contract v2.
   */
  fillet(r: number | { r: number; edges?: EdgeSelector }): Solid;
  /**
   * Bevel edges, with the same mesh-native coverage and OCCT fallback as
   * `fillet`. Legacy `(d, selector)` is accepted until contract v2.
   */
  chamfer(d: number | { d: number; edges?: EdgeSelector }): Solid;
  /**
   * Hollow inward, wall `t`, opening the faces `open` selects — OCCT only.
   * Closed (no open face) hollows are not supported.
   */
  shell(o: { t: number; open: FaceSelector }): Solid;
  /**
   * Morphological close-then-open with a ball of radius `r`: rounds EVERY edge
   * (convex and concave). Implemented natively on both backends — never routes,
   * never throws `KernelCapabilityError`. `roundAll(0)` is the identity.
   */
  roundAll(r: number | { r: number }): Solid;
  /** Through-hole count (Manifold only). */
  genus?(): number;
  /** No geometry at all (Manifold only). */
  isEmpty?(): boolean;
}

// --- kernel op option objects ----------------------------------------------

/** `k.cylinder` — a straight cylinder (`r`|`d`) or a frustum (`r1`,`r2` / `d1`,`d2`). */
export interface CylinderOptions {
  r?: number;
  d?: number;
  r1?: number;
  r2?: number;
  d1?: number;
  d2?: number;
  h: number;
  /** Centre the solid on Z too (default: base at z = 0). */
  center?: boolean;
}

export interface BoxOptions {
  /** `[x, y, z]` — centred in X/Y with the base at z = 0. */
  size?: Point3;
  center?: boolean;
  min?: Point3;
  max?: Point3;
}

export interface PrismOptions {
  points: PointsContour | ArcContour;
  h: number;
  /** Degrees of twist over the height. */
  twist?: number;
  /** Uniform top taper: 1 straight, < 1 taper in, 0 → a point. */
  scaleTop?: number;
}

export interface ExtrudeOptions {
  profile: ProfileInput;
  h: number;
  twist?: number;
  scaleTop?: number;
  /** 45° rim bevel (no `twist`/`scaleTop`; `bottom + top < h`). */
  bevel?: number | { bottom?: number; top?: number };
}

export interface LoftRing {
  /** Points, a curve contour, or a single-region hole-free `Shape2D` outline. */
  polygon?: Contour | Shape2D;
  sides?: number;
  radius?: number;
  z: number;
  /** Degrees about Z. */
  rotate?: number;
  scale?: number | Point2;
}

export interface LoftOptions {
  rings: LoftRing[];
  /** `false` = smooth C2 blend, honoured only by OCCT. */
  ruled?: boolean;
  /** Capless loop — Manifold only. */
  closed?: boolean;
  /** Overrides the facet-vs-smooth shading inference. */
  shading?: "smooth" | "faceted";
}

export interface SweepOptions {
  profile: PointsContour;
  /** A 3-D polyline, `[[x, y, z], …]`. */
  path: Point3[];
  /** Capless loop (must be planar) — Manifold only. */
  closed?: boolean;
  cornerRadius?: number;
  ruled?: boolean;
  /** OCCT-native swept B-rep. */
  smooth?: boolean;
}

/** `k.revolve` — a lathe profile `[[r, z], …]` with `r >= 0`, revolved about Z. */
export interface RevolveOptions {
  profile: ProfileInput;
  degrees?: number;
}

export interface HelixSweptTubeOptions {
  pathR: number;
  profileR: number;
  pitch: number;
  turns: number;
  z0: number;
  lefthand: boolean;
}

/** `k.screwSweep` — an axial lathe profile `[[r, z], …]` swept by screw motion. */
export interface ScrewSweepOptions {
  /** Closed axial contour; axial extent must not exceed `pitch`. */
  profile: number[][];
  /** Axial rise per turn, mm. */
  pitch: number;
  /** Number of turns swept; total height is `pitch * turns`. Cost scales with it. */
  turns: number;
  lefthand?: boolean;
}

/** `k.tappedBore` — a tapped (internally threaded) hole as ONE cut tool: the
 *  plain bore and its thread, fused, with the thread's root sunk inside the bore
 *  so the two never share a face. Hand-assembling the pair puts the bore wall and
 *  the thread root on exactly the same cylinder, which OCCT's boolean cannot
 *  resolve — measured at fifteen minutes without finishing, against ~10 s here. */
export interface TappedBoreOptions {
  /** Bore (minor/root) diameter, mm — the hole a tap would cut into. */
  d: number;
  /** Axial rise per turn, mm. */
  pitch: number;
  /** Number of thread turns; the thread is `pitch * turns` long. */
  turns: number;
  /** Plain-bore length, mm. Defaults to the thread's own length. */
  depth?: number;
  /** Radial thread height (major radius minus root), mm. Defaults to `0.15 * pitch`. */
  crest?: number;
  lefthand?: boolean;
  /** How far the thread's root sits INSIDE the bore, mm (default 0.2). Free
   *  rather than a compromise: the bore already removes that material, so the
   *  union is unchanged — it only stops the two tools being tangent. */
  rootSink?: number;
  /** How far the bore overhangs the thread at each end, mm (default 0.2).
   *  Flush ends are coincident faces, the same failure one layer down. */
  overshoot?: number;
}

/** One `k.loftSmooth` control section. Point arrays may tag true corners with
 *  `sharp`; curve contours and Shape2D outlines carry corners implicitly. */
export interface LoftSmoothSection {
  polygon?: Contour | Shape2D;
  sides?: number;
  radius?: number;
  z: number;
  /** Degrees about Z. */
  rotate?: number;
  scale?: number | Point2;
  /** Corner indices into a point-array polygon. */
  sharp?: number[];
}

/** k.loftSmooth — spline-interpolated loft of sparse control sections. */
export interface LoftSmoothOptions {
  /** Sparse control sections; vertex counts may differ between sections. */
  sections: LoftSmoothSection[];
  /** Output ring count along the spine (default 8 per span + 1; closed: 8 per section; capped at 1024). */
  stations?: number;
  /** Output vertex count around each ring (default max(64, largest section), capped at 2048). */
  samples?: number;
  shading?: "smooth" | "faceted";
  /** Capless loop — Manifold only, ≥3 sections. */
  closed?: boolean;
}

export interface RoundedCylinderOptions {
  r?: number;
  d?: number;
  h: number;
  center?: boolean;
  /** Rim round-over: a number (both rims) or per-rim. `round <= r`, `top + bottom <= h`. */
  round: number | { top?: number; bottom?: number };
}

export interface RoundedBoxOptions {
  size: Point3;
  center?: boolean;
  /** `side` = vertical edges, `top`/`bottom` = rims. */
  round: number | { side?: number; top?: number; bottom?: number };
}

export interface TorusOptions {
  rMajor: number;
  rMinor: number;
}

export interface BoredCylinderOptions {
  od: number;
  h: number;
  bore: number;
}

/** Horizontal alignment of a `text2d` block. */
export type TextAlign = "center" | "left" | "right";
/** Vertical alignment of a `text2d` block. */
export type TextVAlign = "middle" | "baseline" | "top" | "bottom";

export interface Text2dOptions {
  /** Cap height in mm (the design height of a capital letter). */
  size: number;
  /** A name declared in the part's `fonts` map; omit for the bundled default. */
  font?: string;
  align?: TextAlign;
  valign?: TextVAlign;
  /** Baseline-to-baseline distance in mm; omit for the font-metrics default. */
  lineHeight?: number;
  /** Letter spacing in mm. */
  tracking?: number;
  /** Pair-wise kerning (default `true`). */
  kerning?: boolean;
}

/** Horizontal alignment of a `vector2d` placement. */
export type Vector2dAlign = "center" | "left" | "right";
/** Vertical alignment of a `vector2d` placement. */
export type Vector2dValign = "middle" | "top" | "bottom";

export interface Vector2dOptions {
  /**
   * Name of one shape in the file, returned whatever its `role`. Omit for the
   * composed result: every `"add"` shape unioned, minus every `"subtract"` one.
   */
  shape?: string;
  /** Target width in mm. At most one of `width`/`height`/`fit`; required for `units: "artwork"`. */
  width?: number;
  /** Target height in mm. At most one of `width`/`height`/`fit`; required for `units: "artwork"`. */
  height?: number;
  /** Target size in mm for the larger extent. At most one of `width`/`height`/`fit`; required for `units: "artwork"`. */
  fit?: number;
  /** Defaults to `"center"` for `units: "artwork"`, and to no horizontal translate for `units: "mm"`. */
  align?: Vector2dAlign;
  /** Defaults to `"middle"` for `units: "artwork"`, and to no vertical translate for `units: "mm"`. */
  valign?: Vector2dValign;
}

/** Anything `k.hull`/`k.hullChain` accepts as one input. */
export type HullInput = Shape2D | Contour;

/** An inline depth-map grid, row-major, 0..65535 per sample. */
export interface HeightfieldGrid {
  width: number;
  height: number;
  data: Uint16Array;
}

/** k.heightfield — a depth map as a relief solid. */
export interface HeightfieldOptions {
  w: number;
  d: number;
  /** Slab thickness under the relief (mm, > 0). Default 1. */
  base?: number;
  /** Relief height above `base` at a full-scale (1.0) sample. Default 1. */
  maxZ?: number;
  /** Sample spacing (mm, > 0); clamped to a vertex budget with a build warning. Default 0.5. */
  pitch?: number;
  /** Flip sampled value as `1 - v`, applied after `range`. */
  invert?: boolean;
  /** Remap with clamped ends: `range[0]` -> 0, `range[1]` -> 1. Default [0, 1]. */
  range?: [number, number];
  /** Footprint placement in XY only — the base always sits at z = 0. Default "center". */
  origin?: "center" | "corner";
}

// --- the kernel -------------------------------------------------------------

/**
 * The backend-agnostic kernel handed to `build(k, p, d)`. The same code runs on
 * Manifold (mesh CSG) and OCCT/replicad (exact B-rep).
 *
 * Every multi-parameter op takes a single options object — the canonical calling
 * convention. Legacy positional forms stay silently accepted until contract v2
 * and are deliberately NOT declared here.
 */
export interface GeometryKernel {
  cylinder(o: CylinderOptions): Solid;
  /** Compound: a bored-through cylinder as one cache node. */
  boredCylinder(o: BoredCylinderOptions): Solid;
  /** Sphere centred at the origin; the bare `sphere(r)` form stays valid. */
  sphere(o: { r?: number; d?: number } | number): Solid;
  box(o: BoxOptions): Solid;
  /** Extrude a polygon (or arc profile) from z = 0. */
  prism(o: PrismOptions): Solid;
  /** Extrude a polygon-with-holes region from z = 0. */
  extrude(o: ExtrudeOptions): Solid;
  /** Revolve a lathe profile around Z. */
  revolve(o: RevolveOptions): Solid;
  /** Stack polygon cross-sections into a solid. */
  loft(o: LoftOptions): Solid;
  /** Sweep a 2-D profile along a 3-D polyline. */
  sweep(o: SweepOptions): Solid;
  helixSweptTube(o: HelixSweptTubeOptions): Solid;
  /** Sweep an axial lathe profile by screw motion — threads. */
  screwSweep(o: ScrewSweepOptions): Solid;
  /** A tapped hole as one cut tool — bore plus thread, never tangent. */
  tappedBore(o: TappedBoreOptions): Solid;
  /** Spline-interpolated loft of sparse control sections. */
  loftSmooth(o: LoftSmoothOptions): Solid;
  /** Rim round-overs via one lathe revolve; curve-exact in STEP. */
  roundedCylinder(o: RoundedCylinderOptions): Solid;
  torus(o: TorusOptions): Solid;
  /** Selective edge rounding built directly as one Manifold mesh. */
  roundedBox(o: RoundedBoxOptions): Solid;
  /** N-ary boolean union. */
  union(solids: Solid[]): Solid;
  /** Lift a profile into a 2-D boolean value. */
  shape2d(profile: ProfileInput): Shape2D;
  /** Render outline-font text as a `Shape2D`. */
  text2d(string: string, opts?: Text2dOptions): Shape2D;
  /**
   * Place a declared vector file as a `Shape2D`. `name` is a key in the part's
   * `vectors` field (`partforge-vector` JSON, not raw `.svg`).
   */
  vector2d(name: string, opts?: Vector2dOptions): Shape2D;
  /** Convex hull of all inputs → a convex (faceted) `Shape2D`. */
  hull(inputs: HullInput[]): Shape2D;
  /** Swept hull over an ordered sequence (>= 2 inputs). */
  hullChain(inputs: HullInput[]): Shape2D;
  /** STEP bytes — OCCT only (Manifold throws `KernelCapabilityError`). */
  toSTEP(named: Array<{ name: string; solid: Solid }>): Promise<ArrayBuffer>;
  /**
   * Imported geometry declared in the part's `imports` field, registered
   * pre-build by the framework via the underscore-prefixed `_registerImport`
   * side-channel (not a part author's calling surface).
   */
  import(name: string): Solid;
  /**
   * A depth map as a relief solid. `nameOrGrid` is a name declared in the part's
   * `images` field, or an inline grid — the name path is registered pre-build by
   * the framework via the underscore-prefixed `_registerImage` side-channel (not
   * a part author's calling surface).
   */
  heightfield(nameOrGrid: string | HeightfieldGrid, opts: HeightfieldOptions): Solid;

  // Backend-optional: the sub-part cache brackets and WASM lifetime hooks. Every
  // framework caller reaches these through `?.`, so a third-party backend may
  // omit them entirely.

  /** Open a per-sub-part solid-cache round. */
  beginSubPart?(name: string): void;
  /** Close the cache round — always pair with `beginSubPart`. */
  endSubPart?(): void;
  /** Drop cache partitions idle for 3 rebinds. Never call mid-bracket. */
  sweepCache?(): void;
  cacheStats?(): { hits: number; misses: number };
  resetCacheStats?(): void;
  /** Free per-job WASM objects (Manifold backend); call after each job. */
  cleanup?(): void;
  /**
   * Drain the feature-skip warnings recorded since the last drain — one message
   * per fillet/chamfer (or roundAll) the backend skipped instead of failing the
   * build over. Drain per sub-part to attribute each message to its build.
   */
  takeBuildWarnings?(): string[];
}
