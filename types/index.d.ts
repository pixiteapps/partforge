// partforge — the app entry (DOM).
//
// This entry pulls in the three.js viewer and the control panel, so it must NOT
// be imported from a part's build functions; those run in a Web Worker and take
// their geometry helpers from "partforge/geometry".

import type { BackendName } from "./kernel.js";
import type { CanonicalView, ParamValue, PartDefinition } from "./part.js";

export * from "./kernel.js";
export * from "./part.js";

/** Which pane a narrow layout shows. `null` hands selection back to partforge. */
export type HostPane = "stage" | "rail" | null;

/**
 * Where a HOST wants the controls rail: docked into a bottom sheet the host
 * draws over the frame (`inset` = the sheet's full height, so the stage clears
 * it; `railHeight` = the bottom slice of that region the rail renders into,
 * under the host's own chrome strip), or floated as a right-edge drawer over a
 * full-width stage. `null` hands the layout back to partforge.
 */
export type HostRailLayout =
  | { mode: "dock"; inset: number; railHeight?: number }
  | { mode: "overlay" }
  | null;

/** An export file format. STEP is routed to OCCT automatically. */
export type ExportFormat = "stl" | "step" | "3mf";

/**
 * A semantic click result: which sub-part was hit, where (in the sub-part's own
 * local frame, quantized to 0.01 mm), the snapped surface normal, and only the
 * params that sub-part actually reads.
 */
export interface Selection {
  subPart: string;
  point: [number, number, number];
  normal: [number, number, number];
  params: Record<string, ParamValue>;
  /** Present when the hit surface carries a `Solid.label()` name. */
  feature?: { label: string };
  /**
   * Present when the click landed on a cutaway's cut face. The point is inside
   * the material rather than on a surface the part was built with, and the
   * normal faces the half the section removed.
   */
  onCutPlane?: true;
}

export interface PickEvent {
  selection: Selection;
  /** The feature label, the sub-part's label, or the sub-part name. */
  label: string;
  /** The selection formatted for an LLM prompt. */
  prompt: string;
  /** The selection formatted as a compact token. */
  token: string;
  /** Where the pick's marker sits on the canvas, in CSS px from its top-left. */
  anchor: { x: number; y: number };
}

/** Fired once per completed build. NOT fired for a pose-only edit. */
export type BuildEvent =
  | { status: "success"; ms?: number }
  | { status: "error"; error: string };

/** The bytes of a finished export, when the host supplies its own download sink. */
export interface DownloadPayload {
  data: ArrayBuffer | Uint8Array;
  filename: string;
  mime: string;
}

/**
 * Element references. Every entry falls back to the legacy global-ID lookup
 * (`#app`, `#controls`, `#panel`, `#part`, `#download*`, `#status`/`#busy`/
 * `#phase`, `#reframe`/`#theme`/`#cutaway`/`#rail-toggle`), resolved
 * exactly once at mount.
 */
export interface MountElements {
  /** The viewer canvas host (`#app`). */
  viewer?: HTMLElement | null;
  /** The control panel host (`#controls`). */
  controls?: HTMLElement | null;
  /** The full-height controls rail (`#panel`). */
  rail?: HTMLElement | null;
  /**
   * The positioned `.pf-shell` ancestor. Only needed when the rail is not a
   * direct child of it — the resize seam is positioned against
   * `rail.parentElement` otherwise.
   */
  shell?: HTMLElement | null;
  status?: {
    status?: HTMLElement | null;
    busy?: HTMLElement | null;
    phase?: HTMLElement | null;
  };
  /** The view-tab bar (`#part`); leave the element empty, `mount` fills it. */
  tabs?: HTMLElement | null;
  exports?: {
    stl?: HTMLElement | null;
    step?: HTMLElement | null;
    threeMf?: HTMLElement | null;
  };
  chrome?: {
    reframe?: HTMLElement | null;
    theme?: HTMLElement | null;
    cutaway?: HTMLElement | null;
    measure?: HTMLElement | null;
    annotate?: HTMLElement | null;
    railToggle?: HTMLElement | null;
  };
}

/** Which control family a dropped file belongs to. */
export type AssetKind = "image" | "vector" | "font";

/** One selectable face in a `FontCatalog` family. */
export interface FontVariant {
  variant: string;
  label: string;
  /** What the picker writes into `params`. */
  url: string;
  bytes?: number;
}

export interface FontFamily {
  id: string;
  family: string;
  category?: string;
  variants: FontVariant[];
  /** A name-only subset used to draw the list row. */
  menuUrl?: string;
}

/** Backs `type: "font"` controls. Supplied by the host; partforge ships none. */
export interface FontCatalog {
  search: (query: string, opts: { limit?: number }) => Promise<FontFamily[]>;
  /** Reverse lookup, so a hashed-filename URL can still be named in the UI. */
  describe?: (source: string) => { family: string; variant: string } | null;
}

export interface ImageAsset {
  id: string;
  label: string;
  /** What the picker writes into `params`. */
  url: string;
  width?: number;
  height?: number;
  thumbUrl?: string;
}

/** Backs `type: "image"` controls. Supplied by the host; partforge ships none. */
export interface ImageCatalog {
  search: (query: string, opts: { limit?: number }) => Promise<ImageAsset[]>;
  describe?: (source: string) => { label: string; width: number; height: number } | null;
}

export interface MountOptions {
  /**
   * Spawns a geometry worker. Called once per backend with `name` as the
   * Worker's `name` option. The `new Worker(new URL(...))` call must stay
   * inline in the app module or Vite will not bundle the worker.
   */
  createWorker: (name: BackendName) => Worker;
  elements?: MountElements;
  onBuild?: (event: BuildEvent) => void;
  /**
   * Programmatic click-to-select. Supplying this arms the picker permanently
   * and takes precedence over the `?pick` and `?pickserver` URL modes.
   */
  onPick?: (event: PickEvent) => void;
  /** Receive exported bytes instead of partforge's own DOM download. */
  onDownload?: (file: DownloadPayload) => void;
  /** The active view (tab) name — emitted once on mount, then on every change. */
  onViewChange?: (view: string) => void;
  /**
   * Receive user annotations (freehand ink over the frozen view). Supplying
   * this reveals the `#annotate` viewbar button; omitting it hides the button
   * entirely.
   */
  onAnnotationSend?: (payload: AnnotationPayload) => void;
  /**
   * Who owns annotation mode's Send affordance. `"viewbar"` (the default) puts
   * Send beside Undo/Clear in the actions row. `"host"` drops it and leaves
   * Undo/Clear: the host draws its own send control — e.g. a composer pairing
   * the sketch with a typed message — and calls `runtime.annotate.send()`.
   */
  annotateSend?: "viewbar" | "host";
  /**
   * A previous mount's `runtime.getViewerState()`, handed back so this mount
   * resumes the camera, projection, cutaway, render mode, chosen environment
   * and per-style feature lines where that one left them (the last three
   * outrank what is stored). For a
   * host that applies edits by REMOUNTING: the part changed, the user's view of
   * it should not.
   *
   * Omit on a first mount — the viewer then restores its own persisted camera,
   * in perspective (the projection is automatic, so it is not persisted).
   * Restore is best-effort per field: a pose this part cannot support is
   * dropped, never fatal.
   */
  viewerState?: ViewerState | null;
  /**
   * A previous mount's `runtime.getPanelState()`: the transient state of the
   * part's custom controls (a selected tile), keyed by param. Same remount
   * story as `viewerState`; omit on a first mount. Never persisted by partforge.
   */
  panelState?: PanelState | null;
  /**
   * The part's own source tree as text, for custom controls' `host.file(path)`.
   * Omit and `host.file` answers null.
   */
  files?: Record<string, string>;
  /**
   * A provider backing every `type: "font"` control in the part. partforge
   * ships none — without one, a font control renders as a plain URL field.
   */
  fontCatalog?: FontCatalog;
  /**
   * A provider backing every `type: "image"` control in the part. Without one,
   * an image control degrades to a plain URL field.
   */
  imageCatalog?: ImageCatalog;
  /**
   * The upload hook for the drop target shared by the `"image"`, `"vector"`
   * and `"font"` controls. Called with the CONVERTED artifact — a PNG, a
   * partforge-vector document serialized as JSON, or the original file for a
   * font — never the user's raw drop, and must resolve to a non-empty source
   * string (an `https:` URL, or a host-defined `pfc-asset:` token) which is
   * written into the param. Anything else, or a rejection, is reported through
   * the control's own error line and never written. Omit it and the converted
   * artifact lands in the param directly — the path a host that cannot fetch
   * URLs needs, not a degraded fallback.
   */
  onAssetUpload?: (blob: Blob, info: { kind: AssetKind; filename: string }) => Promise<string>;
  /** @deprecated alias for `elements.viewer`. */
  container?: HTMLElement | null;
  /** @deprecated alias for `elements.controls`. */
  controls?: HTMLElement | null;
}

/** A cut plane, as `ViewerState` carries it across a remount. */
export interface CutawayState {
  /** Whether the cutaway was on. `false` means there is nothing to restore. */
  enabled: boolean;
  /** Which half the plane keeps. */
  flipped: boolean;
  /**
   * The plane's world pose: `position` as `[x, y, z]`, `quaternion` as
   * `[x, y, z, w]`. `null` while disabled. The plane's on-screen SIZE is
   * deliberately absent — it follows the part's bounds, and the part is what
   * changed, so a restore re-derives it from the geometry it lands on.
   */
  pose: { position: [number, number, number]; quaternion: [number, number, number, number] } | null;
}

/**
 * Everything about the current view that a remount would otherwise lose. Plain
 * JSON: it outlives the mount that produced it, so nothing in it points into a
 * disposed scene, and a host may store or post it rather than only handing it
 * straight back. Read it with `runtime.getViewerState()`; hand it back as
 * `MountOptions.viewerState`.
 */
export interface ViewerState {
  /** The live camera pose, or `null` when the viewer could not report one. */
  camera: { pos: [number, number, number]; target: [number, number, number] } | null;
  /**
   * The live projection. It is AUTOMATIC — orthographic only on a view cube
   * face view (Fusion 360's "Perspective with Ortho Faces"), left by the first
   * rotation — so `"orthographic"` is restored only when `camera` is itself a
   * face view (looking straight down a world axis); carried with any other
   * camera, or none, the remount comes back in perspective.
   */
  projection: "perspective" | "orthographic";
  cutaway: CutawayState | null;
  /** Always reported by `getViewerState()` — the mode being headed for, so a realistic switch still loading reads `"realistic"` (a failed one settles to `"cad"`). Optional on the way back in (a state saved by an older partforge has none). */
  renderMode?: RenderMode;
  /** The realistic environment id, present only when one was CHOSEN (`environment.set`, the picker) — a merely seeded default is left out so the part's own `meta.environment` still applies on remount. An unknown id falls back to `"studio"`. */
  environment?: string;
}

/** The viewer's appearance: the drafting view, or physical materials under an environment. */
export type RenderMode = "cad" | "realistic";

/** What `renderMode.onChange` listeners receive. `busy` while realistic's assets load; `error` when they failed. */
export interface RenderModeEvent {
  mode: RenderMode;
  busy: boolean;
  error: string | null;
}

/** Custom controls' transient state, keyed by the param each control owns. Plain JSON. */
export type PanelState = Record<string, Record<string, unknown>>;

export interface PanelError {
  /** The param the failing control owns. */
  key: string;
  label: string;
  phase: "create" | "update" | "event" | "dispose" | "state";
  message: string;
}

/** What a `type: "custom"` control's `widget(host)` receives. */
export interface CustomControlHost {
  /** The slot to draw into, inside the rail. */
  el: HTMLElement;
  doc: Document;
  /** The param this control owns. */
  key: string;
  /** A structured clone of the current value of `key` (default: the owned key). */
  get(key?: string): unknown;
  /**
   * Replace a value. Refused (throws TypeError) for a key the control does not
   * own or a value outside the contract (owned key: a JSON value; `keys`: a
   * scalar). Stores a clone, schedules a rebuild, and commits unless
   * `commit: false` — then call `commit()` when the gesture ends.
   */
  set(value: unknown, opts?: { key?: string; commit?: boolean }): void;
  commit(keys?: string[]): void;
  /** The latest `derive()` output. */
  derived: Record<string, unknown>;
  /** Transient JSON state that survives a remount; never a param. */
  state: Record<string, unknown>;
  setState(patch: Record<string, unknown>): void;
  /** Mount built-in controls bound at `path` inside the owned value. Returns a disposer. */
  controls(container: HTMLElement, controls: import("./part.js").PanelEntry[], opts?: { path?: string }): () => void;
  /** Element builder; SVG tags get the SVG namespace, `on*` attrs become listeners. */
  h(tag: string, attrs?: Record<string, unknown>, ...children: unknown[]): Element;
  /** Parse an SVG string to its root element, or null. */
  svg(text: string): SVGSVGElement | null;
  /** Render a partforge-vector document to an inline `<svg>`, or null. */
  svgFromVector(doc: unknown): SVGSVGElement | null;
  /** Text of one of the part's own files, by path or `pfc-tree://` token, or null. */
  file(pathOrToken: string): string | null;
  readonly disabled: boolean;
}

export interface CustomControlInstance {
  update?(ctx: { reason: "sync" | "derived" | "restore"; disabled: boolean }): void;
  dispose?(): void;
}

export interface ExportPartsOptions {
  /** Sub-part names, as `listExportableParts()` reports them. */
  parts: string[];
  format: ExportFormat;
  /** Mesh quality for STL/3MF. Defaults to `"print"`. */
  quality?: "preview" | "print";
  onProgress?: (phase: string) => void;
}

export interface CaptureCurrentOptions {
  /** Long-edge resolution in px, clamped into `[256, maxTextureSize]`. */
  size?: number;
  /** Keep the floor grid so the capture matches the on-screen look. */
  hideGrid?: boolean;
  /** JPEG quality, 0..1. */
  quality?: number;
  /**
   * Centre the visible geometry: render the largest centred sub-window of the
   * current framing that still holds every visible vertex (equal margins, full
   * `size` resolution). When the geometry runs past a frame edge — the user
   * zoomed in on purpose — or dimensions are pinned, the framing is kept as-is.
   * Default false.
   */
  recenter?: boolean;
  /**
   * The look to capture in. Omitted: whatever the live view shows. `"cad"`
   * always renders CAD. `"realistic"` from a CAD view renders realistic only
   * once the current environment's assets have loaded (this call is
   * synchronous and cannot wait); before that it falls back to the live look —
   * `renderViews` is the async path that guarantees realistic.
   */
  renderMode?: RenderMode;
}

export interface CaptureViewOptions {
  /** Square render resolution in px. Default 640. */
  size?: number;
  /** JPEG quality, 0..1. Default 0.8. */
  quality?: number;
  /** Canonical angle to render from. Default `"iso"`. */
  angle?: CanonicalView | string;
}

/**
 * Measurement mode runtime controls. Dimensioned captures come straight from
 * `captureCurrent()` while the mode is enabled — in-scene dims render into
 * the frame natively (canonical-view captures and thumbnails never include
 * them).
 */
export interface MeasureRuntime {
  isEnabled(): boolean;
  setEnabled(on: boolean): void;
  clearPins(): void;
  pinCount(): number;
}

/** One freehand stroke: points normalized 0..1 in viewport space; width as a
 *  fraction of the viewport's short edge. */
export interface AnnotationStroke {
  points: [number, number][];
  width: number;
}

/** A raycast sample grounding a stroke in the model. `t` anchors sit at the
 *  stroke's start/mid/end by arc length; `kind: "centroid"` anchors sit at the
 *  enclosed-region centroid of a closed stroke. `hit` is null when the sample
 *  ray missed all geometry — a deliberate signal, not an error. */
export interface AnnotationAnchor {
  stroke: number;
  t?: number;
  kind?: "centroid";
  screen: [number, number];
  hit: { subPart: string; pointLocal: [number, number, number] } | null;
}

/** A camera pose. `world` replays exactly against the annotated build; `parts`
 *  is the same pose in the shared CAD frame (survives per-view recentring when
 *  the model is rebuilt), or null when no meshes were live. */
export interface AnnotationCamera {
  world: { pos: number[]; target: number[]; up: number[]; fov: number };
  parts: { pos: number[]; target: number[]; up: number[]; fov: number } | null;
}

/** What onAnnotationSend receives. The drawing and the 3D render are separate
 *  images over the same framing, so a host can composite them now and
 *  re-render the model from the same camera against later updates. */
export interface AnnotationPayload {
  version: 1;
  strokes: AnnotationStroke[];
  anchors: AnnotationAnchor[];
  /** Two base64 data URLs. On a large hi-DPI stage the drawing PNG alone can
   *  run several MB of base64 — hosts should not assume this payload is small. */
  images: { drawing: string; model: string };
  camera: AnnotationCamera;
  viewport: { width: number; height: number; dpr: number };
  context: { view: string; params: Record<string, unknown> };
}

export interface AnnotateRuntime {
  isEnabled(): boolean;
  setEnabled(on: boolean): void;
  /** Drop the most recent stroke. */
  undo(): void;
  clear(): void;
  strokeCount(): number;
  /**
   * Assemble the payload and hand it to `onAnnotationSend`, then exit the mode
   * and discard the ink. Returns false — delivering nothing and keeping the ink
   * — when the mode is off, the canvas is empty, or the render failed.
   */
  send(): boolean;
  /** Every stroke, undo and clear. Returns an unsubscribe. */
  onInkChange(cb: () => void): () => void;
  onModeChange(cb: () => void): () => void;
}

/**
 * The yellow marker a pick flashes, as a thing with a lifetime — for a host
 * that hangs its own UI (a chat bubble, a callout) off the dot. A marker fades
 * on its own about a second after the pick, so `hold()` belongs in the `onPick`
 * handler, not behind a later user action.
 */
export interface PickMarkerRuntime {
  /** Keep the newest marker on screen; false when there is none. Earlier held markers stay held. */
  hold(): boolean;
  /** Clear every held marker. */
  release(): void;
  /**
   * Where the newest held marker is, as the camera moves; null when nothing is
   * held. Fires immediately with the current state. Returns an unsubscribe.
   */
  onAnchorChange(cb: (anchor: { x: number; y: number; visible: boolean } | null) => void): () => void;
}

/** Where playback is: idle, swinging the camera to an intro cue, playing, or paused. */
export type AnimationStatus = "idle" | "intro" | "playing" | "paused";

export interface AnimationState {
  /** The active view (tab) name — animations belong to a view. */
  view: string;
  /**
   * The selected animation's key, or `null` while the active view declares no
   * animations. Switching views re-selects that view's first animation.
   */
  animation: string | null;
  status: AnimationStatus;
  /** Position on the timeline, 0..1 over the animation's total duration. */
  t: number;
  /** Which step `t` falls in; 0 for a single-step animation. */
  stepIndex: number;
}

/**
 * Part-declared animation playback — the same engine the viewer's transport bar
 * drives. Playback writes real params, so exporting while paused exports the
 * posed state, and any user or host param edit pauses it. An animation's
 * `opacity` tracks are the exception: display-only, never written to params and
 * never visible to export.
 */
export interface AnimationRuntime {
  /**
   * Play, optionally switching to a named animation first. The name resolves
   * within the ACTIVE view — an animation declared by another view is not
   * playable from here. An unknown name warns and does nothing rather than
   * playing whatever is selected.
   */
  play(name?: string): void;
  pause(): void;
  /** Jump to a position on the timeline, 0..1. Never moves the camera. */
  seek(t: number): void;
  /** Stop and restore the param values the animation started from. */
  stop(): void;
  state(): AnimationState;
}

/** The runtime handle `mount()` returns. See `makeHandle` in src/framework/mount.js. */
export interface PartRuntime {
  /** Resolves on the first successful build of the default view; rejects on a first-build error. */
  ready: Promise<void>;
  /** Full teardown of everything this mount created. Idempotent. */
  dispose(): void;
  /**
   * Programmatic param entry point (the animation hook). Same change path as a
   * slider edit: pose-only changes repair synchronously, geometry changes fall
   * through to the regen loop.
   */
  setParams(partial: Record<string, ParamValue>): void;
  /**
   * Canonical-angle captures (fixed poses, framed to the visible assembly,
   * 1024², grid hidden) — sized for feeding a vision model. Defaults to
   * `["iso", "front", "top"]`; unknown names are dropped. Always the CAD look,
   * whatever the live render mode — `renderViews` asks for realistic.
   */
  captureViews(viewNames?: CanonicalView[] | string[]): Array<{ view: string; dataUrl: string }>;
  /**
   * One offscreen render of the user's CURRENT framing at a chosen resolution —
   * the showcase capture. Returns a `data:image/jpeg;base64,…` string, or `null`
   * when disposed or nothing is built yet. Never throws. Follows the live
   * render mode unless `opts.renderMode` pins one.
   */
  captureCurrent(opts?: CaptureCurrentOptions): string | null;
  /** The active view (tab) name. Never null once mounted. */
  getView(): string;
  /** Switch the active view; `false` if the part declares no such view. Persists per part for the session. */
  setView(name: string): boolean;
  /**
   * Render a named view OFFSCREEN → a `data:image/jpeg;base64,…` string, or `null` on
   * failure (a build error, a view with no sub-parts, or a disposed runtime). Omit
   * `viewName` — or pass an unknown one — to render the part's DEFAULT view. Never
   * disturbs the active tab, the live camera, or the on-screen scene.
   */
  captureView(viewName?: string, opts?: CaptureViewOptions): Promise<string | null>;
  /**
   * Park/unpark the viewer: stops the render loop and releases the drawing
   * buffer and cached capture target. For a host that hides the canvas without
   * unmounting it. Captures still work while parked. Safe after `dispose()`.
   */
  setActive(active: boolean): void;
  /**
   * Snapshot the camera, projection, cutaway, render mode and environment so a REMOUNT can resume them —
   * pass the result as the next `mount()`'s `viewerState`. Read at teardown
   * time, so it is the live pose, unlike the camera the viewer persists for a
   * page reload (which only records the end of an orbit drag, and so misses a
   * view-cube click, Reframe, or an animation cue).
   */
  getViewerState(): ViewerState;
  /** Every custom control's non-empty transient state, keyed by param. Hand back as `panelState`. */
  getPanelState(): PanelState;
  /** What custom controls reported failing this mount, in order. */
  getPanelErrors(): PanelError[];
  /**
   * Subscribe to WebGL context loss — i.e. the GPU or the OS gave up — so a host
   * can say so rather than showing a dead canvas. The listener takes no
   * arguments (the underlying event is consumed and `preventDefault`ed).
   * Returns an unsubscribe.
   */
  onContextLost(listener: () => void): () => void;
  /**
   * Every exportable sub-part — excludes any `exportable: false` part, respects
   * each part's `enabled(params)` — INDEPENDENT of the active view.
   */
  listExportableParts(): Array<{ name: string; label: string }>;
  /**
   * Headless export of a chosen subset. Resolves once the file is written
   * (handed to your `onDownload` sink, or downloaded directly); rejects on
   * build/export failure or an empty selection.
   */
  exportParts(opts: ExportPartsOptions): Promise<void>;
  /**
   * Pay the exact kernel's cold boot ahead of an export. STEP is pinned to
   * OCCT, whose ~11 MB WASM loads on its first job, so a Manifold-previewed
   * part's STEP export otherwise pays that boot inside the export itself.
   * Call this when an export becomes likely — a download dialog opening — to
   * move the wait off the moment the user asked for a file.
   *
   * Best-effort: resolves `true` once the kernel is up, `false` on any failure
   * or teardown, and never rejects. A no-op once the kernel is warm.
   */
  warmExportKernel(): Promise<boolean>;
  /**
   * Narrow-layout pane selection, for a host that draws its own tab bar.
   * `null` hands selection back to partforge's built-in bar.
   */
  setHostPane(pane: HostPane): void;
  /**
   * Where the rail sits, for a host that draws its own chrome over the frame:
   * docked into the host's bottom sheet (`inset` is the sheet's full height,
   * `railHeight` the part of it the rail may paint into), or floated as a
   * right-edge drawer over an unresized stage. `null` — or any shape partforge
   * cannot read — restores partforge's own layout.
   */
  setRailLayout(layout: HostRailLayout): void;
  /**
   * Part-declared animation playback, or `null` when NO view declares an
   * `animations` block. Non-null while any view does — including while the
   * active view has none, where `state().animation` reads `null`.
   */
  animation: AnimationRuntime | null;
  /** Measurement mode's runtime-controls API — mode on/off, unit, and pin state; dimensioned captures come from `captureCurrent()` while enabled. Always present (a no-op stand-in outside `makeHandle` tests). */
  measure: MeasureRuntime;
  /** Annotation mode's runtime-controls API — mode on/off, ink state, and send. Always present; a no-op stand-in when `onAnnotationSend` was not supplied. */
  annotate: AnnotateRuntime;
  /** The pick marker's lifetime — hold it on screen and follow it across the canvas. Always present (a no-op stand-in outside `makeHandle` tests). */
  pickMarker: PickMarkerRuntime;
  /** Realistic render mode (docs "Materials and appearance"). set() resolves to the mode actually in effect — "cad" if assets failed to load. */
  renderMode: {
    get(): RenderMode;
    set(mode: RenderMode): Promise<RenderMode>;
    onChange(cb: (e: RenderModeEvent) => void): () => void;
  };
  /** The realistic environment. set() resolves to the id in effect — a failed switch while realistic reverts, and onChange hears the revert. */
  environment: {
    get(): string;
    set(id: string): Promise<string>;
    onChange(cb: (id: string) => void): () => void;
    list(): Array<{ id: string; label: string }>;
  };
  /** True when any sub-part names a display.material. */
  declaresMaterials: boolean;
  /** Canonical-view renders in a chosen appearance, without switching the live view; "cad" (the default) is exactly captureViews(), CAD in either live mode. */
  renderViews(viewNames?: CanonicalView[] | string[], opts?: { renderMode?: RenderMode }): Promise<Array<{ view: string; dataUrl: string }>>;
}

/** Mount a full parametric-part app from a `PartDefinition`. */
export function mount(part: PartDefinition, options: MountOptions): PartRuntime;

/**
 * The sub-parts a view shows: declared in the view and `enabled` for these
 * params, in `Object.keys(part.parts)` order. Handy for app-side view logic.
 */
export function viewSubParts(
  part: PartDefinition,
  view: string,
  params: Record<string, ParamValue>,
): string[];

