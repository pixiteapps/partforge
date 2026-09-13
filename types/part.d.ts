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

import type { BackendName, GeometryKernel, Solid } from "./kernel.js";

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
  /** Pin a backend instead of letting the probe route the part. */
  backend?: BackendName;
}

// --- the parameter schema ---------------------------------------------------

/** Which input a control renders as. Omit for a slider + number box. */
export type ControlKind = "slider" | "number" | "text" | "textarea";

/** Every control type the panel can render. */
export type ControlType = "slider" | "number" | "text" | "textarea" | "checkbox" | "select" | "radio";

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
   * Optional reposition (default identity), for a part whose display pose
   * differs from its export pose. Any such difference must be a RIGID motion.
   */
  place?: (solid: Solid, ctx: PlaceContext<P, D>) => Solid;
  /** Which views show this sub-part. Every name must exist in `views`. */
  views: string[];
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
  /** Viewer-only override — `color` is `0xRRGGBB`, `opacity` is 0..1. */
  display?: { color?: number; opacity?: number };
  /** Filename / object name on export; defaults to the key. */
  export?: { name: string };
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
   * vertical (45 on the FDM profiles; absent on resin). Checked only for a part
   * that also declares `verify.orientation: "print"`; `null` switches it off
   * under a named base. A warning, never a gate.
   */
  overhang?: number | null;
  /** Carried for a future gap check; not enforced yet. */
  clearance?: number;
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
  boundsMin?: Expectation;
  boundsMax?: Expectation;
  minWall?: Expectation;
  /**
   * Unsupported downward-facing surface in mm² (faces steeper than the profile's
   * `overhang` angle, bed at the sub-part's own lowest Z). Measured only under
   * `verify.orientation: "print"`; a warning, never a gate.
   */
  overhangArea?: Expectation;
  /** Symmetric-difference volume vs. the sub-part's declared `reference` import. */
  refXorVolume?: Expectation;
  /** Percent volume delta vs. the sub-part's declared `reference` import. */
  refVolumeDeltaPct?: Expectation;
  /** Bounding-box corner drift `[dx, dy, dz]` vs. the sub-part's declared `reference` import. */
  refBboxDelta?: Expectation;
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
  boundsMin?: Expectation;
  boundsMax?: Expectation;
  /** Pairs that must touch, as `[["a", "b"], …]`. */
  contacts?: Array<[string, string]>;
  /** Intended free fits, keyed `"a×b"` (order-insensitive). */
  clearance?: Record<string, Expectation>;
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
   * `"print"` declares the part is laid out for its bed — Z up, each sub-part's
   * bed at its own lowest Z — which is the only way the profile's `overhang`
   * check is armed. Omit it while a part is still being shaped or is bound for
   * another process.
   */
  orientation?: "print";
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
 * A camera cue angle. `partforge lint` rejects anything outside the canonical
 * seven (`animation-camera-invalid`), so the type says so too. Cues fire during
 * play only; scrubbing never moves the camera.
 */
export type CameraCue = CanonicalView;

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
  /** Swing the camera to this angle when the step begins. */
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
   * `[[t, angle], …]` cue list, or per-step `camera` names.
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
}
