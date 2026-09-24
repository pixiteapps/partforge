import "./app.css"; // shared chrome styles — every part-app gets them via mount
import { triggerDownload, downloadParts } from "./download.js";
import { createViewer } from "./viewer.js";
import { attachViewerControls } from "./viewer-controls.js";
import { attachCutawayControls } from "./cutaway-controls.js";
import { attachRail } from "./rail.js";
import { declaredSourceLookup } from "./panel/declared-source.js";
import { attachMobileTabs } from "./mobile-tabs.js";
import { createTooltipPresenter, attachButtonTooltips } from "./tooltip.js";
import { loadCamera, loadProjection, saveProjection, loadRenderMode, loadEnvironment } from "./view-state.js";
import { attachViewStyleControls } from "./view-style-controls.js";
import { ENVIRONMENTS } from "./materials/environments.js";
import { declaresMaterials, resolveMaterial } from "./materials/resolve.js";
import { printFrameMatrix } from "./materials/print-frame.js";
import { buildControls } from "./controls.js";
import { relevantParamKeys } from "./param-deps.js";
import { createMeshCache } from "./mesh-cache.js";
import { createGeometryService } from "./geometry-service.js";
import { viewSubParts, resolveParams } from "./part-model.js";
import { resolveDerived } from "./derive.js";
import { createBackendPolicy } from "./backend-select.js";
import { createDebugOverlay } from "./debug-overlay.js";
import { createRegenLoop } from "./regen-loop.js";
import { createPoseFastPath } from "./pose-fast-path.js";
import { createStatusUi } from "./status-ui.js";
import { createViewTabs } from "./view-tabs.js";
import { attachPickToggle, attachHoverLabels, attachPicker, formatSelection } from "./selection/index.js";
import { createPickRequestClient, resolvePickServerUrl, PICK_SERVER_DEFAULT_URL } from "./pick-request/index.js";
import { exportablePartNames, partLabel } from "./export-select.js";
import { createExportController, backendForFormat } from "./export-controller.js";
import { createCaptureBuild } from "./capture-build.js";
import { attachAnimationControls } from "./animation-controls.js";
import { resolveDefaultView } from "./default-view.js";
import { createMeasureMode } from "./measure/measure-mode.js";
import { attachMeasureControls } from "./measure/measure-controls.js";
import { createAnnotateMode } from "./annotate/annotate-mode.js";
import { attachAnnotateControls } from "./annotate/annotate-controls.js";
import { attachSketchToolbar } from "./annotate/sketch-toolbar.js";
import { attachViewcubeControls } from "./viewcube/viewcube-controls.js";
import { stageClearFor } from "./stage-clear.js";

// The mount handle, factored out so its shape is unit-testable without booting
// the full mount() pipeline (WASM + workers + DOM).
// The default no-op tooltip binding, so a host can hold on to whatever
// attachTooltips returned without caring whether this mount resolved one.
const NOOP_TOOLTIP_BINDING = { sync: () => {}, hide: () => {}, detach: () => {} };
// Same no-op-default stance as attachTooltips/setHostPane below, for a
// makeHandle caller (or a direct test) that doesn't wire measure mode.
const NOOP_MEASURE = { isEnabled: () => false, setEnabled: () => {}, clearPins: () => {}, pinCount: () => 0 };
// Same stance as NOOP_MEASURE: the handle's annotate surface exists whether or
// not this mount wired the mode (it wires only when the host passes
// onAnnotationSend — without a sink, Send would have nowhere to go).
const NOOP_ANNOTATE = {
  isEnabled: () => false, setEnabled: () => {}, undo: () => {}, clear: () => {},
  strokeCount: () => 0, send: () => false,
  onInkChange: () => () => {}, onModeChange: () => () => {},
};
// The STEP-on-Manifold import crossover's broken-state message (a second
// needs-import-mesh after the mesh is already primed — see the "needs-import-mesh"
// case below). One shared string so the status line, onBuild, and the ready
// rejection can never drift apart.
const IMPORT_MESH_BROKEN_MESSAGE = "STEP import tessellation failed to satisfy the import — see console";
// The crossover's OTHER failure mode: the tessellate-imports request itself
// throws (malformed STEP, etc.) rather than delivering a mesh to prime. Distinct
// from IMPORT_MESH_BROKEN_MESSAGE above (that one names a digest mismatch AFTER
// a successful tessellation) — this one names the tessellation failure and
// carries the worker's own error text. See the correlated "error" case below.
const importTessellateFailedMessage = (workerMessage) => `STEP import tessellation failed — ${workerMessage}`;

export function makeHandle({ ready, dispose, viewer, setParams, listExportableParts, exportParts, warmExportKernel, setHostPane, setRailLayout, animation, getView, setView, captureView, attachTooltips, measure, annotate, projection, pickMarker, getPanelState, getPanelErrors, renderMode, environment, declaresMaterials, renderViews }) {
  return {
    ready, dispose, setParams,
    // Part-declared animation playback (spec 2026-08-02): animations are
    // VIEW-owned, so this is null only when NO view declares any.
    // { play(name?), pause(), seek(t), stop(), state() } — play(name) resolves
    // within the ACTIVE view's set, and state() reports that view.
    animation: animation ?? null,
    // Active view name (never null once mounted). See onViewChange for the push side.
    getView,
    // Programmatic tab switch; false for a name the part doesn't declare.
    setView,
    // Offscreen render of a named view (default when omitted, or on an unknown name).
    captureView,
    // Always CAD, whatever the live render mode: these are the agent's renders.
    captureViews: (viewNames) => viewer.captureCanonicalViews(viewNames),
    // captureViews in a chosen appearance: renderMode "cad" (the default) is
    // exactly captureViews() in either live mode; "realistic" borrows the realistic look for the
    // capture (waiting on the environment's assets) without switching the live
    // view. Rejects if realistic's assets fail to load.
    renderViews: renderViews ?? (async (viewNames) => viewer.captureCanonicalViews(viewNames)),
    // `recenter` reads the sub-part geometry only, so with measurement pins on
    // screen the dimension labels — which sit beside the part, not on it —
    // could land outside the centred window. A dimensioned capture therefore
    // keeps the user's exact framing; a host wanting both re-frames first.
    // Follows the live render mode unless opts.renderMode pins one ("realistic"
    // only once the environment has loaded — see viewer.captureCurrent).
    captureCurrent: (opts) => viewer.captureCurrent(
      opts?.recenter && (measure ?? NOOP_MEASURE).isEnabled() && (measure ?? NOOP_MEASURE).pinCount() > 0
        ? { ...opts, recenter: false }
        : opts,
    ),
    // Everything about the CURRENT VIEW that a host would lose by remounting,
    // as one plain-JSON token: pass it back as mount()'s `viewerState` and the
    // remount comes up where the user left it. An embedder that applies edits
    // by remounting (partforge-cloud applies every one that way) needs this or
    // the camera snaps and the cutaway closes on every turn.
    //
    // Read at teardown time, so it is the LIVE pose — unlike the camera the
    // viewer persists for a page reload, which only records the end of a drag
    // and so misses a view-cube click, Reframe, or an animation cue.
    getViewerState: () => ({
      camera: viewer.getCameraState(),
      projection: viewer.getProjection?.() ?? "perspective",
      cutaway: viewer.getCutawayState?.() ?? null,
      // The mode the user is headed for, not only the one on screen: a
      // realistic restore or switch still loading reads "realistic", so a
      // remount mid-load (the cloud remounts on every edit) doesn't drop it.
      // A failed load settles back to "cad".
      renderMode: viewer.isRealisticPending?.() ? "realistic" : viewer.getRenderMode?.() ?? "cad",
      // Only an environment someone CHOSE: carrying the one merely seeded
      // from meta.environment (or the default) would outrank the part's own
      // meta.environment on the next mount, masking an edit to it.
      ...(viewer.isEnvironmentChosen?.() ? { environment: viewer.getEnvironment() } : {}),
    }),
    // Every custom control's transient state (selection, a scroll position),
    // keyed by param, as plain JSON — the panel's twin of getViewerState. Hand
    // it back as mount()'s `panelState` and a remount comes up with the same
    // tile selected. {} when the mount resolved no panel.
    getPanelState: getPanelState ?? (() => ({})),
    // What custom controls reported failing this mount ({key, label, phase,
    // message}), for a host to relay to whoever authored the part.
    getPanelErrors: getPanelErrors ?? (() => []),
    // Park/unpark the viewer: stops the render loop and frees the drawing
    // buffer and the cached capture target. For an embedder that hides the
    // canvas without unmounting it — `visibility: hidden`, an off-screen tab —
    // where nothing collapses the container and the loop would otherwise run
    // forever. See the setActive comment in viewer.js for what it costs.
    setActive: (active) => viewer.setActive(active),
    // Subscribe to WebGL context loss (returns an unsubscribe), so a host can
    // say "the 3D view ran out of memory" instead of showing a dead canvas.
    onContextLost: (listener) => viewer.onContextLost(listener),
    listExportableParts,
    exportParts,
    // Pay the exact kernel's cold boot ahead of an export. STEP is pinned to
    // OCCT, whose ~11 MB WASM loads on its first job, so a Manifold-previewed
    // part's STEP export otherwise pays that boot inside the export itself.
    // Call this when an export becomes likely (a download dialog opening) to
    // move the wait off the moment the user asked for a file. Best-effort:
    // resolves true/false, never rejects, and is a cheap no-op once warm.
    warmExportKernel: warmExportKernel ?? (() => Promise.resolve(false)),
    // Narrow-layout pane selection, for a host that draws its own tab bar
    // (partforge-cloud does, at the window level). Defaulted to a no-op so the
    // handle's shape never depends on whether this mount resolved a rail.
    setHostPane: setHostPane ?? (() => {}),
    // Where the rail SITS, for a host that draws its own chrome around the
    // frame: {mode:"dock", inset, railHeight} renders it into the host's bottom
    // sheet, {mode:"overlay"} floats it as a right-edge drawer over the stage,
    // and null hands the layout back to partforge. Same no-op default as
    // setHostPane above, and the same lease semantics.
    setRailLayout: setRailLayout ?? (() => {}),
    // Join host-owned chrome buttons to this mount's shared hover tooltip, so
    // a host's own viewbar/rail-foot buttons match the built-in ones. Entries
    // are [{ element, getLabel? }] (label falls back to the button's
    // title/aria-label); returns { sync, hide, detach }. Same no-op default
    // stance as setHostPane above.
    attachTooltips: attachTooltips ?? (() => NOOP_TOOLTIP_BINDING),
    // Measurement-mode API (spec Goal 3): { isEnabled, setEnabled, clearPins,
    // pinCount } — an embedder drives the mode without the built-in ruler
    // button. Dimensions render in the scene, so a dimensioned capture is just
    // captureCurrent() taken while the mode is on.
    measure: measure ?? NOOP_MEASURE,
    // Annotation-mode API (spec 2026-08-18): { isEnabled, setEnabled, clear,
    // strokeCount, send, onModeChange } — an embedder drives the mode without
    // the built-in pencil button. send() delivers to onAnnotationSend and
    // returns false when there is no ink or the capture failed.
    annotate: annotate ?? NOOP_ANNOTATE,
    // Projection is a viewer-wide display mode, not a part property — same
    // shape as `measure` and `annotate` so a host reads one convention.
    projection: projection ?? {
      get: () => "perspective",
      set: () => {},
      onChange: () => () => {},
    },
    // The pick marker as a thing with a lifetime, for a host that hangs its own
    // UI off it: hold() keeps the newest marker on screen (earlier held ones
    // stay held), release() clears them all, and onAnchorChange reports where
    // the newest one is on the canvas as the camera moves. Same shape
    // convention as `measure`, `annotate` and `projection`.
    pickMarker: pickMarker ?? {
      hold: () => false,
      release: () => {},
      onAnchorChange: () => () => {},
    },
    // Realistic render mode, a viewer-wide display mode like `projection` and
    // in the same shape. set() resolves to the mode actually in effect — "cad"
    // if the realistic assets failed to load; onChange receives the viewer's
    // {mode, busy, error} event (busy while assets load).
    renderMode: renderMode ?? { get: () => "cad", set: async () => "cad", onChange: () => () => {} },
    // The realistic environment. set() resolves to the id in effect (a failed
    // switch while realistic reverts to the one still shown, and onChange hears
    // both); list() is every environment as {id, label}, for a host picker.
    environment: environment ?? { get: () => "studio", set: async (id) => id, onChange: () => () => {}, list: () => [] },
    // True when any sub-part names a display.material — a host can offer
    // realistic rendering only where it shows something a CAD view does not.
    declaresMaterials: declaresMaterials ?? false,
  };
}

function createCleanupStack() {
  const cleanups = [];
  let disposed = false;
  return {
    defer(cleanup) {
      cleanups.push(cleanup);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const errors = [];
      while (cleanups.length) {
        try { cleanups.pop()(); } catch (error) { errors.push(error); }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "partforge mount cleanup failed");
      }
    },
  };
}

// Mount a full parametric-part app from a PartDefinition. mount is WIRING: the
// pieces it composes each live (and are tested) in their own module — the viewer,
// the schema-driven control panel, the regenerate state machine (regen-loop.js),
// the view tabs (view-tabs.js), the status chrome (status-ui.js), the per-sub-part
// mesh-validity cache, and the geometry workers. The app supplies `createWorker(name)`
// so Vite can bundle the worker (see geometry-service.js).
//
// Embedding contract (0.45.0):
//   const runtime = mount(part, { createWorker, elements, onBuild, onPick, onDownload, onViewChange });
//   await runtime.ready;   // first successful build of the default view
//   runtime.setParams({ openAngle: 45 }); // programmatic edit; pose-only changes apply instantly
//   runtime.getView();     // active view name (string), never null once mounted
//   runtime.setView("lid");       // switch tab programmatically; returns false (and leaves the
//                                 // active tab untouched) for a name the part doesn't declare
//   await runtime.captureView();  // JPEG data URL of the DEFAULT view rendered offscreen (pass
//                                 // a name for a specific view, falling back to the default for
//                                 // an unknown one), never disturbing the active tab or the live
//                                 // scene; null on failure (never throws)
//   runtime.captureCurrent({ size: 2048 });  // one offscreen render of the user's current
//                                         // framing (live camera pose + viewport aspect) at the
//                                         // given long-edge resolution → JPEG data URL, or null
//                                         // when disposed / nothing built yet
//   runtime.listExportableParts();        // [{ name, label }] — every exportable sub-part,
//                                         // independent of the active view (for an embedder-drawn export UI)
//   await runtime.exportParts({ parts: ["base"], format: "stl", onProgress });
//                                         // headless export of a chosen subset; resolves when the file is
//                                         // written (handed to your onDownload sink, or downloaded directly
//                                         // if you don't supply one), rejects on failure
//   runtime.setHostPane("rail");  // narrow layout only: show just the controls
//                                 // rail ('stage' | 'rail'), suppressing the
//                                 // built-in tab bar. null hands selection back.
//   runtime.setRailLayout({mode:"dock", inset, railHeight} | {mode:"overlay"} | null)
//                                 // where the rail sits when the HOST draws chrome
//                                 // over the frame: into its bottom sheet, or as a
//                                 // right-edge drawer over the stage. null restores
//                                 // partforge's own layout.
//   runtime.attachTooltips([{ element: myButton }]);  // host chrome buttons join the
//                                 // mount's shared hover tooltip (the viewbar one).
//                                 // Label = the button's title (or aria-label), or a
//                                 // per-entry getLabel(); the title attribute is
//                                 // absorbed while attached so it can't double up as a
//                                 // native tooltip, and restored on detach. Returns
//                                 // { sync, hide, detach } — call sync() after you
//                                 // toggle a button's disabled state. Detached
//                                 // automatically on dispose().
//   runtime.pickMarker.hold();    // keep the marker from the last pick on screen
//                                 // (earlier held markers stay held), and start
//                                 // reporting where it is. False when there is
//                                 // nothing to hold — a marker's flash has a
//                                 // lifetime, so hold promptly after a pick.
//   runtime.pickMarker.onAnchorChange((a) => …);  // {x, y, visible} in CSS px from the
//                                 // canvas's top-left, as the camera moves; null when
//                                 // nothing is held. Returns an unsubscribe.
//   runtime.pickMarker.release(); // clear every held marker
//   runtime.setActive(false);     // park the viewer: stop the render loop and release
//                                 // both large GPU allocations (the drawing buffer and
//                                 // the cached capture target). For a host that hides the
//                                 // canvas WITHOUT unmounting it (`visibility: hidden`, an
//                                 // inactive tab) — nothing else can detect that, and the
//                                 // loop would otherwise render a hidden pane forever.
//                                 // Captures still work while parked (they re-allocate).
//                                 // setActive(true) restores it. Safe after dispose().
//   runtime.animation?.play("open");  // part-declared animation playback: animations are
//                                 // VIEW-owned, so this is null only when NO view
//                                 // declares any, else
//                                 // { play(name?), pause(), seek(t), stop(), state() }.
//                                 // play(name) resolves within the ACTIVE view's set —
//                                 // an unknown name (including one declared by a
//                                 // different view) warns and does nothing; state()
//                                 // reports the view it applies to. Switching views
//                                 // restores the outgoing animation's params, then
//                                 // presents the incoming view's own set (empty in a
//                                 // view that declares none). Any user/host param edit
//                                 // pauses playback. A view's `autoplay: true` animation
//                                 // self-starts when that view is first shown and on
//                                 // each switch to it, until the user touches the
//                                 // transport — no runtime call needed for that part.
//   const off = runtime.onContextLost(() => …);  // WebGL context loss, i.e. the GPU or the
//                                 // OS gave up — surface it rather than showing a dead
//                                 // canvas. Returns an unsubscribe.
//   runtime.annotate: { isEnabled, setEnabled, undo, clear, strokeCount, send, onInkChange,
//                       onModeChange } — drive annotation mode without the built-in button;
//                                 // no-op when onAnnotationSend was not supplied. Both
//                                 // subscribes return an unsubscribe; onInkChange fires on
//                                 // every stroke/undo/clear, which is what a host driving its
//                                 // own Send button gates that button on (strokeCount() > 0).
//   runtime.projection: { get, set, onChange }
//                                         // "perspective" | "orthographic". Drives the LIVE view
//                                         // and captureCurrent only — captureCanonicalViews,
//                                         // renderMeshPayloads and the CLI stay perspective.
//   runtime.renderMode: { get, set, onChange }
//                                         // "cad" | "realistic". set() resolves to the mode in
//                                         // effect ("cad" if the realistic assets failed);
//                                         // onChange gets {mode, busy, error}. Same shape as
//                                         // projection. Drives the live view; captureCurrent
//                                         // follows it unless given { renderMode }. captureViews
//                                         // is always CAD — the live mode never changes what
//                                         // the agent sees. Feature lines follow it directly:
//                                         // CAD always draws them, realistic never does.
//   runtime.environment: { get, set, onChange, list }
//                                         // the realistic environment ("studio" | "workshop" |
//                                         // "print-bed" | "outdoor"); list() → [{id, label}].
//                                         // A failed switch while realistic reverts, and onChange
//                                         // hears the revert.
//   runtime.declaresMaterials             // true when any sub-part names a display.material
//   await runtime.renderViews(["front"], { renderMode: "realistic" });
//                                         // captureViews in a chosen appearance, without
//                                         // switching the live view; "cad" is exactly captureViews(),
//                                         // CAD in either live mode
//   runtime.dispose();     // full teardown
// onBuild fires per completed build, so it does NOT fire for a pose-only edit —
// those are repaired in the viewer and produce no build at all.
// onViewChange fires once synchronously during mount with the initial resolved
// view (before ready), then again on every subsequent view change (user click
// or a programmatic setView) — always the new view name.
// onParamsCommit({ changed, params })   // the user FINISHED editing a panel control (slider
//                                         // released, box committed, checkbox ticked, preset
//                                         // applied): `changed` lists the keys written, `params`
//                                         // is a snapshot copy. Never fired by setParams or
//                                         // animation playback — hosts call setParams from their
//                                         // own undo/reset, and firing here would loop.
// onAnnotationSend(payload)              // receive user annotations (freehand ink over the frozen
//                                         // view). Supplying this reveals the #annotate viewbar
//                                         // button; omitting it hides the button entirely.
//                                         // payload.images carries two data URLs (the ink drawing
//                                         // and the rendered model), each bounded to a 2048px long
//                                         // edge — a stage bigger than that exports scaled down
//                                         // rather than at its own hi-DPI size. Still hundreds of
//                                         // KB of base64 apiece, so a host should not assume this
//                                         // payload is small, only that it is bounded.
// viewerState: ViewerState               // a previous mount's runtime.getViewerState(), handed back to
//                                         // resume the camera, projection, cutaway, render mode,
//                                         // environment and per-style feature-line preferences
//                                         // where that mount
//                                         // left them. For a host that applies edits by REMOUNTING: the
//                                         // part changed, the user's view of it should not. Omit on a
//                                         // first mount — the viewer then restores its own persisted
//                                         // camera as before. Restore is best-effort per field: a pose
//                                         // this part cannot support is dropped, never fatal.
// panelState: PanelState                 // a previous mount's runtime.getPanelState(): the transient
//                                         // state of the part's custom controls (a selected tile), keyed
//                                         // by param. Same remount story as viewerState; omit on a first
//                                         // mount. Never persisted by partforge.
// files: { [path]: string }              // the part's own source tree as text, for custom controls'
//                                         // host.file(path) — an SVG or a vector document that lives
//                                         // beside the code. Omit and host.file answers null.
// annotateSend: "viewbar" | "host"       // who owns the Send affordance. "viewbar" (default) puts
//                                         // Send in the sketch toolbar alongside the other tools.
//                                         // "host" drops it: the host draws its own send control —
//                                         // e.g. a composer that pairs the sketch with a typed
//                                         // message — and calls runtime.annotate.send() itself.
//                                         // Ignored without onAnnotationSend (there is no toolbar
//                                         // to place it in).
// onAssetUpload(blob, { kind, filename }) // the drop widget's (widgets/file-drop.js) upload hook:
//                                         // async, resolves to a source string (an https: URL or a
//                                         // host token) that gets written into the param. `blob` is
//                                         // the CONVERTED artifact — a PNG, a partforge-vector JSON
//                                         // blob, or the original file for a font — never the user's
//                                         // raw drop. Omit it and the converted bytes land straight
//                                         // in the param instead (what the partforge-cloud sandbox
//                                         // needs, since it cannot fetch URLs — a correct destination,
//                                         // not a degraded one). A rejection is reported through the
//                                         // control's own onError; the widget keeps the converted blob
//                                         // so a retry costs a network call, not a reconvert.
// (view style — no element)              // the view style button (#view-style) is GENERATED
//                                         // into the view cube's stack and sits over the cube's
//                                         // bottom-right corner, where the cube's projection
//                                         // toggle used to be; its popover holds the
//                                         // style (CAD or a realistic environment, as live
//                                         // thumbnails) and the projection. Hosts need no markup
//                                         // for it — the old elements.chrome.realistic /
//                                         // .environment (#realistic, #environment) are gone. A
//                                         // host can still drive runtime.renderMode /
//                                         // .environment / .projection itself. The preferences
//                                         // persist like the theme (and carry in viewerState,
//                                         // which outranks what is stored).
// Every `elements` entry defaults to the legacy global-ID lookup (below), resolved
// exactly once here — submodules take element refs and never query the document.
// `container`/`controls` remain as deprecated aliases for elements.viewer/.controls.
export function mount(part, { createWorker, elements = {}, onBuild, onPick, onDownload, onViewChange, onParamsCommit, onAnnotationSend,
                              fontCatalog,
                              imageCatalog,
                              onAssetUpload,
                              viewerState,
                              files, panelState,
                              annotateSend = "viewbar",
                              container: legacyContainer, controls: legacyControls } = {}) {
  // --- element resolution (the only getElementById calls in the framework, save the ?pickserver client's optional #viewbar lookup) ----
  const byId = (id) => document.getElementById(id);
  const els = {
    viewer: elements.viewer ?? legacyContainer ?? byId("app"),
    controls: elements.controls ?? legacyControls ?? byId("controls"),
    rail: elements.rail ?? byId("panel"),
    // No id fallback: attachRail defaults shell to rail.parentElement, which is
    // right for the standard markup (rail is a direct child of .pf-shell). A
    // host that wraps its rail in an extra element (e.g. a React layout div)
    // must pass this explicitly, or the seam ends up positioned against the
    // wrong ancestor. Left undefined (not null) when unsupplied so rail.js's
    // own default still applies.
    shell: elements.shell,
    status: {
      status: elements.status?.status ?? byId("status"),
      busy: elements.status?.busy ?? byId("busy"),
      phase: elements.status?.phase ?? byId("phase"),
    },
    tabs: elements.tabs ?? byId("part"),
    exports: {
      stl: elements.exports?.stl ?? byId("download"),
      step: elements.exports?.step ?? byId("download-step"),
      threeMf: elements.exports?.threeMf ?? byId("download-3mf"),
    },
    chrome: {
      reframe: elements.chrome?.reframe ?? byId("reframe"),
      theme: elements.chrome?.theme ?? byId("theme"),
      cutaway: elements.chrome?.cutaway ?? byId("cutaway"),
      measure: elements.chrome?.measure ?? byId("measure"),
      annotate: elements.chrome?.annotate ?? byId("annotate"),
      railToggle: elements.chrome?.railToggle ?? byId("rail-toggle"),
    },
  };

  const cleanup = createCleanupStack();
  try {
    const viewer = createViewer(els.viewer, part);
    cleanup.defer(() => viewer.dispose());
    const tooltip = createTooltipPresenter({ id: null });
    cleanup.defer(() => tooltip.dispose());
    // cutawayChrome + measureMode/measureChrome are attached further down (just
    // after `params` exists — measure's getContext needs both `view()` and
    // `params`, and cutaway needs measureMode for its escapeGuard). Nothing
    // between here and there depends on cutawayChrome except the view-tabs
    // onChange closure below, which only runs on a later user/programmatic tab
    // change, never during this synchronous setup.
    // Resizable/collapsible controls rail. No-ops when the host lays out the
    // framework itself (no #panel / no elements.rail).
    const railChrome = attachRail({ rail: els.rail, toggle: els.chrome.railToggle, shell: els.shell, tooltip });
    cleanup.defer(() => railChrome.detach());
    // Narrow-layout pane tabs. Below RAIL_NARROW_BREAKPOINT the rail cannot sit
    // beside the viewer, so exactly one pane shows and this bar picks it. Same
    // resolution and same no-op-when-absent contract as the rail above — the
    // shell default mirrors attachRail's (rail.parentElement).
    const paneTabs = attachMobileTabs({
      shell: els.shell ?? els.rail?.parentElement,
      stage: els.viewer,
      rail: els.rail,
      // The rail toggle floats INSIDE the stage, so the overlay duck has to know
      // it by identity or the drawer's own close button would duck it shut and
      // rail.js would reopen it on the same tap.
      toggle: els.chrome.railToggle,
      // rail.js reads the layout lazily in its handlers, but its toggle
      // visibility (and, in overlay mode, its open/closed reporting) is written
      // in apply() — tell it to re-look when the host changes the layout, or the
      // duck closes the drawer. railChrome is created just above, so the closure
      // is safe.
      onRailLayout: () => railChrome.layoutChanged?.(),
    });
    cleanup.defer(() => paneTabs.detach());
    const hover = attachHoverLabels(viewer, { part, tooltip }); // always-on hover inspection (no-op on touch-only devices)
    cleanup.defer(() => hover.detach());
    const ui = createStatusUi({ ...els.status, exports: [els.exports.stl, els.exports.step, els.exports.threeMf] });
    cleanup.defer(() => ui.setStatus(""));
    cleanup.defer(() => ui.hideBusy());

    // ?backend=occt|manifold forces the backend; otherwise it's re-detected per
    // regen with the live params (so a fillet dialed to 0 reverts to Manifold),
    // with a params-keyed latch for runtime needs-occt reroutes — see
    // createBackendPolicy for why the latch must not outlive a param change.
    let forcedBackend = new URLSearchParams(location.search).get("backend");
    if (forcedBackend !== "occt" && forcedBackend !== "manifold") forcedBackend = null;
    const backendPolicy = createBackendPolicy(part, { forced: forcedBackend });
    const backendFor = () => backendPolicy.backendFor(params);
    // STEP-on-Manifold import crossover (spec 2026-08-16): null → "requested" →
    // "primed", tracking the one tessellate-imports round trip this mount instance
    // ever needs (a worker-lifetime prime, per Task 8). One mount() call handles
    // exactly one part for its whole lifetime — there is no rebind point to reset
    // this at — so declaring it here beside backendPolicy is its only reset.
    let importMeshState = null;
    // jobId of the outstanding tessellate-imports request (mount-generated —
    // jobs.js's tessellate-imports branch echoes it back on both its
    // "import-meshes" reply and, via the shared catch, on a thrown "error").
    // Lets the "error" case below tell a correlated tessellation failure apart
    // from an unrelated build error sharing the same message type, so it can
    // reset the latch instead of stranding it at "requested" forever.
    // String-namespaced ("tess-N"), mirroring capture-build.js's "cap-N" —
    // this request shares the OCCT worker's message space with
    // export-controller's PLAIN NUMERIC jobIds (both start counting at 1), and
    // exportCtl.handleMessage (called before mount's own switch, below) does a
    // raw pending.get(m.jobId) before checking type. A bare numeric id here
    // could collide with a pending STEP export's jobId, so the export
    // controller would wrongly claim this reply — rejecting an unrelated
    // export with the tessellation failure text AND leaving importMeshState
    // stranded at "requested" (mount's own switch, which would have reset it,
    // never runs). The string namespace makes that collision impossible.
    let importTessellateJobId = null;
    let importTessellateJobSeq = 0;

    // ?debug shows the cache debug overlay; ?debug&nocache starts with caching off.
    const qs = new URLSearchParams(location.search);
    const debug = qs.has("debug");
    let cachingOn = !(debug && qs.has("nocache"));
    let lastGen = { skipped: 0, rebuilt: 0, posed: 0 }; // Layer-0/1 counts for the most recent generate
    // Sub-parts the pose fast path has repaired since the last build was dispatched.
    // A SET of names, not a running total: a slider drag re-repairs the same
    // sub-part on every input event, and "247 posed" for a one-sub-part app would
    // be nonsense. A build dispatched in the SAME dirty cycle takes the count into
    // its report — a mixed edit re-poses one sub-part and rebuilds another, and the
    // overlay should say so. Anything that kicks a build for an unrelated reason
    // (view switch / forceRegen) clears it first, so it can't be miscredited.
    const pendingPosed = new Set();
    const dbg = debug
      ? createDebugOverlay({ initialCachingOn: cachingOn, onToggle: (on) => { cachingOn = on; forceRegen(); } })
      : null;
    if (dbg) cleanup.defer(() => dbg.detach());

    // View tabs (generated from part.views) + live params. A tab switch shows the
    // cached assembly instantly if it's current, else auto-builds what's missing.
    const tabsCtl = createViewTabs(els.tabs, part, {
      onChange: (name) => {
        // FIRST: the outgoing animation restores its param snapshot, so the
        // incoming view composes its assembly from un-animated params. Anything
        // that reads params (refreshView / updateRelevance / the loop kick) must
        // run after it. autoplayKick stays LAST — it starts the new view's own.
        animCtl?.viewChanged();
        pendingPosed.clear(); cutawayChrome.reset(); refreshView(); updateRelevance(); loop.kick(); animCtl?.autoplayKick();
        onViewChange?.(name);
      },
    });
    cleanup.defer(() => tabsCtl.detach());
    const view = () => tabsCtl.current();
    // Tell the embedder the starting tab exactly once, synchronously, so a host
    // (partforge-cloud) never has to poll getView() to learn where we opened.
    onViewChange?.(tabsCtl.current());
    const params = { ...part.defaults };

    // Measurement mode: in-scene dims + pins + dimension->controls reveal
    // (clicking a measurement flashes every control that can drive it). The
    // panel is built later in this function, so revealParams is a late-bound
    // thunk — same idiom for getParamsVersion, which needs `loop` (created
    // further below); readsFor's memo keys on it instead of hashing the whole
    // params object per call, mirroring createMeshCache/createPoseFastPath.
    let panelRef = null;
    const measureMode = createMeasureMode(viewer, {
      part,
      getContext: () => ({ view: view(), params }),
      revealParams: (keys, focusKey) => panelRef?.revealParams(keys, focusKey),
      getParamsVersion: () => loop.version(),
    });
    cleanup.defer(() => measureMode.detach());
    // Annotation mode (spec 2026-08-18): freehand ink over the frozen view,
    // delivered to the host via onAnnotationSend. Wired only when the host
    // passes the sink; the chrome hides the button otherwise (mode = null).
    let annotateMode = null;
    if (onAnnotationSend) {
      annotateMode = createAnnotateMode(viewer, {
        stage: els.viewer,
        getContext: () => ({ view: view(), params }),
        onSend: onAnnotationSend,
      });
      cleanup.defer(() => annotateMode.detach());
      // Annotate and measure both claim canvas pointer input — mutually
      // exclusive, whichever turns on turns the other off.
      cleanup.defer(annotateMode.onModeChange(() => {
        if (annotateMode.isEnabled()) measureMode.setEnabled(false);
      }));
      cleanup.defer(measureMode.onModeChange(() => {
        if (measureMode.isEnabled()) annotateMode.setEnabled(false);
      }));
    }
    const annotateChrome = attachAnnotateControls(viewer, annotateMode, {
      annotate: els.chrome.annotate,
    }, { tooltip, escapeScope: els.viewer });
    cleanup.defer(() => annotateChrome.detach());
    // Sketch owns the top of the stage: the toolbar replaces the viewbar while
    // the mode is on (spec 2026-08-27). Restore honors whatever hidden state
    // the host had set before entering. Attached only when annotateMode
    // exists — a mode-less mount (no onAnnotationSend) has nothing for the
    // toolbar to drive.
    if (annotateMode) {
      const sketchToolbar = attachSketchToolbar(annotateMode, {
        stage: els.viewer, tooltip, send: annotateSend,
      });
      cleanup.defer(() => sketchToolbar.detach());
      // Chrome the sketch toolbar stands in for while the mode is on. #viewbar
      // because the toolbar carries its own tools; the view tabs because the
      // toolbar floats in THEIR slot — both are the stage's top centre — and the
      // two are not the same width, so a part with several views left its tabs
      // peeking out either side (78px each side for a five-view part on a
      // 1400px stage). The toolbar paints over them at z 20, so this was only
      // ever about what shows.
      //
      // Each element remembers whatever hidden state the host had set and gets
      // it back on exit, rather than being forced visible: a host with its own
      // reason to hide either one must see that reason survive a round-trip.
      //
      // `hidden` is set for the semantics AND `display` inline for the effect.
      // The property alone is not enough: app.css gives both the viewbar and the
      // tab pill an author-origin `display`, which beats the UA's [hidden] rule
      // — #viewbar[hidden] already carries an explicit rule for exactly that.
      // A rule cannot fix the tabs the same way, because a host that restyles
      // the pill under its own id (partforge-cloud's `#viewer #part`) outranks
      // anything this framework could ship, so the hide rides on the element
      // itself for the same reason view-tabs.js's nowrap does.
      const sketchHides = [els.viewer.querySelector("#viewbar"), els.tabs]
        .filter(Boolean)
        .map((el) => ({ el, wasHidden: false, wasDisplay: "" }));
      cleanup.defer(annotateMode.onModeChange(() => {
        // setEnabled early-returns when the mode is unchanged, so this only ever
        // runs on a real transition and the saved state cannot be overwritten
        // with the state we just imposed.
        const on = annotateMode.isEnabled();
        for (const entry of sketchHides) {
          if (on) {
            entry.wasHidden = entry.el.hidden;
            entry.wasDisplay = entry.el.style.display;
            entry.el.hidden = true;
            entry.el.style.display = "none";
          } else {
            entry.el.hidden = entry.wasHidden;
            entry.el.style.display = entry.wasDisplay;
          }
        }
      }));
    }
    // Orientation cube (and, beside it, the view style button). Generated chrome — no host markup
    // declares it, so an embedder gets it for free. Restored BEFORE any framing
    // happens so a reload into ortho frames once instead of framing in
    // perspective and then visibly re-framing.
    // A carried state outranks the persisted preference: it is this session's
    // live answer, where the stored one is the last page-reload's.
    viewer.setProjection(viewerState?.projection ?? loadProjection());
    // The environment by the same precedence (carried, stored, then the part's
    // own meta.environment — which the viewer already starts on, unchosen). A
    // carried or stored one was chosen, so it stays chosen and carries on. In
    // CAD this only records the id, so the realistic restore below loads the
    // right rig first time rather than the default and then this one.
    const initialEnv = viewerState?.environment ?? loadEnvironment();
    if (initialEnv) viewer.setEnvironment(initialEnv);
    // Realistic mode by the same precedence, requested HERE rather than on the
    // first accepted build: every mount has a fresh renderer, so the
    // environment loads again, and starting now runs that alongside the build
    // instead of showing CAD until the build lands and only then waiting on
    // the assets (a CAD flash on every edit for a host that remounts per
    // edit). Nothing needs a part yet — unbuilt sub-parts compile when first
    // shown, and showAssembly brings the ground to the part when it arrives.
    // While it loads the viewer reports it pending, which is what
    // getViewerState carries; an explicit mode change supersedes it, and a
    // failed load settles to CAD.
    if ((viewerState?.renderMode ?? loadRenderMode() ?? "cad") === "realistic") viewer.setRenderMode("realistic");
    const viewcube = attachViewcubeControls(viewer, { stage: els.viewer });
    cleanup.defer(() => viewcube.detach());
    // The view style button + popover (style, projection), beside the cube,
    // in its stack (the projection toggle's successor) — it hides with the
    // cube (Sketch, a crowded transport bar) and closes its popover then.
    const viewStyle = attachViewStyleControls(viewer, { stage: els.viewer, anchor: viewcube.element }, { tooltip });
    cleanup.defer(() => viewStyle.detach());
    cleanup.defer(viewer.onProjectionChange((mode) => saveProjection(mode)));
    // setHidden takes one boolean, and there are two independent reasons to hide
    // the cube: Sketch mode (below) and a crowded transport bar (wired into the
    // animation controls further down). Applied straight, whichever fires last
    // would win — leaving Sketch would reveal a cube that crowding still wants
    // gone. Track a flag per reason and OR them through one place, the
    // syncHoverSuppression precedent below.
    let cubeHiddenForSketch = false;
    let cubeHiddenForCrowding = false;
    const syncViewcubeHidden = () =>
      viewcube.setHidden(cubeHiddenForSketch || cubeHiddenForCrowding);
    // Sketch freezes the view on purpose: ink is stored in screen space and is
    // meaningful only against the pose it was drawn over. A live camera control
    // on top of that — orbit OR a projection swap — invalidates the drawing.
    if (annotateMode) {
      cleanup.defer(annotateMode.onModeChange(() => {
        cubeHiddenForSketch = annotateMode.isEnabled();
        syncViewcubeHidden();
      }));
    }
    // Publish the viewbar's vertical claim so chrome.css can stack the cube on
    // top of it without hardcoding a height that cutaway/measure/annotate
    // action rows can change. A hidden bar (ours or a host stylesheet's)
    // claims 0 — stage-clear.js has the why; the observer fires on the hide
    // itself, since the bar's box goes to zero.
    const viewbarEl = els.viewer.querySelector("#viewbar");
    if (viewbarEl && typeof ResizeObserver === "function") {
      const publishViewbarClear = () => {
        const clear = stageClearFor(els.viewer.getBoundingClientRect(), viewbarEl.getBoundingClientRect());
        els.viewer.style.setProperty("--pf-viewbar-clear", `${clear}px`);
      };
      const viewbarObserver = new ResizeObserver(publishViewbarClear);
      viewbarObserver.observe(viewbarEl);
      viewbarObserver.observe(els.viewer);
      publishViewbarClear();
      cleanup.defer(() => {
        viewbarObserver.disconnect();
        els.viewer.style.removeProperty("--pf-viewbar-clear");
      });
    }
    // escapeScope: cutaway's Flip/Reset buttons are canvas SIBLINGS inside
    // #viewbar, not descendants of the canvas — attaching Escape to
    // viewer.domElement alone would leave a guarded Escape from those buttons
    // dead. els.viewer (the stage) is a shared ancestor of both, so Escape
    // bubbles up from either.
    const measureChrome = attachMeasureControls(viewer, measureMode, {
      measure: els.chrome.measure,
    }, { tooltip, escapeScope: els.viewer });
    cleanup.defer(() => measureChrome.detach());
    const cutawayChrome = attachCutawayControls(viewer, {
      cutaway: els.chrome.cutaway,
    }, { tooltip, escapeGuard: () => measureMode.isEnabled() || (annotateMode?.isEnabled() ?? false) });
    cleanup.defer(() => cutawayChrome.detach());
    // Suppress the always-on hover tooltip while measure OR annotate mode is
    // active — measure's highlight + dims take the pointer; annotate's overlay
    // canvas takes it entirely.
    const syncHoverSuppression = () =>
      hover.setSuppressed(measureMode.isEnabled() || (annotateMode?.isEnabled() ?? false));
    cleanup.defer(measureMode.onModeChange(syncHoverSuppression));
    if (annotateMode) cleanup.defer(annotateMode.onModeChange(syncHoverSuppression));

    // Current selection context for the pickers: the active view + live params +
    // derived values. Shared by every pick mode below.
    const getContext = () => {
      let derived = {};
      // A throwing derive must not crash the pick flow — proceed without derived context.
      try { derived = resolveDerived(part, { ...part.defaults, ...params }); } catch { /* derived stays {} */ }
      return { view: view(), params, derived };
    };

    // Click-to-select. Precedence (one click listener is ever live): the programmatic
    // onPick option, else the ?pick clipboard toggle, else the ?pickserver client.
    let picker = null;      // { setActive, detach } — armed permanently for onPick
    let pickToggle = null;  // { detach }
    let pickClient = null;  // { detach }
    if (onPick) {
      picker = attachPicker(viewer, {
        part, getContext,
        // Measure mode claims canvas clicks for pinning dimensions, so while it
        // is on a click must not ALSO select-and-flash (hosts turn picks into
        // chat chips — one click was doing both). Same idea as the hover
        // suppression above, but pull-based: checked per click, nothing to
        // resync on mode changes. The ?pick/?pickserver harnesses below are
        // deliberately not guarded — one is armed by an explicit dev toggle,
        // the other per agent request.
        suppressed: () => measureMode.isEnabled() || (annotateMode?.isEnabled() ?? false),
        onPick: (selection, anchor) => onPick({
          selection,
          label: selection.feature?.label ?? part.parts[selection.subPart]?.label ?? selection.subPart,
          prompt: formatSelection(selection, { style: "prompt" }),
          token: formatSelection(selection, { style: "token" }),
          // Where the marker is on the canvas, in CSS px from its top-left, so
          // a host can put its own UI beside the dot on the first frame rather
          // than a round trip later.
          anchor,
        }),
      });
      cleanup.defer(() => picker.detach());
      picker.setActive(true);
    } else if (qs.has("pick")) {
      pickToggle = attachPickToggle(viewer, { part, getContext });
      cleanup.defer(() => pickToggle.detach());
    } else if (qs.has("pickserver")) {
      // Agent-driven mode: arm the picker only when the local pick-server asks for a
      // click. `?pickserver&picktoken=<token>` or `?pickserver=http://host:port&picktoken=…`.
      // The URL is attacker-suppliable (anyone can hand the user a link), so a
      // non-loopback target is refused rather than honoured — otherwise every click,
      // with its live parameter values, would stream to a remote host.
      const serverUrl = resolvePickServerUrl(qs.get("pickserver"), {
        onReject: (raw) => console.warn(
          `partforge: ignoring non-loopback ?pickserver=${raw} — using ${PICK_SERVER_DEFAULT_URL}`,
        ),
      });
      const token = qs.get("picktoken") || "";
      pickClient = createPickRequestClient({ serverUrl, token, viewer, part, getContext });
      cleanup.defer(() => pickClient.detach());
    }

    let framedView = null; // the view the camera was last framed to (null until first show)
    let cameraRestored = false; // saved camera applied once, on the first frame after load

    // Per-sub-part cache-validity tracker (Layer 1): view/version/caching change over
    // time, so they're passed as getters; params is a stable in-place-mutated object.
    const cache = createMeshCache(part, viewer, {
      params,
      getView: view,
      getParamsVersion: () => loop.version(),
      isCaching: () => cachingOn,
    });
    const isCurrent = cache.isCurrent;
    const missingParts = () => viewSubParts(part, view(), params).filter((n) => !isCurrent(n));

    // The regenerate state machine (ready gating / debounce / stale-redo) lives in
    // regen-loop.js; this send callback is the one place a build job is dispatched.
    // Routing is per SUB-part: the missing set splits by backend and each group goes
    // to its own worker in parallel, so a mixed part previews its plain sub-parts at
    // Manifold speed while only the OCCT-routed ones wait. The return value is
    // the job count — the loop holds the cycle open until every group has replied.
    const loop = createRegenLoop({
      missingParts,
      send: (missing) => {
        const needed = viewSubParts(part, view(), params);
        // for the overlay; this build reports the poses repaired in its own cycle.
        lastGen = { skipped: needed.length - missing.length, rebuilt: missing.length, posed: pendingPosed.size };
        pendingPosed.clear(); // consumed — never counted against a second build
        ui.showBusy("generating");
        const backends = backendPolicy.backendsFor(params);
        let jobs = 0;
        for (const backend of ["manifold", "occt"]) {
          const subparts = missing.filter((n) => (backends[n] ?? "manifold") === backend);
          if (subparts.length === 0) continue;
          service.send({ type: "generate", subparts, view: view(), params, cache: cachingOn }, backend);
          jobs++;
        }
        return jobs;
      },
    });
    cleanup.defer(() => loop.dispose());

    // Pose fast path (Layer 0): a param edit that only re-poses a sub-part is
    // repaired synchronously in the viewer — no debounce, no worker job.
    const fastPath = createPoseFastPath(part, viewer, cache, {
      params, getView: view, getParamsVersion: () => loop.version(),
    });

    // paramsVersion of the most recent animation-frame apply. It is what lets
    // the meshes handler tell "stale because playback moved on" (show it — that
    // IS best-effort playback) from "stale because the user edited" (discard).
    let lastAnimApplyVersion = -1;

    // First-build readiness: resolves on the first accepted meshes result, rejects on
    // a first-build error. Guarded against unhandled rejection when never awaited.
    let readySettled = false;
    // First-show autoplay latch: separate from `readySettled`, which the error
    // branch also settles — a part whose first build fails but whose retry
    // succeeds still deserves its autoplay.
    let autoplayKicked = false;
    let resolveReady, rejectReady;
    const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
    ready.catch(() => {});
    cleanup.defer(() => {
      if (readySettled) return;
      readySettled = true;
      rejectReady(new Error("disposed before first build"));
    });

    // Reflect the active view. If every needed part is current, show it and enable
    // export. If stale (a regenerate is in flight), keep the old mesh visible so the
    // view doesn't flicker. If nothing's built yet, show nothing.
    // Show the assembly, framing the camera only the first time we show a given view
    // (initial load / tab switch) — never on a regenerate, so zoom/orbit are kept.
    function showView(needed) {
      const frame = view() !== framedView;
      viewer.showAssembly(needed, { frame });
      if (frame) {
        framedView = view();
        if (!cameraRestored) {
          // A carried camera beats the persisted one for the same reason the
          // projection above does — and it is also the accurate one, since the
          // persisted pose is only written at the end of an orbit drag.
          const cam = viewerState?.camera ?? loadCamera();
          if (cam) viewer.setCameraState(cam);
          // The cutaway goes back on AFTER the camera and only here, on the
          // first accepted build: enabling it needs the sub-parts registered
          // and real bounds to size the plane against, neither of which exists
          // until showAssembly above has run. (Its initial pose also reads the
          // camera direction, so a restore before the camera would seed the
          // fallback pose from the wrong view.)
          if (viewerState?.cutaway?.enabled && viewer.setCutawayState?.(viewerState.cutaway)) {
            cutawayChrome.sync(); // the button was not what turned it on
          }
          cameraRestored = true;
        }
      }
    }

    // Print frames for the layer-line pattern: the display → export map of the
    // geometry just delivered, so layers run the way the part is printed rather
    // than the way it is displayed. Computed at delivery (the frame describes
    // the delivered mesh, which a later pose-only repair only moves) and only
    // for sub-parts whose material draws layer lines — each one costs two
    // geometry-free probe builds.
    const layerLined = new Set(Object.keys(part.parts).filter((n) => {
      try { return resolveMaterial(part.parts[n].display).params.pattern === "layer-lines"; } catch { return false; }
    }));
    const printFrames = {};
    function recordPrintFrames(names) {
      const wanted = names.filter((n) => layerLined.has(n));
      if (!wanted.length) return;
      let resolved;
      try { resolved = resolveParams(part, params); } catch { return; } // diagnosed by the build
      for (const n of wanted) printFrames[n] = printFrameMatrix(part.parts[n], { view: view(), ...resolved });
      viewer.setPrintFrames({ ...printFrames });
    }

    // Sub-parts whose latest fresh delivery had zero triangles (see the `meshes` case).
    const emptySubParts = new Set();

    function refreshView() {
      const needed = viewSubParts(part, view(), params);
      if (needed.every(isCurrent)) {
        showView(needed);
        ui.setExportEnabled(true);
        // The line used to read "N triangles" here; that debug readout now goes
        // to the console (see the `meshes` case). Clearing keeps a stale
        // "phase…" from outliving the build it described.
        ui.setStatus("");
      } else if (needed.every((n) => viewer.hasSubMesh(n))) {
        showView(needed); // stale but present — keep it visible during regenerate
        ui.setExportEnabled(false);
      } else {
        viewer.hideAssembly();
        ui.setExportEnabled(false);
      }
    }

    ui.showBusy("booting kernel"); // visible from first paint until the kernel is ready

    // Bundle filename for a multi-part export (single parts download under their own name).
    const zipName = `${part.meta?.title ?? "parts"}.zip`.toLowerCase().replace(/\s+/g, "-");

    // --- shared message handler ------------------------------------------------
    function onWorkerMessage({ data }) {
      // Headless exportParts() correlation: consume its own replies first.
      if (exportCtl.handleMessage(data, onDownload)) return;
      // captureView's off-loop build channel: consume its replies before the
      // live `meshes` case — capture-meshes must never touch live cache/display.
      if (captureBuild.handleMessage(data)) return;
      switch (data.type) {
        case "ready":
          loop.ready(); // auto-build the default view (keeps the busy spinner up)
          break;
        case "progress":
          ui.showBusy(data.phase);
          ui.setStatus(`${data.phase}…`);
          break;
        case "meshes": {
          const fresh = loop.buildDone();
          if (fresh) { // stale results (params changed mid-build) are discarded
            for (const m of data.meshes) {
              viewer.setSubGeometry(m.name, m); // disposes any previous mesh for this name
              cache.record(m.name);
              // A sub-part that built into NOTHING. Manifold booleans return an
              // empty solid rather than throwing (a bore wider than its body),
              // and typed values may sit outside the authored range, so a
              // "successful" build can deliver zero triangles — recorded here,
              // reported below once the view is whole. Undefined counts (a
              // host's synthetic reply) are not empty.
              if (m.triangles === 0) emptySubParts.add(m.name); else emptySubParts.delete(m.name);
              // Stamp the fast path's pose baseline. Only here, inside the
              // non-stale branch: the stamp must describe the geometry actually
              // delivered, which buildDone() true guarantees is at the live params.
              fastPath.recordDelivered(m.name);
            }
            recordPrintFrames(data.meshes.map((m) => m.name));
            // A split dispatch answers in two meshes replies; the busy spinner
            // stays up until the view has everything (the other worker's job may
            // still be running — often OCCT, the slow one).
            if (missingParts().length === 0) ui.hideBusy();
            refreshView();
            // After refreshView, like the error case: its all-current branch
            // clears the status line, and this message has to outlive that.
            if (missingParts().length === 0) {
              const empty = viewSubParts(part, view(), params).filter((n) => emptySubParts.has(n));
              if (empty.length) ui.setStatus(`empty: ${empty.join(", ")} produced no geometry at these values`, true);
            }
            if (data.ms && missingParts().length === 0) {
              const tris = viewSubParts(part, view(), params).reduce((s, n) => s + viewer.subTriangles(n), 0);
              console.debug(`partforge: built ${tris.toLocaleString()} triangles in ${(data.ms / 1000).toFixed(1)} s`);
            }
            dbg?.update({ ms: data.ms, hits: data.cache?.hits ?? 0, misses: data.cache?.misses ?? 0, skipped: lastGen.skipped, rebuilt: lastGen.rebuilt, posed: lastGen.posed });
            onBuild?.({ status: "success", ms: data.ms });
            // ready/autoplay wait for the WHOLE view: a split dispatch delivers in
            // two replies, and a host acting on `ready` (screenshotting, measuring)
            // must never see half an assembly.
            if (missingParts().length === 0) {
              if (!readySettled) { readySettled = true; resolveReady(); }
              // First-show autoplay: latched separately from `ready`, which the
              // error branch also settles — a part whose first build fails but
              // whose retry succeeds still deserves its autoplay.
              if (!autoplayKicked) { autoplayKicked = true; animCtl?.autoplayKick(); }
            }
          } else if (lastAnimApplyVersion === loop.version()) {
            // Stale ONLY because animation frames kept bumping the version:
            // show the delivered meshes anyway — that IS best-effort playback —
            // but record NOTHING. Cache and fast-path stamps must describe
            // geometry built at the live params, and this delivery wasn't; the
            // fast-path stamp is dropped too, so a later pose-only repair can
            // never re-pose this newer geometry off an older delivery's stamp.
            // A user edit mid-play pauses playback and bumps the version WITHOUT
            // touching lastAnimApplyVersion, so a genuinely user-stale result
            // fails this test and is discarded exactly as before.
            for (const m of data.meshes) {
              viewer.setSubGeometry(m.name, m);
              fastPath.forget(m.name);
            }
            ui.hideBusy();
            refreshView();
          }
          loop.kick(); // stale → rebuild; fresh → the view may still need parts (tab switched mid-build)
          break;
        }
        case "download-parts":
          ui.hideBusy();
          downloadParts(data, zipName, onDownload);
          ui.setStatus(`${data.parts.length} part(s) downloaded`);
          break;
        case "download":
          ui.hideBusy();
          triggerDownload(data.data, data.filename, data.mime, onDownload);
          ui.setStatus(`${data.filename} downloaded`);
          break;
        case "needs-occt":
          // Probe missed for the current params — rebuild the failed job's
          // sub-parts on OCCT (an export reply has no subparts and latches the
          // whole part). The latch is per params snapshot, so changing params
          // re-consults the probe and sub-parts drop back to Manifold when the
          // unsupported edge class or other runtime-only requirement goes away.
          backendPolicy.noteNeedsOcct(params, data.subparts);
          loop.buildDone();
          loop.kick();
          break;
        case "needs-import-mesh":
          // STEP import on the Manifold worker: an unprimed import threw
          // NEEDS_IMPORT_MESH (Task 8). Settle this build the same way
          // needs-occt does — buildDone() only, no kick() here: the retry can't
          // succeed until priming completes, and kicking now would just repeat
          // the same failure before the mesh exists. The "import-meshes" case
          // below is what kicks, once the prime has actually landed.
          loop.buildDone();
          if (importMeshState === "primed") {
            // Tessellation already delivered a mesh but Manifold still can't
            // satisfy the import — the digest didn't match. A genuinely broken
            // state, not a retry loop: surface it like any other build error
            // rather than re-requesting tessellation forever.
            ui.hideBusy();
            refreshView();
            ui.setStatus(`failed: ${IMPORT_MESH_BROKEN_MESSAGE}`, true);
            onBuild?.({ status: "error", error: IMPORT_MESH_BROKEN_MESSAGE });
            if (!readySettled) { readySettled = true; rejectReady(new Error(IMPORT_MESH_BROKEN_MESSAGE)); }
          } else if (importMeshState !== "requested") {
            importMeshState = "requested";
            importTessellateJobId = `tess-${++importTessellateJobSeq}`;
            service.send({ type: "tessellate-imports", jobId: importTessellateJobId }, "occt");
          }
          break;
        case "import-meshes":
          // The OCCT worker answered tessellate-imports: prime the Manifold
          // worker's import cache (worker-lifetime, per Task 8) with transferable
          // mesh buffers, then kick the loop — the needs-import-mesh case above
          // already settled the failed build (buildDone), so this kick is the
          // other half of the same buildDone()/kick() pairing needs-occt does in
          // one step, split across the two crossover replies here.
          importMeshState = "primed";
          importTessellateJobId = null; // the request this jobId correlated is answered — nothing to match against it anymore
          service.send({ type: "prime-imports", meshes: data.meshes }, "manifold",
            Object.values(data.meshes).flatMap((m) => [m.positions.buffer, m.indices.buffer]));
          loop.kick();
          break;
        case "error": {
          // A correlated tessellate-imports failure (malformed STEP, etc.) must
          // not fall through the generic handling below: that request was
          // dispatched directly via service.send (see needs-import-mesh above),
          // never through loop.send, so loop.buildDone() has no matching pending
          // count to release for it — calling it here would mis-credit an
          // unrelated in-flight generate job. Reset the latch instead of leaving
          // it stuck at "requested" forever (which would silently swallow every
          // later needs-import-mesh via the `!== "requested"` guard above) — the
          // next kick (param/view change) retries tessellation fresh.
          if (data.jobId != null && data.jobId === importTessellateJobId) {
            importMeshState = null;
            importTessellateJobId = null;
            ui.hideBusy();
            refreshView();
            const tessellateMessage = importTessellateFailedMessage(data.message);
            ui.setStatus(`failed: ${tessellateMessage}`, true);
            onBuild?.({ status: "error", error: tessellateMessage });
            if (!readySettled) { readySettled = true; rejectReady(new Error(tessellateMessage)); }
            break;
          }
          loop.buildDone();
          ui.hideBusy();
          // refreshView FIRST: its all-current branch clears the status line,
          // so writing the failure after it keeps the message on screen.
          refreshView();
          ui.setStatus(`failed: ${data.message}`, true);
          onBuild?.({ status: "error", error: data.message });
          if (!readySettled) { readySettled = true; rejectReady(new Error(data.message)); }
          break;
        }
      }
    }

    const service = createGeometryService({ createWorker, onMessage: onWorkerMessage });
    cleanup.defer(() => service.terminate());

    const captureBuild = createCaptureBuild({ send: (msg, backend) => service.send(msg, backend) });
    cleanup.defer(() => captureBuild.dispose());

    const exportCtl = createExportController({
      send: (msg, backend) => service.send(msg, backend),
      currentView: () => view(),
      title: () => part.meta?.title ?? "parts",
      defaultBackend: () => backendFor(),
      currentParams: () => params,
    });
    cleanup.defer(() => exportCtl.dispose("viewer disposed"));

    let animCtl = null; // assigned below; panel edits must pause active playback
    const panel = buildControls(els.controls, part.parameters, params, () => {
      animCtl?.notifyUserEdit();
      onParamChange();
    }, onParamsCommit
      ? (changed) => onParamsCommit({ changed, params: { ...params } })
      : undefined,
      // What the part is actually using for each asset key, so a control opens
      // showing the bundled default instead of an empty tile. Rebuilt per panel
      // build, because the declaration is a function of the current params.
      { fontCatalog, imageCatalog, onAssetUpload,
        declaredSource: declaredSourceLookup(part, params),
        files, panelState });
    cleanup.defer(() => panel.dispose());
    panelRef = panel;
    const updateRelevance = () => {
      // A throwing derive() must not break every slider drag — mount's pick
      // flow already guards its own resolveDerived call the same way
      // (mount.js ~:250). Readouts simply stay em-dashed.
      let derived = {};
      try { derived = resolveDerived(part, params); } catch { /* diagnosed by lint/build */ }
      panel.refresh({ relevant: relevantParamKeys(part, view(), params), derived });
    };
    updateRelevance(); // initial view

    // The ONLY caller of fastPath.repair(). It must never move into the regen /
    // forceRegen path: forceRegen() forgets cache stamps WITHOUT bumping the params
    // version, so a repair there would re-stamp everything current off the memoized
    // probe and the forced rebuild would silently no-op.
    function onParamChange({ debounce = true } = {}) {
      loop.markDirty({ debounce }); // bump the version first: refreshView below must see the parts as stale
      // Pose-only edits: re-posed + re-stamped current, no job. Skipped entirely
      // when caching is off — ?debug&nocache is there to measure true uncached
      // rebuilds, which the fast path would otherwise hide.
      const posed = cachingOn ? fastPath.repair() : [];
      if (posed.length) {
        for (const name of posed) pendingPosed.add(name);
        dbg?.update({ posed: pendingPosed.size }); // partial: merges over the last build's numbers
      }
      refreshView();    // keep showing the now-stale mesh (no flicker); disable export
      updateRelevance();
    }

    // Programmatic param entry point — the animation-system hook. Same change
    // path as a slider edit: pose-only changes repair synchronously (no worker
    // job, no debounce); geometry changes fall through to the regen loop.
    function setParams(partial) {
      animCtl?.notifyUserEdit();
      Object.assign(params, partial);
      panel.syncValues(Object.keys(partial));
      onParamChange();
    }

    // Animation-frame param entry point: same change path as setParams, minus
    // the regen debounce. The explicit kick after repair is what makes playback
    // best-effort — a pose-only frame finds nothing missing (repair re-stamped
    // it) and sends no job; a geometry frame dispatches immediately when the
    // worker is idle and is otherwise absorbed until buildDone re-kicks.
    function applyAnimationValues(values) {
      Object.assign(params, values);
      panel.syncValues(Object.keys(values));
      onParamChange({ debounce: false });
      lastAnimApplyVersion = loop.version(); // this version came from playback, not a user edit
      loop.kick();
    }

    // Animation transport + driver (null when NO view declares animations).
    // Animations are view-owned: `getView` is how the driver knows which view's
    // set is live, both at attach and after every `viewChanged()`.
    animCtl = attachAnimationControls(viewer, part, {
      container: els.viewer,
      applyValues: applyAnimationValues,
      getParamValues: (keys) => Object.fromEntries(keys.map((k) => [k, params[k]])),
      getView: view,
      // On a narrow stage the transport bar has to cap its own width to stay
      // clear of the bottom-right cluster, and under that cap its controls fall
      // below the 44px tap target. The cube gives way instead — it is the
      // reclaimable half of that cluster. Nothing here keys on the viewport
      // width: a part with no animations, or one whose bar fits, keeps its cube
      // at every size. syncViewcubeHidden and the viewcube itself are both
      // declared above this point, so this can never fire into a hole.
      onCrowded: (crowded) => {
        cubeHiddenForCrowding = crowded;
        syncViewcubeHidden();
      },
    });
    if (animCtl) cleanup.defer(() => animCtl.detach());
    // Sketch mode takes the transport bar's slot: the host floats its own
    // composer there (partforge-cloud's sketch composer), and ink is stored in
    // screen space against the pose it was drawn over — a playing animation
    // under it is meaningless. STOP first, then hide: hiding first leaves a
    // frame where an animation still drives the model beneath a bar that is
    // already gone. Playback does not resume on the way out; "stop" is the
    // contract, and notifyUserEdit is the same pause a user's own control edit
    // performs.
    if (annotateMode && animCtl) {
      cleanup.defer(annotateMode.onModeChange(() => {
        const on = annotateMode.isEnabled();
        if (on) animCtl.notifyUserEdit();
        animCtl.setHidden(on);
      }));
    }

    // Re-run the active view under the current caching setting, so toggling the
    // ?debug switch updates the readout for the same design without a param change.
    function forceRegen() {
      pendingPosed.clear(); // this rebuild is not the pose edit's — don't credit it
      for (const n of viewSubParts(part, view(), params)) cache.forget(n);
      refreshView();
      loop.kick();
    }

    const onStlClick = () => {
      ui.showBusy("exporting STL");
      service.send({ type: "export-stl", view: view(), params, quality: "print" }, backendFor());
    };
    if (els.exports.stl) {
      els.exports.stl.addEventListener("click", onStlClick);
      cleanup.defer(() => els.exports.stl.removeEventListener("click", onStlClick));
    }

    const onStepClick = () => {
      ui.showBusy("exporting STEP");
      service.send({ type: "export-step", view: view(), params }, backendForFormat("step", backendFor));
    };
    if (els.exports.step) {
      els.exports.step.addEventListener("click", onStepClick);
      cleanup.defer(() => els.exports.step.removeEventListener("click", onStepClick));
    }

    const on3mfClick = () => {
      ui.showBusy("exporting 3MF");
      service.send({ type: "export-3mf", view: view(), params, quality: "print" }, backendFor());
    };
    if (els.exports.threeMf) {
      els.exports.threeMf.addEventListener("click", on3mfClick);
      cleanup.defer(() => els.exports.threeMf.removeEventListener("click", on3mfClick));
    }

    // Optional host-page viewer chrome (reframe / theme) + camera persistence.
    const chrome = attachViewerControls(viewer, els.chrome, { tooltip });
    cleanup.defer(() => chrome.detach());

    // Full teardown of everything this mount created. Idempotent. A disposed runtime
    // can never surface a late build result (workers are terminated, the loop is
    // terminal), which is what makes cross-mount swap races safe for embedders.
    function dispose() {
      cleanup.dispose();
    }

    // Off-loop offscreen thumbnail: builds `viewName` (or the part's resolved
    // default when omitted/unknown) via captureBuild's correlated channel, then
    // renders it in a throwaway scene via viewer.renderMeshPayloads. Never
    // touches the active tab, getView(), or the live scene — best-effort: any
    // failure, including a resolved-null from a worker build failure (4A
    // settles rather than throwing), returns null. `opts` is spread last, so
    // renderMeshPayloads' own options (including `background`) pass straight
    // through from the caller.
    const captureView = async (viewName, opts = {}) => {
      try {
        const target = (viewName && part.views?.[viewName]) ? viewName : resolveDefaultView(part);
        const subparts = viewSubParts(part, target, params);
        if (!subparts.length) return null;
        const meshes = await captureBuild.request({ subparts, view: target, params, backend: backendFor() });
        if (!meshes || !meshes.length) return null; // 4A resolves null on a worker build failure
        return viewer.renderMeshPayloads(meshes, { size: 640, quality: 0.8, angle: "iso", ...opts });
      } catch {
        return null; // best-effort: a failed thumbnail never breaks the caller
      }
    };

    // Host chrome buttons joining the mount's shared tooltip (the one the
    // viewbar and cutaway buttons already use). Bindings are detached by
    // dispose() via the cleanup stack; a host detaching earlier is fine —
    // attachButtonTooltips.detach is idempotent.
    const attachHostTooltips = (entries) => {
      const binding = attachButtonTooltips(tooltip, entries);
      cleanup.defer(() => binding.detach());
      return binding;
    };

    return makeHandle({
      ready, dispose, viewer, setParams,
      attachTooltips: attachHostTooltips,
      setHostPane: paneTabs.setHostPane,
      setRailLayout: paneTabs.setRailLayout,
      getView: view,                         // () => tabsCtl.current()
      setView: (name) => tabsCtl.select(name),
      captureView,
      getPanelState: () => panelRef?.getState() ?? {},
      getPanelErrors: () => panelRef?.errors() ?? [],
      listExportableParts: () =>
        exportablePartNames(part, params).map((name) => ({ name, label: partLabel(part, name) })),
      exportParts: (opts) => exportCtl.exportParts(opts),
      warmExportKernel: () => exportCtl.warmKernel(),
      animation: animCtl?.runtime ?? null,
      measure: {
        isEnabled: measureMode.isEnabled,
        setEnabled: measureMode.setEnabled,
        clearPins: measureMode.clearPins,
        pinCount: measureMode.pinCount,
      },
      annotate: annotateMode ? {
        isEnabled: annotateMode.isEnabled,
        setEnabled: annotateMode.setEnabled,
        undo: annotateMode.undo,
        clear: annotateMode.clear,
        strokeCount: annotateMode.strokeCount,
        send: annotateMode.send,
        onInkChange: annotateMode.onInkChange,
        onModeChange: annotateMode.onModeChange,
      } : null,
      projection: {
        get: () => viewer.getProjection(),
        set: (mode) => viewer.setProjection(mode),
        onChange: (cb) => viewer.onProjectionChange(cb),
      },
      pickMarker: {
        hold: () => viewer.holdFlashPoint(),
        release: () => viewer.releaseFlashPoints(),
        onAnchorChange: (cb) => viewer.onFlashAnchorChange(cb),
      },
      renderMode: {
        get: () => viewer.getRenderMode(),
        set: (mode) => viewer.setRenderMode(mode),
        onChange: (cb) => viewer.onRenderModeChange(cb),
      },
      environment: {
        get: () => viewer.getEnvironment(),
        set: (id) => viewer.setEnvironment(id),
        onChange: (cb) => viewer.onEnvironmentChange(cb),
        list: () => Object.values(ENVIRONMENTS).map(({ id, label }) => ({ id, label })),
      },
      declaresMaterials: declaresMaterials(part),
      renderViews: (viewNames, opts) => viewer.renderViews(viewNames, opts),
    });
  } catch (error) {
    try {
      cleanup.dispose();
    } catch (cleanupError) {
      const cleanupErrors = cleanupError instanceof AggregateError
        ? cleanupError.errors
        : [cleanupError];
      throw new AggregateError(
        [error, ...cleanupErrors],
        "partforge mount construction and cleanup failed",
      );
    }
    throw error;
  }
}
