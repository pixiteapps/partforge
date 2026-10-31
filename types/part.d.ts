// The `PartDefinition` contract — the central type of partforge.
//
// Derived from docs/AUTHORING-PARTS.md ("The PartDefinition contract"), from the
// eight parts in src/parts/, and above all from what the framework actually
// READS: src/framework/part-model.js (views/enabled/place/defaults/derive),
// src/framework/derive.js, src/framework/controls.js (the parameter schema),
// src/framework/lint/rules-{shape,schema}.js (which fields are required vs.
// ignored), src/framework/export-select.js (`exportable`/`export.name`), and
// src/framework/oracle/verify.js + src/framework/verify-metrics.js (the `verify`
// block's metric vocabulary).

import type { BackendName, GeometryKernel, Point2, Point3, ProfileInput, Solid } from "./kernel.js";

/**
 * A value the control panel can hold. Sliders and number boxes write numbers;
 * `text`/`textarea` controls write strings; toggles write `on` or `0`.
 */
export type ParamValue = number | string | boolean;

/**
 * The flat parameter object a part's `defaults` seeds and the control panel
 * mutates in place.
 */
export type Defaults = Record<string, ParamValue>;

/**
 * The resolved parameters a build sees: `{ ...part.defaults, ...userParams }`.
 *
 * Deliberately loose. Parts index it with computed keys and do arithmetic on
 * every read, and partforge does not (yet) infer a per-part params type from
 * `defaults` — narrowing this to `ParamValue` would make `p.h / 2` an error in
 * every part ever written. Supply the `P` type argument of `PartDefinition` to
 * get a checked params object.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see the doc comment
export type ResolvedParams = Record<string, any>;

/** The derived-values object `derive` produces and every build receives as `d`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- part-defined, unconstrained
export type Derived = Record<string, any>;

// --- meta -------------------------------------------------------------------

export interface PartMeta {
  /** Names the part in the viewer and in export filenames. Required (lint errors without it). */
  title: string;
  /** Display units; partforge geometry is always millimetres. */
  units?: string;
  /** Scene background as `0xRRGGBB`. */
  background?: number;
  /** Realistic-mode lighting/ground preset. See docs/AUTHORING-PARTS.md "Materials and appearance". */
  environment?: "studio" | "workshop" | "print-bed" | "outdoor" | string;
  /** Pin a backend instead of letting the probe route the part. */
  backend?: BackendName;
}

// --- the parameter schema ---------------------------------------------------

/** Which input a control renders as. Omit for a slider + number box. */
export type ControlKind = "slider" | "number" | "text" | "textarea";

/** Every control type the panel can render. */
export type ControlType = "slider" | "number" | "text" | "textarea" | "checkbox" | "select" | "radio" | "font" | "image" | "vector" | "custom";

/** A declarative visibility condition, evaluated against raw parameters. */
export type WhenCondition =
  | { allOf: WhenCondition[] }
  | { anyOf: WhenCondition[] }
  | { not: WhenCondition }
  | Record<string, ParamValue | {
      gt?: number; gte?: number; lt?: number; lte?: number;
      ne?: ParamValue; in?: ParamValue[];
    }>;

/** One entry in a `controls` array: a control, a nested group, a preset picker, or a readout. */
export type PanelEntry = PanelControlEntry | PanelGroupEntry | PanelPresetEntry | PanelReadoutEntry;

/** A control bound to one key in `defaults`. `type` defaults to `"slider"`. */
export interface PanelControlEntry {
  key: string;
  type?: ControlType;
  label?: string;
  description?: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  /** checkbox: the value written when ticked (default 1). */
  on?: number;
  /** select / radio: the choices. Strings are both value and label. */
  options?: Array<ParamValue | { value: ParamValue; label?: string; description?: string }>;
  /** slider: logarithmic response. Requires min > 0. */
  scale?: "log";
  /** slider: marked values on the track; `snap: true` makes the thumb prefer them. */
  ticks?: number[];
  snap?: boolean;
  /** slider: [lo, hi] band drawn on the track; outside it the value box takes a warning tint. */
  recommended?: [number, number];
  /**
   * custom: the widget function. Called once per mount with a host object
   * (see `CustomControlHost` in index.d.ts); draws into `host.el`. The key
   * this control owns may hold a JSON value (arrays and plain objects of
   * primitives, ≤16 KB, depth ≤8).
   */
  widget?: (host: import("./index.js").CustomControlHost) => import("./index.js").CustomControlInstance | void;
  /** custom: further scalar params the widget may write besides `key`. */
  keys?: string[];
  hidden?: boolean;
  when?: WhenCondition;
  whenFalse?: "disable";
  /** These two discriminate against the container entries. */
  controls?: undefined;
  presets?: undefined;
}

/** A nested group. `collapsed` defaults to `"auto"` (the small-panel auto-open rule). */
export interface PanelGroupEntry {
  type: "group";
  id?: string;
  title?: string;
  collapsed?: boolean | "auto";
  /** No title, no disclosure — just an indented block. */
  bare?: boolean;
  controls: PanelEntry[];
  hidden?: boolean;
  when?: WhenCondition;
  whenFalse?: "disable";
}

/** A preset picker, positionable anywhere among the controls. */
export interface PanelPresetEntry {
  type: "preset";
  id?: string;
  label?: string;
  /** Preset name -> the param overrides it applies. */
  presets: Record<string, Record<string, ParamValue>>;
  hidden?: boolean;
  when?: WhenCondition;
  whenFalse?: "disable";
}

/** A read-only display of one `derive()` output. Not bound to `defaults`. */
export interface PanelReadoutEntry {
  type: "readout";
  label?: string;
  description?: string;
  unit?: string;
  derivedKey: string;
  hidden?: boolean;
  when?: WhenCondition;
  whenFalse?: "disable";
  key?: undefined;
  controls?: undefined;
  presets?: undefined;
}

/**
 * One parameter control in a legacy `advanced` / `sliders` array. The recognised
 * field list is the registry's, `fieldsFor("slider")` in
 * src/framework/panel/widget-specs.js — anything else is ignored by the panel and
 * warned about by `partforge lint`.
 *
 * @deprecated Prefer a `controls` array of control nodes. Still fully supported.
 */
export interface ControlDef {
  /** Must exist in `defaults`, or the control is silently dead. */
  key: string;
  label?: string;
  /** Suffix shown beside the value box, e.g. `"mm"`. */
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  control?: ControlKind;
  /** Omit from the panel; the key still exists and still drives the geometry. */
  hidden?: boolean;
  /** CommonMark shown in a click-open ⓘ popover. */
  description?: string;
}

/**
 * A feature: a checkbox that sets `key` to `on` (or `0`) and reveals its own
 * controls. `sliders` is REQUIRED — the panel reads `feat.sliders.filter(...)`
 * unguarded. A bare on/off control belongs in `toggles` instead.
 *
 * @deprecated Prefer a `controls` array of control nodes. Still fully supported.
 */
export interface FeatureDef {
  key: string;
  label?: string;
  /** The value written when the box is checked. */
  on: number;
  sliders: ControlDef[];
  hidden?: boolean;
  description?: string;
}

/**
 * A standalone on/off checkbox shown below the preset picker, outside the
 * Advanced fold. Checked writes `on` (default `1`); unchecked writes `0`.
 *
 * @deprecated Prefer a `controls` array of control nodes. Still fully supported.
 */
export interface ToggleDef {
  key: string;
  label?: string;
  on?: number;
  hidden?: boolean;
  description?: string;
}

/** Fields every section kind shares. */
interface SectionBase {
  id?: string;
  title?: string;
  description?: string;
  /** Omit the whole section from the panel. */
  hidden?: boolean;
}

/** A preset picker plus optional toggles and an Advanced block. */
export interface PresetSection extends SectionBase {
  /** Preset name → the param overrides it applies. */
  presets?: Record<string, Record<string, ParamValue>>;
  toggles?: ToggleDef[];
  /** Controls revealed under "Advanced". */
  advanced?: ControlDef[];
  /** A section with `features` is a feature section; `advanced` is ignored there. */
  features?: undefined;
  /** Discriminator: a PresetSection carries no `controls` array. */
  controls?: undefined;
}

/** A feature-toggle section: each feature is a checkbox plus its own controls. */
export interface FeatureSection extends SectionBase {
  features: FeatureDef[];
  /** Discriminator: a FeatureSection carries no `controls` array. */
  controls?: undefined;
}

/** The new section shape: everything in `controls`, in render order. */
export interface NodeSection extends SectionBase {
  controls: PanelEntry[];
  collapsed?: boolean | "auto";
  when?: WhenCondition;
  whenFalse?: "disable";
  /** Discriminators: a NodeSection carries none of the legacy arrays. */
  features?: undefined;
  advanced?: undefined;
  toggles?: undefined;
  presets?: undefined;
}

export type ParameterSection = PresetSection | FeatureSection | NodeSection;

// --- fonts ------------------------------------------------------------------

/**
 * One entry of a part's `fonts` map: raw bytes, a URL string, or a thunk
 * returning either (a Vite `() => import("./x.ttf")` resolves to
 * `{ default: url }`). Resolved before the synchronous `build` runs.
 */
export type FontSource =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | (() => FontSourceValue | Promise<FontSourceValue>);

type FontSourceValue = string | ArrayBuffer | ArrayBufferView | { default: string };

// --- images -----------------------------------------------------------------

/**
 * One entry of a part's `images` map: raw bytes, a URL string, or a thunk
 * returning either (a Vite `() => import("./x.png")` resolves to
 * `{ default: url }`). Resolved to a decoded luminance grid before the
 * synchronous `build` runs — the source `k.heightfield()` samples.
 */
export type ImageSource =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | (() => ImageSourceValue | Promise<ImageSourceValue>);

type ImageSourceValue = string | ArrayBuffer | ArrayBufferView | { default: string };
// --- imports and vectors ------------------------------------------------------

/**
 * One entry of a part's `imports` map: the STEP/STL/3MF file a `k.import()` call
 * names. Same source grammar and preload timing as {@link FontSource}.
 */
export type ImportSource = FontSource;

/**
 * One entry of a part's `vectors` map: a `partforge-vector` file for `k.vector2d()`
 * to place — never a raw `.svg`, which nothing in the geometry worker can read.
 *
 * Beyond the bytes/URL/thunk forms every asset source accepts, a vector source may
 * be the file's ALREADY-PARSED contents: the object a `.vector.json` yields when
 * something has imported or fetched it. That is the form to reach for when the
 * artwork lives in the part's own tree and is meant to stay readable and editable,
 * rather than sitting behind an opaque asset token.
 *
 * The object is read, never written, and is validated on every resolve — so a
 * malformed one fails with the same message its on-disk twin would produce.
 */
export type VectorSource =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | VectorDocument
  | (() => VectorSourceValue | Promise<VectorSourceValue>);

type VectorSourceValue =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | VectorDocument
  | { default: string | VectorDocument };

/**
 * The parsed contents of a `partforge-vector` file. `docs/VECTOR-FORMAT.md` is the
 * normative spec; this type is deliberately shallow — it pins the envelope every
 * reader depends on and leaves contour shapes to the runtime validator, which
 * reports far better errors than a structural type mismatch can.
 */
export interface VectorDocument {
  format: "partforge-vector";
  version: number;
  units: "mm" | "artwork";
  shapes: Record<string, unknown>;
  source?: unknown;
  bbox?: unknown;
  note?: string;
}

// --- derive -----------------------------------------------------------------

/**
 * A part's `derive`. Either one function computed in a single pass, or named
 * GROUPS run in declaration order — each group receives the params plus the
 * merged outputs of the groups before it. The grouped form is what lets the
 * relevance layer attribute each derived value to just its own group's inputs.
 *
 * A group that reads a key no earlier group produced throws.
 */
export type DeriveSpec<P = ResolvedParams, D = Derived> =
  | ((p: P) => D | void)
  | Record<string, (p: P, d: D) => D | void>;

// --- sub-parts --------------------------------------------------------------

/** The argument to the LEGACY `place` (views-array form); the `views` map form needs none. */
export interface PlaceContext<P = ResolvedParams, D = Derived> {
  /** The active view. Display placement must NOT depend on it. */
  view: string;
  purpose: "display" | "export";
  p: P;
  d: D;
}

export interface SubPartDefinition<P = ResolvedParams, D = Derived> {
  /** Display name in tabs/progress; defaults to the key. */
  label?: string;
  /**
   * The canonical solid, built at the origin. The only required function.
   * `onProgress?.("phase")` surfaces per-feature progress during export.
   */
  build: (k: GeometryKernel, p: P, d: D, onProgress?: (phase: string) => void) => Solid;
  /**
   * LEGACY form (with a `views` array); with a `views` map put each pose in its
   * entry instead. Optional reposition (default identity), for a part whose display pose
   * differs from its export pose. Any such difference must be a RIGID motion.
   */
  place?: (solid: Solid, ctx: PlaceContext<P, D>) => Solid;
  /**
   * Each view the sub-part appears in: a map of view name to `true` (shown as
   * built) or a rigid pose `(s, p, d) => s.translate(…)`. Every name must exist in
   * the part's `views`. The legacy form, an array of names (placed by `place`),
   * still works.
   */
  views: string[] | Record<string, true | ((s: Solid, p: P, d: D) => Solid)>;
  /** Gate a conditional sub-part. Coerced with `!!`. */
  enabled?: (p: P) => unknown;
  /** `false` = reference/preview-only: shown in the viewer, never exported. */
  exportable?: boolean;
  /**
   * Name of a declared `imports` entry this sub-part is held to. When set,
   * `measure()` computes a `deviation` fact (symmetric-difference volume,
   * volume delta %, bbox-corner drift) against that import's posed solid, and
   * `verify.expect.<subpart>` may use the `refXorVolume` / `refVolumeDeltaPct`
   * / `refBboxDelta` gate metrics.
   */
  reference?: string;
  /** Viewer-only appearance. See docs/AUTHORING-PARTS.md "Materials and appearance". */
  display?: {
    color?: number;
    opacity?: number;
    /** A preset id from docs/AUTHORING-PARTS.md "Materials and appearance". */
    material?: string;
    roughness?: number;
    metalness?: number;
    clearcoat?: number;
    clearcoatRoughness?: number;
    anisotropy?: number;
    textureScale?: number;
  };
  /** Filename / object name on export; defaults to the key. */
  export?: { name: string };
  /**
   * Set by `sheetPart()` (partforge/geometry) on a sub-part cut from flat stock: its
   * cut/score/engrave declaration, and the one marker framework code recognizes a
   * sheet part by. Never written by hand.
   */
  sheet?: SheetDeclaration<P, D>;
}

// --- sheet parts ------------------------------------------------------------

/** An axis direction, as a sheet pose names its face and up. */
export type AxisWord = "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z";

/**
 * Where a sheet part sits in the assembly (docs/AUTHORING-PARTS.md "Sheet parts").
 * The part is drawn in its own frame — profile in XY, material over z ∈ [0, t], the
 * laser face at z = t. `face` is the laser face's outward normal, `up` the drawing's
 * +y (perpendicular to `face`), `at` where drawing [0, 0] lands; drawing +x is
 * `up × face`, so a pose is always a proper rotation and never mirrors.
 */
export interface SheetPose {
  face: AxisWord;
  up: AxisWord;
  at: Point3;
}

/** One `score` entry: exactly two points is a LINE; anything else is a shape whose boundaries are all scored. */
export type SheetScoreEntry = [Point2, Point2] | ProfileInput | null;

/** The plain-data declaration `sheetPart()` attaches as `sub.sheet`. */
export interface SheetDeclaration<P = ResolvedParams, D = Derived> {
  process: string;
  material: string | ((p: P, d: D) => string);
  thickness: number | ((p: P, d: D) => number);
  profile: (k: GeometryKernel, p: P, d: D) => ProfileInput;
  score: ((k: GeometryKernel, p: P, d: D) => SheetScoreEntry[] | null) | null;
  engrave: ((k: GeometryKernel, p: P, d: D) => ProfileInput | null) | null;
  /** `null` = flat: no transform. */
  pose: SheetPose | ((p: P, d: D) => SheetPose | null) | null;
  /** The build `sheetPart` made; `sub.build !== sub.sheet.generatedBuild` is a custom build. */
  generatedBuild: (k: GeometryKernel, p: P, d: D) => Solid;
  /** The author's own `place` (the spec's), run after the pose; `null` when there is none. */
  place: ((solid: Solid, ctx: PlaceContext<P, D>) => Solid) | null;
  /** The `place` `sheetPart` installed (the pose, then the author's own), or `null`; `sub.place !== sub.sheet.generatedPlace` is a replaced place. */
  generatedPlace: ((solid: Solid, ctx: PlaceContext<P, D>) => Solid) | null;
}

export interface ViewDefinition {
  label: string;
  /**
   * Open this view first. With none flagged, the first key wins — see
   * `default-view.js`, which also falls back when the flagged view is empty.
   */
  default?: boolean;
  /**
   * Named animations belonging to this view — keyframe data driving this view's
   * params and sub-part opacity over time. See `AnimationSpec` below; the
   * transport bar shows one view's animations at a time, and `play(name)`
   * resolves within the active view. Animations live ONLY here: a top-level
   * `part.animations` is a lint error and is ignored at runtime.
   */
  animations?: Record<string, AnimationSpec>;
}

// --- the verify block -------------------------------------------------------

/** A built-in design-for-manufacturing process profile. */
export type DfmProfileName = "fdm-pla" | "fdm-petg" | "resin";

/** An inline DFM profile, optionally extending a named one. */
export interface DfmProfile {
  /** Build volume `[x, y, z]` in mm — a hard bbox-fit gate. */
  bed?: [number, number, number];
  /** Minimum wall in mm — a warning, never a gate. */
  minWall?: number;
  /**
   * Steepest unsupported face the process prints cleanly, in degrees from
   * vertical (45 on the FDM profiles; absent on resin). The print process alone
   * arms the check; `null` switches it off under a named base. Reported as a
   * cost (needing supports), never a failure.
   */
  overhang?: number | null;
  /**
   * The least share (%) of a printed piece's near-bed flat underside that must rest
   * on the bed (50 on the FDM profiles; absent on resin). A GATE, armed by the
   * profile alone; `null` switches it off under a named base.
   */
  bedContact?: number | null;
  /** Percent of a printed piece's posed base area resting on the bed below which the footprint cost fires. */
  footprint?: number | null;
  /** Carried for a future gap check; not enforced yet. */
  clearance?: number;
  /**
   * Diametral fit offsets in mm, negative = interference: `press` (never comes
   * out), `push` (pressed on by hand), `slip` (lifts off), `moving` (a pin or
   * axle), `printInPlace` (printed assembled). Guide defaults; an inline profile
   * replaces the whole table.
   */
  fits?: { press: number; push: number; slip: number; moving: number; printInPlace: number };
  /** Added to a horizontal bore's diameter — a printed arch sags inward. */
  holeUndersize?: number;
  /** Longest flat span printed unsupported, mm. Absent on a process that prints on supports. */
  bridge?: number;
  /**
   * The least root fillet a flexing member (`verify.flex`) must meet its body through,
   * as a share of the member's thickness (0.5 on every built-in profile) — a GATE,
   * armed by `verify.flex` alone; `null` switches it off under a named base.
   */
  rootFillet?: number | null;
  /**
   * The largest root strain, in percent, the material takes for a one-time snap (1.5 on
   * PLA, 3 on PETG, 2 on resin) — an advisory, read for a flexing member that declares
   * a `deflection`; `null` switches it off under a named base.
   */
  strain?: number | null;
  /**
   * The steepest a flexing member's long axis may rise off the bed in the print pose, in
   * degrees (45 on the FDM profiles; absent on resin, which is isotropic), before its
   * layers stack across the root. A cost (`standing`), armed by the profile alone.
   */
  flexTilt?: number | null;
  /** Inherit from a named profile and override the rest. */
  base?: DfmProfileName | DfmProfile;
}

/**
 * One assertion in the verify DSL: a bare number/boolean means equality;
 * a string is `">=n"`, `"<=n"`, `">n"`, `"<n"`, a range `"a..b"` (optional
 * `mm`/`cm`/`mm3`/`cm3` suffix), or a componentwise vector `"<=[x,y,z]"` where
 * `*` skips an axis.
 */
export type AssertionExpr = number | string | boolean;

/** An expectation, optionally carrying a part-authored corrective `hint`. */
export type Expectation = AssertionExpr | { expr: AssertionExpr; hint?: string };

/**
 * `bounds`: where the geometry sits, written in the same `{ min, max }` shape
 * `measure` reports — `{ min: ">=[0,0,0]", max: "<=[220,220,250]" }`. Each side is
 * a componentwise vector expectation (`*` skips an axis); either may be left out.
 */
export interface BoundsExpectation {
  min?: Expectation;
  max?: Expectation;
}

/**
 * Per-sub-part expectations. The keys are exactly `SUBPART_METRICS` in
 * src/framework/verify-metrics.js. `holes`/`watertight` are Manifold-only and
 * SKIP on an OCCT part; `minWall` is a warning, never a gate.
 */
export interface SubPartExpectations {
  holes?: Expectation;
  watertight?: Expectation;
  volume?: Expectation;
  surfaceArea?: Expectation;
  triangleCount?: Expectation;
  bbox?: Expectation;
  centerOfMass?: Expectation;
  /** The axis-aligned corners: `{ min: ">=[x,y,z]", max: "<=[x,y,z]" }`, as `measure` reports `bounds`. */
  bounds?: BoundsExpectation;
  /** @deprecated Write `bounds: { min }` — still evaluated, no longer taught. */
  boundsMin?: Expectation;
  /** @deprecated Write `bounds: { max }` — still evaluated, no longer taught. */
  boundsMax?: Expectation;
  minWall?: Expectation;
  /**
   * A wall that must stay one thickness, as a range in mm (`"1.8..2.2"`; range
   * form only). Rides the same inward rays as `minWall` — a ray reading inside
   * `[0.75 × min, 1.5 × max]` counts as this wall — and warns when the member
   * farthest from the band lies outside it. A warning, never a gate.
   */
  wall?: Expectation;
  /**
   * Unsupported downward-facing surface in mm² (faces steeper than the profile's
   * `overhang` angle, bed at the sub-part's own lowest Z). Armed by the print
   * process alone; reported as a cost (`verify.costs`), never a failure.
   */
  overhangArea?: Expectation;
  /**
   * Share (0–100) of the sub-part's near-bed flat underside — faces within 2° of
   * level, within 1 mm of its lowest point in the print pose — that touches the bed.
   * Under an FDM profile every printed sub-part gets `>=50` by default; a gate.
   */
  bedContactPct?: Expectation;
  /**
   * Share (0–100) of the sub-part's posed base area (its xy extent in the print pose)
   * whose flat underside touches the bed — near 0 for a piece standing on a point, a
   * line or a curl. Under an FDM profile every printed sub-part gets `>=5`; reported as
   * a cost (`verify.costs`), never a failure; `accept: ["footprint"]` records a brim.
   */
  footprintPct?: Expectation;
  /**
   * The root fillet radius (mm, 0 where sharp) of the flexing member named in
   * `verify.flex` whose root is worst on this sub-part — `feature` names it. Every
   * sub-part carrying a declared member gets `>=` the profile's share of the member's
   * thickness by default; a gate.
   */
  flexRoot?: Expectation;
  /**
   * Root strain (%) of the worst declared flexing member on this sub-part at its declared
   * deflection — 1.5 × thickness × deflection / length², a straight cantilever. Under a
   * profile every member with a `deflection` gets `<=` the profile's `strain`; a warning.
   */
  flexStrain?: Expectation;
  /**
   * Degrees the worst declared flexing member's long axis rises off the bed in the
   * print pose (0 lying flat, 90 standing). Under an FDM profile every member gets
   * `<=45`; reported as a cost (`standing`), never a failure.
   */
  flexTilt?: Expectation;
  /** Symmetric-difference volume vs. the sub-part's declared `reference` import. */
  refXorVolume?: Expectation;
  /** Percent volume delta vs. the sub-part's declared `reference` import. */
  refVolumeDeltaPct?: Expectation;
  /** Bounding-box corner drift `[dx, dy, dz]` vs. the sub-part's declared `reference` import. */
  refBboxDelta?: Expectation;
  /**
   * Sheet parts only (`sheetPart()`): the narrowest web or finger in the cut
   * profile, mm. verify checks it on every sheet part at `>=` max(half the
   * thickness, 0.5 mm) as a volunteered warning; declare it to make it count.
   * Nothing narrower than twice that floor reads as the ceiling, with a note.
   */
  sheetBridge?: Expectation;
  /** Sheet parts only: the narrowest hole, slot or notch in the cut profile, mm. Same floor as `sheetBridge`. */
  sheetGap?: Expectation;
  /** Sheet parts only: engrave/score mark regions lying outside the cut (volunteered check: `0`). */
  sheetMarks?: Expectation;
  /** Sheet parts only: separate regions in the cut profile (volunteered check: `1`). */
  sheetPieces?: Expectation;
  /** Sheet parts with a custom `build` only: % volume drift from profile area × thickness minus the marks (volunteered check: `<=2`). */
  sheetSolidMatch?: Expectation;
  /** Routed parts only: pocket, drill or extra-op footprint regions outside the profile (volunteered check: `0`). */
  routedOutside?: Expectation;
  /** Routed parts only: pockets whose region resolved empty (volunteered check: `0`). */
  routedEmpty?: Expectation;
  /** Routed parts only: separate regions in the cut profile (volunteered check: `1`). */
  routedPieces?: Expectation;
  /** Routed parts only: overlapping near- and far-face pocket pairs whose depths together exceed the stock (volunteered check: `0`). */
  routedBreakthrough?: Expectation;
}

/**
 * Whole-view expectations, under the reserved `_view` key. The scalar metrics
 * are exactly `VIEW_METRICS`; `contacts`/`clearance` are pair-wise and handled
 * separately by verify.js.
 */
export interface ViewExpectations {
  bbox?: Expectation;
  volume?: Expectation;
  overlaps?: Expectation;
  centerOfMass?: Expectation;
  /** The axis-aligned corners: `{ min: ">=[x,y,z]", max: "<=[x,y,z]" }`, as `measure` reports `bounds`. */
  bounds?: BoundsExpectation;
  /** @deprecated Write `bounds: { min }` — still evaluated, no longer taught. */
  boundsMin?: Expectation;
  /** @deprecated Write `bounds: { max }` — still evaluated, no longer taught. */
  boundsMax?: Expectation;
  /** Pairs that must touch, as `[["a", "b"], …]`. */
  contacts?: Array<[string, string]>;
  /** Intended free fits, keyed `"a×b"` (order-insensitive). */
  clearance?: Record<string, Expectation>;
  /**
   * Every exportable sub-part must be connected, through contact or overlap, to
   * the base: the lowest sub-part (`true`) or the named one. Topological only.
   */
  held?: true | string;
}

/** `verify.expect`: sub-part names plus the reserved `_view` key. */
export interface ExpectMap {
  _view?: ViewExpectations;
  [subPart: string]: SubPartExpectations | ViewExpectations | undefined;
}

export interface VerifyBlock<P = ResolvedParams, D = Derived> {
  /** A named DFM profile or an inline one. */
  process?: DfmProfileName | DfmProfile;
  /**
   * `"print"` declares that `build()` is the print pose — Z up, each sub-part's
   * bed at its own lowest Z. It does not arm any check; the print process does.
   */
  orientation?: "print";
  /**
   * Costs the user accepted, by id. An accepted cost is still measured and
   * reported (`accepted: true`), but no longer raised as something to fix. Only the
   * process's own default check is marked accepted: a limit you wrote in `expect`
   * (`overhangArea: "<=500"`) keeps its meaning and is never marked accepted.
   */
  accept?: ("supports" | "footprint" | "standing")[];
  /**
   * The part's flexing members — snap arms, buckle prongs, clips, cantilever tabs —
   * by feature label. Each must meet the rest of its part through a root fillet of at
   * least the process's share of its thickness (`flexRoot`, a gate); one that declares
   * its `deflection` (mm of travel) is also read for root strain (`flexStrain`, an
   * advisory), and under an FDM profile every member is read for how far it stands up
   * off the bed (`flexTilt`, the `standing` cost). An entry is a label, a list of labels
   * that make one member (an arm and the rib on it), or a member object; `thickness`
   * (mm) overrides the bending thickness the mesh reads. Label the member apart from
   * the body it grows from.
   */
  flex?: (string | string[] | { feature: string; labels?: string[]; deflection?: number; thickness?: number })[];
  /** Which cases to check; default is `"defaults"` plus every preset name. */
  cases?: string[];
  /**
   * Design intent, by sub-part name (plus `_view`). Declare it as a pure
   * function of the case's resolved `(p, d)` when a preset legitimately changes
   * an asserted fact.
   */
  expect?: ExpectMap | ((p: P, d: D) => ExpectMap);
}

// --- animations -------------------------------------------------------------

/** A timing curve across a step. Mirrors `EASINGS` in src/framework/animation.js. */
export type Easing = "linear" | "ease-in" | "ease-out" | "ease-in-out";

/**
 * `[t, value]` keyframes for one param. `t` is normalized WITHIN the owning
 * step: strictly ascending, from exactly 0 to exactly 1, at least two entries.
 * Values must sit inside the owning control's min/max — the engine applies
 * them unclamped. `partforge lint` enforces all of that.
 */
export type Keyframes = Array<[number, number]>;

/**
 * The seven angles the viewer can frame a part from. Defined here rather than in
 * the app entry so `CameraCue` can be the real union without an import cycle —
 * the app entry re-exports it under its own name.
 */
export type CanonicalView = "iso" | "front" | "back" | "left" | "right" | "top" | "bottom";

/**
 * The view cube's other orientations: its edges and corners, named vertical,
 * then depth, then side. `"top-front-right"` is the same camera as `"iso"`.
 */
export type ViewCubeOrientation =
  | "top-front" | "top-back" | "top-left" | "top-right"
  | "bottom-front" | "bottom-back" | "bottom-left" | "bottom-right"
  | "front-left" | "front-right" | "back-left" | "back-right"
  | "top-front-left" | "top-front-right" | "top-back-left" | "top-back-right"
  | "bottom-front-left" | "bottom-front-right" | "bottom-back-left" | "bottom-back-right";

/**
 * A free-form camera angle, for the ones no name reaches. Degrees, in the
 * part's own frame: `azimuth` 0 looks from the front (-Y) and turns toward the
 * right (+X) at 90, back at 180, left at -90; `elevation` is above the
 * horizontal, -90..90. `iso` is `{ azimuth: 45, elevation: 35.26 }` and
 * `front-right` is `{ azimuth: 45, elevation: 0 }`. `distance` multiplies the
 * framing distance a named angle uses (default 1; 0.1..10). The camera always
 * aims at the part's centre.
 */
export interface CameraOrbit {
  azimuth: number;
  elevation: number;
  distance?: number;
}

/**
 * A camera cue: one of the canonical seven, a view-cube orientation, or a
 * free-form `CameraOrbit`. `partforge lint` rejects anything else
 * (`animation-camera-invalid`). Cues fire during play only; scrubbing never
 * moves the camera.
 */
export type CameraCue = CanonicalView | ViewCubeOrientation | CameraOrbit;

/** One step of a multi-step animation. Steps play in order; prev/next navigate them. */
export interface AnimationStep {
  /** Shown in the transport bar. Defaults to `"Step <n>"`. */
  label?: string;
  /** Seconds. Step durations are relative — they set each step's share of the timeline. */
  duration: number;
  easing?: Easing;
  /**
   * Param key -> keyframes. A param tracked nowhere keeps its current value.
   *
   * Optional so a step can carry only `opacity`, or move only the camera — an
   * establishing shot that holds the pose while the view swings round.
   * `partforge lint` still requires that at least one step in the animation
   * carries `tracks` or `opacity`, which is a whole-animation rule the type
   * system can't express per step.
   */
  tracks?: Record<string, Keyframes>;
  /**
   * Sub-part name → opacity keyframes (values 0–1; 0 = fully hidden, mesh and
   * edge lines both; multiplies any static `display.opacity`). Same keyframe
   * rules as `tracks`; the same hold rule applies across steps. Display-only:
   * never affects params, export, measure, or verify.
   */
  opacity?: Record<string, Keyframes>;
  /**
   * Swing the camera to this angle, starting when the step begins and taking
   * the step's whole duration — so a slow orbit can be timed to the motion it
   * frames. (Starting playback at this step instead makes a short move there
   * before anything else runs.)
   */
  camera?: CameraCue;
}

/**
 * The fields both animation forms share. Exported so a host can extend it —
 * `AnimationSpec` itself is a union and cannot be `extends`-ed.
 */
export interface AnimationSpecCommon {
  /** Shown in the transport bar's picker. Defaults to the animation's key. */
  label?: string;
  /** CommonMark, shown behind the ⓘ glyph. */
  description?: string;
  easing?: Easing;
  /** Wrap continuously. Single-step animations only. */
  loop?: boolean;
  /**
   * One mechanism per animation: an angle (an intro cue at t=0), a
   * `[[t, angle], …]` cue list, or per-step `camera` names. A listed cue's
   * camera move lasts until the next cue (or the end of the animation).
   */
  camera?: CameraCue | Array<[number, CameraCue]>;
  /**
   * Start this animation automatically on first show and again on each view
   * switch, until the user touches the transport. At most one animation per
   * VIEW may set this; `partforge lint` enforces it
   * (`animation-autoplay-invalid`). Not armed when the browser reports
   * `prefers-reduced-motion: reduce`.
   */
  autoplay?: boolean;
}

/**
 * An animation is EITHER single-phase (`tracks` and/or `opacity`, plus a
 * `duration`) OR stepped (`steps`) — never both, never neither. `partforge
 * lint` enforces that (`animation-tracks-or-steps`), and the union says the
 * same thing, so a block carrying both is rejected before it ever reaches lint.
 * The first two arms are the two ways to satisfy "at least one of
 * `tracks`/`opacity`".
 */
export type AnimationSpec =
  | (AnimationSpecCommon & {
      /** Seconds — the whole animation's duration in the single-phase form. */
      duration: number;
      /** Param key -> keyframes. */
      tracks: Record<string, Keyframes>;
      /** Sub-part name -> opacity keyframes (see AnimationStep.opacity). */
      opacity?: Record<string, Keyframes>;
      steps?: never;
    })
  | (AnimationSpecCommon & {
      duration: number;
      tracks?: Record<string, Keyframes>;
      /** An opacity-only animation is legal — a pure fade. */
      opacity: Record<string, Keyframes>;
      steps?: never;
    })
  | (AnimationSpecCommon & {
      /** The multi-step form; each step carries its own relative `duration`. */
      steps: AnimationStep[];
      tracks?: never;
      opacity?: never;
      duration?: never;
    });

// --- the part itself --------------------------------------------------------

/**
 * A parametric part: plain data plus pure functions, default-exported from a
 * DOM-free, side-effect-free module. `build` must be a pure function of
 * `(k, p, d)` — the preview kernel memoizes geometry by content hash.
 *
 * @typeParam P - the resolved params shape; defaults to an open record.
 * @typeParam D - the derived-values shape; defaults to an open record.
 */
export interface PartDefinition<P = ResolvedParams, D = Derived> {
  meta: PartMeta;
  /** The control-panel schema: an array of sections. */
  parameters: ParameterSection[];
  /** Flat starting values — seeds `params` and every control. */
  defaults: Defaults;
  /** Outline fonts a part's `k.text2d()` calls need, as `{ name: source }`. */
  fonts?: Record<string, FontSource>;
  /**
   * Depth-map images a part's `k.heightfield()` calls need, as
   * `{ name: source }` — or a function of the resolved params returning that
   * map, which is what lets a `type: "image"` control drive the source.
   */
  images?: Record<string, ImageSource> | ((p: P) => Record<string, ImageSource>);
  /** STEP/STL/3MF files a part's `k.import()` calls need, as `{ name: source }`. */
  imports?: Record<string, ImportSource>;
  /** Vector artwork a part's `k.vector2d()` calls place, as `{ name: source }`. */
  vectors?: Record<string, VectorSource>;
  /** Dependent values computed once per build. */
  derive?: DeriveSpec<P, D>;
  /** Named sub-parts; each builds exactly one solid. */
  parts: Record<string, SubPartDefinition<P, D>>;
  /** The view tabs. A view is a set of sub-parts, and owns its own `animations`. */
  views: Record<string, ViewDefinition>;
  /** Self-verification, co-located with the schema. */
  verify?: VerifyBlock<P, D>;
  /**
   * Named measurements reported by `measure`/`inspect` — never rendered, never
   * exported. Each entry returns either a solid to measure or plain JSON.
   */
  probes?: Record<string, (k: GeometryKernel, p: P, d: D) => unknown>;
  /**
   * Draggable inverse-kinematics points over a posed limb returned by `derive`
   * (`limb(...).pose(...)` from `partforge/kinematics`). Parameters named here must be
   * numeric keys of `defaults`.
   */
  handles?: Record<string, Handle>;
}

/** A draggable IK point. `goal` drags a point on the limb; `angles` drags joint values directly. */
export type Handle = GoalHandle | AnglesHandle;
export interface GoalHandle {
  /** Key of the posed limb in `derive`'s output. */
  limb: string;
  /** A joint name, or "tip" (the default). */
  at?: string;
  mode: "goal";
  params: {
    /** The three parameters (x, y, z) the handle writes. */
    position: [string, string, string];
    /** Optional aim: two parameters (angles) or three (a direction). */
    aim?: [string, string] | [string, string, string];
  };
  /** Parameters used to seed the solve. */
  seed?: string[];
}
export interface AnglesHandle {
  limb: string;
  mode: "angles";
  /** The joint-value parameters this handle drags. */
  params: string[];
  /** A parameter name; while truthy, this handle's own parameters stay out of a drag solve. */
  lock?: string;
}
