// partforge — the app entry (DOM).
//
// This entry pulls in the three.js viewer and the control panel, so it must NOT
// be imported from a part's build functions; those run in a Web Worker and take
// their geometry helpers from "partforge/geometry".

import type { BackendName } from "./kernel.js";
import type { CameraOrbit, CanonicalView, ParamValue, PartDefinition } from "./part.js";

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

/** An export file format. STEP is routed to OCCT automatically; `"bundle"` is the cut & print kit (a ZIP). */
export type ExportFormat = "stl" | "step" | "3mf" | "bundle";

/** One entry of `runtime.listExportFormats()` / `EXPORT_FORMATS`. `needsSheet` marks a format that needs a sheet part checked. */
export interface ExportFormatInfo {
  id: ExportFormat;
  label: string;
  ext: string;
  mime: string;
  needsSheet: boolean;
}

/** A sheet part's stock, as `listExportableParts()` reports it. `group` is the kit's stock-group key, e.g. `"birch plywood|3.00"`. */
export interface ExportableSheetInfo {
  process: string;
  material: string;
  thickness: number;
  group: string;
}

/**
 * The cut & print kit's download options — `exportParts({ format: "bundle", options })`.
 * Every key is optional; `validateKitOptions` fills the defaults and throws an error
 * starting `"cut kit options:"` for anything it cannot honour.
 */
export interface KitOptions {
  /** `"own-laser"` (default): SVG, laid out on sheets. `"service"`: DXF, one cut-only file per piece. `"cnc-router"`: DXF, one layered file per routed piece; kerf must be 0. */
  destination?: "own-laser" | "service" | "cnc-router";
  /** Derived from `destination`; when given it must match. */
  cutFormat?: "svg" | "dxf";
  /** mm, 0–0.5: the cut lines move out by half of it. Default 0 (nominal geometry). */
  kerf?: number;
  colors?: "lightburn";
  /** Sheet size in mm per stock group; `"*"` is an explicit default. `null` (default) is 300 × 300 mm for every group. */
  stock?: Array<{ group: string; size: [number, number] }> | null;
  /** mm, 0–50. Default 5. */
  margin?: number;
  /** mm, 1–50. Default 3. */
  spacing?: number;
  printFormat?: "stl" | "3mf";
  /** Whole number, 1–20. Default 1. */
  sets?: number;
  /** Which way a two-sided board is turned over between sides — the axis far-side layers are mirrored about. Default `"left-right"`. */
  flip?: "left-right" | "end-over-end";
  /** Two-sided pieces: one layered file per piece (`"one-file"`, default), or a near file plus a `-far` file (`"two-files"`). */
  twoSided?: "one-file" | "two-files";
}

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
  /** Opt in to the selection popover (requires `onPick`): a pick opens a popover at the spot with the sub-part's appearance controls, and with `slot: true` an empty region the host floats its own UI over (`runtime.selection`). */
  selectionPopover?: { slot: boolean };
  /**
   * Bound, in MB, on the geometry worker's solid cache — the built solids it keeps so
   * an edit rebuilds only what changed. Unbounded by default. Past the bound the least
   * recently built sub-parts' solids are freed and those sub-parts rebuild cold on the
   * next edit. Pass a small bound on phones: a very large view's cache can hold
   * gigabytes, more than a mobile browser tab is allowed.
   */
  cacheBudgetMB?: number;
  /**
   * Show a view filling in as its sub-parts finish, instead of all at once when the
   * last one does — the difference on a forge of dozens of heavy pieces is the whole
   * build time. Off by default. When on, the geometry worker also posts
   * `{ type: "meshes-partial", meshes }` batches during a build and the final
   * `{ type: "meshes" }` carries only the sub-parts no batch did: a host that reads
   * worker replies itself must add the batches up.
   */
  progressiveBuild?: boolean;
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
   * A cached preview GLB (from `partforge/gltf`'s `encodePreviewGlb`, or a previous
   * runtime's `exportPreview()`) drawn before the worker is ready and replaced in
   * place, sub-part by sub-part, by the first live build — the camera is kept.
   * Only a file for the view the viewer opens on is drawn, and only meshes named
   * for that view's sub-parts; a file for another view, or one that will not
   * decode, is logged once and ignored. A file written without a view (no `view`
   * given to `encodePreviewGlb`) is drawn on sub-part name match alone, for any view.
   * Carries no edge lines.
   */
  preview?: Uint8Array | ArrayBuffer | null;
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
  /** The open selection popover, reopened by the next mount if the sub-part is still in the view. */
  selection?: { subPart: string | null; point: [number, number, number]; page: "spot" | "appearance" };
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
  /** Mesh quality for STL/3MF (and a kit's printed parts). Defaults to `"print"`. */
  quality?: "preview" | "print";
  onProgress?: (phase: string) => void;
  /** The cut & print kit's download options (`format: "bundle"`; the other formats ignore them). */
  options?: KitOptions;
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
  /** Render width in px (the long edge). The style's aspect sets the height: `"thumbnail"` is 4:3 (640 → 640×480), `"cad"` is square. Default 640. */
  size?: number;
  /** JPEG quality, 0..1. Default 0.8. */
  quality?: number;
  /** Canonical angle to render from. Default `"iso"`. */
  angle?: CanonicalView | string;
  /** Capture style. `"thumbnail"` (the default) is the light product shot with a contact shadow; `"cad"` is the agent-facing CAD look. */
  style?: "cad" | "thumbnail";
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
 * Where the selection popover's host slot is, or why it has none. `rect` is in
 * CSS px from the top-left of the border box of the stage element
 * (`elements.viewer`), not the canvas. On a stage too short for the requested
 * height the slot is given less, and `rect.height` is what it was given.
 */
export type SelectionSlotReport =
  | { state: "open"; rect: { x: number; y: number; width: number; height: number } }
  | { state: "collapsed" }
  | { state: "closed" };

/**
 * The selection popover's host-facing controls (`runtime.selection`). A carried
 * selection (`viewerState.selection`) has reopened, or not, by the time
 * `runtime.ready` resolves — check `isOpen()` after `ready`, not right after
 * `mount()`. (A failed first build tries again on the first successful one.)
 */
export interface SelectionRuntime {
  /**
   * The height (CSS px, integer, 44–2000) the host's slot content needs. A stage
   * too short for it applies less (never below 44); the request is kept, so a
   * roomier stage restores it.
   */
  setSlotHeight(px: number): void;
  /** Where the slot is, relative to the stage element's border box; fires on every change. Never fires for `slot: false`. */
  onSlotChange(cb: (report: SelectionSlotReport) => void): () => void;
  /**
   * Why partforge closed it. A host's own `close()` does not fire this.
   * `"gone"` also fires when anything releases the pick marker
   * (`runtime.pickMarker.release()` included). Any close releases every held
   * marker, including one the host held itself.
   */
  onClose(cb: (event: { reason: "dismiss" | "hide" | "gone" }) => void): () => void;
  close(): void;
  isOpen(): boolean;
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
  /**
   * The user's current view as an animation camera cue, for "keep the view I
   * have now": write `cue` as a `camera` value and playing it lands on this
   * angle and distance. Cues always aim at the part's centre, so a pan cannot
   * be carried — `panned` says how far the user's orbit target sits from that
   * centre, as a fraction of the framing radius (0 when they never panned).
   * Null with nothing on screen. Safe after `dispose()`.
   */
  getCameraCue(): { cue: CameraOrbit; panned: number } | null;
  /**
   * True while the `preview` GLB is on screen: from the moment it decodes until a
   * build delivers the whole view (a build error leaves it on). Picking, hover
   * labels, measure, sketch and cutaway wait meanwhile; orbit, zoom, pan, the view
   * cube, the view style and the rail work. Read it from the runtime each time —
   * a copy of the handle freezes it.
   */
  readonly previewActive: boolean;
  /**
   * The view on screen as a preview GLB (`partforge/gltf`'s format), every
   * sub-part posed exactly as drawn — what a later `mount({ preview })` shows
   * before its kernel boots. Rejects while `previewActive`, before the view is
   * fully built at the current params (a pending rebuild counts), for a `view`
   * other than the one on screen, and after `dispose()`.
   */
  exportPreview(opts?: { view?: string }): Promise<Uint8Array>;
  /** Every custom control's non-empty transient state, keyed by param. Hand back as `panelState`. */
  getPanelState(): PanelState;
  /** What custom controls reported failing this mount, in order. */
  getPanelErrors(): PanelError[];
  /** The param keys that shape a pick: the clicked sub-part's recorded build reads (else predicted, else all). */
  controlsFor(selection: { subPart: string }): string[];
  /**
   * Subscribe to WebGL context loss — i.e. the GPU or the OS gave up — so a host
   * can say so rather than showing a dead canvas. The listener takes no
   * arguments (the underlying event is consumed and `preventDefault`ed).
   * Returns an unsubscribe.
   */
  onContextLost(listener: () => void): () => void;
  /**
   * Every exportable sub-part — excludes any `exportable: false` part, respects
   * each part's `enabled(params)` — INDEPENDENT of the active view. A sheet
   * part's row adds `sheet`, evaluated at the current params (omitted when that throws).
   */
  listExportableParts(): Array<{ name: string; label: string; sheet?: ExportableSheetInfo }>;
  /** The formats `exportParts` writes in this version — fresh copies of `EXPORT_FORMATS`. */
  listExportFormats(): ExportFormatInfo[];
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
  /** The selection popover, or `null` without the `selectionPopover` option. */
  selection: SelectionRuntime | null;
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

/** Options for `mountPreview`. Any other key throws a `TypeError`. */
export interface MountPreviewOptions {
  /** A GLB from `partforge/gltf`'s `encodePreviewGlb`, or a runtime's `exportPreview()`. */
  glb: Uint8Array | ArrayBuffer;
  /** Optional viewer buttons, wired as `mount()` wires them; `#viewbar` inside the container is found by id. */
  elements?: { chrome?: { reframe?: HTMLElement | null; theme?: HTMLElement | null } };
  /** A previous runtime's `getViewerState()`; `cutaway` is ignored (a preview has no live solid). */
  viewerState?: ViewerState | null;
  /** Play the file's baked animation once drawn (default true). The editor's own boot preview goes through mount(), not here. */
  animate?: boolean;
  /** `false` (0.168.0+): no view cube, `#viewbar` controls, view style, tooltips, play button or `elements.chrome` wiring. Default true. */
  chrome?: boolean;
  /** `"transparent"` (0.168.0+): alpha-0 clear, no theme background, no grid. CAD mode only — realistic mode draws its own environment backdrop. Default `"theme"`. */
  background?: "theme" | "transparent";
  /** `true` (0.168.0+): a soft contact shadow under the part, cast once at showAssembly from the meshes as the file stores them (the rest pose, before a player applies its first pose); a playing animation does not move it. CAD mode only — realistic mode draws its own ground and shadow. Default false. */
  contactShadow?: boolean;
  /** `false` (0.168.0+): no wheel/pinch zoom (a wheel scrolls the page). Default true. */
  zoom?: boolean;
  /** `false` (0.168.0+): no pan. Default true. */
  pan?: boolean;
  /**
   * Degrees per second (0.168.0+; default 0, off): a file with no playing animation
   * turns about the vertical. Never under reduced motion; the first camera grab
   * (a canvas drag or the view cube) stops it until `motion.restart()`.
   */
  turntable?: number;
  /**
   * `false` (0.169.0+; default true): the motion — a playing animation or the
   * turntable — waits at its first frame (the animation's t = 0 pose, turntable
   * angle 0) until `motion.start()`. `drawn` resolves on a frame showing that pose.
   */
  autostart?: boolean;
  /**
   * 0 < fill <= 1 (0.168.0+): the opening framing (and the viewer's reframe) puts the
   * camera, along the opening view direction, so the model's bounding box as projected
   * on screen spans this fraction of the viewport along its limiting axis. With a
   * `turntable` (and no baked animation) the model swept a full turn is framed — its
   * farthest vertex from the vertical axis, over the box's height — so the turn never
   * clips and a round part still fills. With `fill` the model is centred on its
   * horizontal vertex centroid (a lopsided part turns about its hub), and nothing
   * leaves the viewport; a baked animation that moves parts outside the box may. Unset, the
   * fixed framing distance. Since 0.169.0 a turntable mount is framed swept under reduced
   * motion too, so every visitor sees the same framing.
   */
  fill?: number;
  /** `"default"` (0.168.0+): drop the camera and projection of `viewerState` and `setViewerState`, so the mount keeps the file's own framing; their render mode and environment still apply. Default `"carry"`. */
  camera?: "carry" | "default";
  /** The opening render mode (0.168.0+): applied at mount, over any carried render mode; afterwards `setViewerState`, `renderMode.set` and the view style control change it as usual. Unset, the carried state decides. */
  renderMode?: RenderMode;
}

/** The handle `mountPreview()` returns. Every method is safe before `ready` settles. */
export interface PreviewRuntime {
  /** Resolves once the GLB is drawn; rejects when it will not decode or holds no meshes. */
  ready: Promise<void>;
  /**
   * Resolves after the first frame that includes the meshes has rendered (0.168.0+) —
   * for cross-fading from a still image. Rejects with `ready`'s error when the file
   * will not decode, or when the handle is disposed first. Waits while parked.
   */
  drawn: Promise<void>;
  /** Full teardown. Idempotent. */
  dispose(): void;
  /** The view the file was written for (`null` until drawn, or when the file names none). */
  getView(): string | null;
  /** Camera, projection, render mode and environment; `cutaway` is always `null`. */
  getViewerState(): ViewerState;
  /** Apply a state (camera, projection, render mode, environment) now, or once drawn. */
  setViewerState(state: ViewerState | null): void;
  /** Park/unpark the viewer, as `PartRuntime.setActive`. */
  setActive(active: boolean): void;
  /** WebGL context loss. Returns an unsubscribe. */
  onContextLost(listener: () => void): () => void;
  /** Accepted and ignored — there is no rail. */
  setHostPane(pane: HostPane): void;
  /** Accepted and ignored — there is no rail. */
  setRailLayout(layout: HostRailLayout): void;
  /** The baked animation's controls: `null` before `ready`, for a still file, or with `animate: false`. */
  readonly animation: {
    state(): { status: "idle" | "intro" | "playing" | "paused" | "done"; t: number };
    pause(): void;
    resume(): void;
    /** Play a finished one-time animation again from the start (its camera cues included); a no-op unless `state().status` is `"done"`. */
    replay(): void;
  } | null;
  /**
   * The motion — baked animation or turntable — (0.169.0+): `null` before `ready` and
   * once disposed; present for every decoded file.
   */
  readonly motion: {
    /** Begin a waiting motion. Idempotent; a no-op once started, under reduced motion, or with nothing to move. */
    start(): void;
    /**
     * Put the model back as it opened and start it: the opening camera framing (the
     * file's default view direction, before any carried camera), the animation from
     * t = 0 or the turntable turning again (re-armed). Under reduced motion it only
     * resets the camera.
     */
    restart(): void;
    /** `"stopped"`: a turntable stopped by a grab, a paused animation, reduced motion, or nothing to move. */
    readonly state: "waiting" | "playing" | "stopped" | "finished";
    /** Each state change. Returns an unsubscribe. */
    onChange(cb: (state: "waiting" | "playing" | "stopped" | "finished") => void): () => void;
  } | null;
  renderMode: {
    get(): RenderMode;
    set(mode: RenderMode): Promise<RenderMode>;
    onChange(cb: (e: RenderModeEvent) => void): () => void;
  };
  environment: {
    get(): string;
    set(id: string): Promise<string>;
    onChange(cb: (id: string) => void): () => void;
    list(): Array<{ id: string; label: string }>;
  };
}

/** A kernel-free viewer for a cached preview GLB: the viewer, view cube, view style and theme — no part, no worker, no rail. */
export function mountPreview(container: HTMLElement, options: MountPreviewOptions): PreviewRuntime;

/** Every format `exportParts` can write in this version (`runtime.listExportFormats()` returns copies). */
export const EXPORT_FORMATS: ReadonlyArray<ExportFormatInfo>;

/** The prefix every cut & print kit options error starts with. */
export const KIT_OPTIONS_ERROR: "cut kit options:";

/** The kit's option defaults; `stock: null` is 300 × 300 mm for every stock group. */
export const KIT_DEFAULTS: Readonly<{
  destination: "own-laser";
  kerf: number;
  colors: "lightburn";
  stock: null;
  margin: number;
  spacing: number;
  printFormat: "stl";
  sets: number;
  flip: "left-right";
  twoSided: "one-file";
}>;

/** Normalise kit options — defaults filled, `cutFormat` derived — or throw a `"cut kit options: …"` error. */
export function validateKitOptions(options: unknown): Required<KitOptions>;

/**
 * The sub-parts a view shows: declared in the view and `enabled` for these
 * params, in `Object.keys(part.parts)` order. Handy for app-side view logic.
 */
export function viewSubParts(
  part: PartDefinition,
  view: string,
  params: Record<string, ParamValue>,
): string[];

/**
 * The view `mount()` opens on: a view flagged `default: true`, else the one
 * placing the most sub-parts at the part's defaults (ties keep declaration
 * order). `null` for a part with no views. Exported so a host building a part
 * outside the viewer — a cached preview — opens the same view.
 */
export function resolveDefaultView(part: PartDefinition): string | null;
