import "./app.css"; // shared chrome styles — every part-app gets them via mount
import { triggerDownload, downloadParts } from "./download.js";
import { createViewer } from "./viewer.js";
import { attachViewerControls } from "./viewer-controls.js";
import { attachCutawayControls } from "./cutaway-controls.js";
import { attachRail } from "./rail.js";
import { declaredSourceLookup } from "./panel/declared-source.js";
import { attachMobileTabs } from "./mobile-tabs.js";
import { createTooltipPresenter, attachButtonTooltips } from "./tooltip.js";
import { loadCamera, loadRenderMode, loadEnvironment } from "./view-state.js";
import { isFaceAlignedState } from "./projection.js";
import { attachViewStyleControls } from "./view-style-controls.js";
import { attachSelectionPopover } from "./selection-popover.js";
import { ENVIRONMENTS } from "./materials/environments.js";
import { declaresMaterials, resolveMaterial } from "./materials/resolve.js";
import { printFrameMatrix } from "./materials/print-frame.js";
import { realisticDisplay, sheetFrameFor, wantsSheetFrame } from "./materials/sheet-look.js";
import { pruneOverrides } from "./materials/overrides.js";
import { subPartRows } from "./sub-part-list.js";
import { buildControls } from "./controls.js";
import { recordedRelevantKeys, subPartParamKeys } from "./param-deps.js";
import { createMeshCache } from "./mesh-cache.js";
import { createGeometryService } from "./geometry-service.js";
import { viewSubParts, resolveParams } from "./part-model.js";
import { resolveDerived } from "./derive.js";
import { createBackendPolicy, organicExportParts } from "./backend-select.js";
import { createDebugOverlay } from "./debug-overlay.js";
import { createRegenLoop } from "./regen-loop.js";
import { createPoseFastPath } from "./pose-fast-path.js";
import { createStatusUi } from "./status-ui.js";
import { createViewTabs } from "./view-tabs.js";
import { attachPickToggle, attachHoverLabels, attachPicker, formatSelection } from "./selection/index.js";
import { createPickRequestClient, resolvePickServerUrl, PICK_SERVER_DEFAULT_URL } from "./pick-request/index.js";
import { exportableRows, exportFormatList } from "./export-rows.js";
import { createExportController } from "./export-controller.js";
import { createCaptureBuild } from "./capture-build.js";
import { attachAnimationControls } from "./animation-controls.js";
import { resolveDefaultView } from "./default-view.js";
import { createMeasureMode } from "./measure/measure-mode.js";
import { attachMeasureControls } from "./measure/measure-controls.js";
import { createAnnotateMode } from "./annotate/annotate-mode.js";
import { attachAnnotateControls } from "./annotate/annotate-controls.js";
import { attachSketchToolbar } from "./annotate/sketch-toolbar.js";
import { attachViewcubeControls } from "./viewcube/viewcube-controls.js";
import { createPreviewGate } from "./preview-gate.js";
import { samplePreviewAnimation } from "./preview-animation.js";
import { observeViewbarClear } from "./viewbar-clear.js";

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

export function makeHandle({ ready, dispose, viewer, setParams, listExportableParts, listExportFormats, exportParts, warmExportKernel, setHostPane, setRailLayout, animation, getView, setView, captureView, attachTooltips, measure, annotate, projection, pickMarker, getPanelState, getPanelErrors, controlsFor, renderMode, environment, declaresMaterials, renderViews, isPreviewActive, exportPreview, pendingCutaway, listSubParts, openAppearance, setDisplaySaveState, selection, selectionState }) {
  return {
    ready, dispose, setParams,
    // Whether the `preview` GLB handed to mount() is on screen (see mount's
    // preview block). A GETTER, read live: a host that copies the handle object
    // freezes the value it had at that moment.
    get previewActive() { return isPreviewActive?.() ?? false; },
    // The view on screen as a preview GLB (partforge/gltf), poses baked in.
    exportPreview: exportPreview ?? (() => Promise.reject(new Error("exportPreview: this mount cannot encode a preview"))),
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
    // The user's current view as an animation camera cue — `{ cue, panned }`,
    // or null with nothing on screen — so a host can turn "the way I'm looking
    // now" into a `camera` value an author (or an agent) writes into a part.
    getCameraCue: () => viewer.getCameraCue?.() ?? null,
    getViewerState: () => ({
      camera: viewer.getCameraState(),
      projection: viewer.getProjection?.() ?? "perspective",
      // A carried cutaway not yet restored (the preview holds it back) is still
      // what the user last had: echo it, or a remount in that window drops it.
      cutaway: pendingCutaway?.() ?? viewer.getCutawayState?.() ?? null,
      // The mode the user is headed for, not only the one on screen: a
      // realistic restore or switch still loading reads "realistic", so a
      // remount mid-load (the cloud remounts on every edit) doesn't drop it.
      // A failed load settles back to "cad".
      renderMode: viewer.isRealisticPending?.() ? "realistic" : viewer.getRenderMode?.() ?? "cad",
      // Only an environment someone CHOSE: carrying the one merely seeded
      // from meta.environment (or the default) would outrank the part's own
      // meta.environment on the next mount, masking an edit to it.
      ...(viewer.isEnvironmentChosen?.() ? { environment: viewer.getEnvironment() } : {}),
      // Only while something is overridden: an empty map would be noise in a
      // token hosts compare and store.
      ...(() => { const d = viewer.getDisplayOverrides?.(); return d && Object.keys(d).length ? { display: d } : {}; })(),
      // The open selection popover, so a remount reopens it where it was.
      ...(() => { const s = selectionState?.(); return s ? { selection: s } : {}; })(),
    }),
    // The selection popover (mount's `selectionPopover` option), or null:
    // { setSlotHeight(px), onSlotChange(cb) → off, onClose(cb) → off, close(), isOpen() }.
    selection: selection ?? null,
    // --- per-sub-part display overrides (spec 2026-10-13 part appearance controls) ---
    // Live, no rebuild: appearance keys (material, colour, finish) merge over
    // the authored `display` for every render; `hidden` and `opacity` are how
    // the user is looking and never reach a material read, an export or a
    // host's save. All of it rides getViewerState().display above.
    setSubPartDisplay: (name, patch) => viewer.setSubPartDisplay?.(name, patch) ?? null,
    getSubPartDisplay: (name) => viewer.getSubPartDisplayState?.(name) ?? null,
    clearSubPartDisplay: (opts) => viewer.clearSubPartDisplay?.(opts),
    onSubPartDisplayChange: (cb) => viewer.onDisplayChange?.(cb) ?? (() => {}),
    // Every sub-part as a row (sub-part-list.js), for a host's own list; the
    // active view unless `view` names another.
    listSubParts: listSubParts ?? (() => []),
    // Open the popover on the appearance card for `name`; false when there is
    // no popover (a host with neither #viewbar nor a view cube stack).
    openAppearance: openAppearance ?? (() => false),
    // "saved" | "screen-only" | "blocked": the card's footer copy. A host that
    // persists overrides into source says "saved"; one that cannot, for this
    // sub-part, says "blocked"; the default is "screen-only".
    setDisplaySaveState: setDisplaySaveState ?? (() => {}),
    // Every custom control's transient state (selection, a scroll position),
    // keyed by param, as plain JSON — the panel's twin of getViewerState. Hand
    // it back as mount()'s `panelState` and a remount comes up with the same
    // tile selected. {} when the mount resolved no panel.
    getPanelState: getPanelState ?? (() => ({})),
    controlsFor: controlsFor ?? (() => []),
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
    // What exportParts can write, as { id, label, ext, mime, needsSheet } — the cut &
    // print kit ("bundle") needs a sheet part checked. A makeHandle caller that wires
    // no export (a test) lists none.
    listExportFormats: listExportFormats ?? (() => []),
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
// Embedding contract (0.167.0: `progressiveBuild: true` shows a many-sub-part view
// filling in as its sub-parts finish — the worker then also posts `meshes-partial`
// batches, and the final `meshes` carries only what no batch did, so a host reading
// worker replies itself must add them up; 0.166.0: `cacheBudgetMB` bounds the worker's solid cache —
// pass a small one on phones; 0.158.0: a preview GLB may carry its view's autoplay
// animation — mount({ preview }) draws its opening pose and does not play it,
// mountPreview plays it unless `animate: false`, and exportPreview bakes it only
// when every track is place-only; 0.147.0: a cached `preview` GLB is drawn before
// the kernel boots and swapped in place by the first build; 0.141.0: a place()-able sub-part
// is delivered in its canonical frame and posed by the viewer; pose-only edits
// never rebuild):
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
//   runtime.listExportableParts();        // [{ name, label, sheet? }] — every exportable sub-part,
//                                         // independent of the active view (for an embedder-drawn export UI);
//                                         // a sheet part's row adds sheet: { process, material, thickness, group }
//   runtime.listExportFormats();          // [{ id, label, ext, mime, needsSheet }] — what exportParts writes;
//                                         // format "bundle" (the cut & print kit) also takes `options`
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
//                                         // "perspective" | "orthographic". AUTOMATIC in the UI
//                                         // (Fusion 360's "Perspective with Ortho Faces"): a view
//                                         // cube FACE click settles into orthographic, an edge or
//                                         // corner click is perspective, and rotating off the face
//                                         // returns to perspective (pan and zoom keep it). There
//                                         // is no user control for it. set("orthographic") still
//                                         // works for a host, and is left the same way — by the
//                                         // first rotation. Not persisted across reloads; carried
//                                         // in viewerState only with a face-view camera. Drives
//                                         // the LIVE view and captureCurrent only —
//                                         // captureCanonicalViews, renderMeshPayloads and the CLI
//                                         // stay perspective.
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
//   runtime.previewActive  // true while the `preview` GLB is on screen (decoded, not yet
//                          // replaced by a whole live build): picking, hover labels,
//                          // measure, sketch and cutaway wait; orbit, the view cube,
//                          // the view style and the rail work
//   await runtime.exportPreview();  // the view on screen as a preview GLB (Uint8Array,
//                          // partforge/gltf), fast-path poses baked in, plus the
//                          // view's autoplay animation when every track is
//                          // place-only. Rejects while
//                          // previewActive, before the view is fully built (a pending
//                          // rebuild counts), for a view other than the one on screen,
//                          // and after dispose
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
//                                         // environment, per-style feature-line preferences and
//                                         // per-sub-part display overrides (`display`, pruned for
//                                         // this part) where that mount
//                                         // left them. For a host that applies edits by REMOUNTING: the
//                                         // part changed, the user's view of it should not. Omit on a
//                                         // first mount — the viewer then restores its own persisted
//                                         // camera as before. Restore is best-effort per field: a pose
//                                         // this part cannot support is dropped, never fatal.
// preview: Uint8Array | ArrayBuffer      // a GLB from encodePreviewGlb / exportPreview, drawn before
//                                         // the worker is ready and replaced sub-part by sub-part by
//                                         // the first live build, camera kept. Only a file for the view
//                                         // on screen is drawn, and only its sub-parts of that view; a
//                                         // file for another view, or one that will not decode, is
//                                         // logged once and ignored. A file that carries the view's
//                                         // baked autoplay animation (encoder version 4) is drawn
//                                         // in its opening pose and never played here (playing it is
//                                         // mountPreview's); the first live build replaces it.
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
// selectionPopover: { slot: boolean }    // opt in to the selection popover: a pick
//                                         // (onPick required) opens a popover at the
//                                         // spot — the sub-part's swatch/label/material
//                                         // (opens its appearance card), an eye, ✕ —
//                                         // and, with slot: true, an empty slot the
//                                         // host floats its own UI over (see
//                                         // runtime.selection). Absent or not an
//                                         // object: no popover, exactly as before.
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
// (view style — no element)              // the view style button (#view-style, an eye) is
//                                         // GENERATED into the stage's #viewbar, before #theme
//                                         // behind a divider (the bar's appearance group); a
//                                         // stage with no #viewbar gets it over the view cube's
//                                         // bottom-right corner instead. Its popover holds the
//                                         // style (CAD or a realistic environment, as live
//                                         // thumbnails). Hosts need no markup
//                                         // for it — the old elements.chrome.realistic /
//                                         // .environment (#realistic, #environment) are gone. A
//                                         // host can still drive runtime.renderMode /
//                                         // .environment itself. The preferences persist like the
//                                         // theme (and carry in viewerState, which outranks what
//                                         // is stored). There is no projection control: see
//                                         // runtime.projection.
// Every `elements` entry defaults to the legacy global-ID lookup (below), resolved
// exactly once here — submodules take element refs and never query the document.
// `container`/`controls` remain as deprecated aliases for elements.viewer/.controls.
export function mount(part, { createWorker, elements = {}, onBuild, onPick, pickHint = "Click to edit", onDownload, onViewChange, onParamsCommit, onAnnotationSend,
                              fontCatalog,
                              imageCatalog,
                              onAssetUpload,
                              viewerState, preview,
                              files, panelState,
                              annotateSend = "viewbar",
                              selectionPopover,
                              cacheBudgetMB,
                              progressiveBuild = false,
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
    // Always-on hover inspection (no-op on touch-only devices). With onPick the
    // host acts on a click, so the tooltip nudges toward it with `pickHint`
    // (a host passes its own wording, or null for none).
    const hover = attachHoverLabels(viewer, { part, tooltip, hint: onPick ? pickHint : null });
    cleanup.defer(() => hover.detach());
    const ui = createStatusUi({ ...els.status, exports: [els.exports.stl, els.exports.step, els.exports.threeMf] });
    cleanup.defer(() => ui.setStatus(""));
    cleanup.defer(() => ui.hideBusy());

    // A cached preview (the `preview` option) is drawn before the kernel boots and
    // held to the camera only — no feature ids, no live solids behind it — until
    // the first whole live build replaces it. The gate is the flag, plus the
    // chrome it disables meanwhile; picking and hover consult it per event. See
    // the preview block just above `return makeHandle`.
    const previewGate = createPreviewGate({
      buttons: [els.chrome.cutaway, els.chrome.measure, els.chrome.annotate],
    });

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
    // String-namespaced ("tess-N"), mirroring capture-build.js's "cap-" ids —
    // this request shares the OCCT worker's message space with
    // export-controller's "export-"/"warm-" jobIds, and exportCtl.handleMessage
    // (called before mount's own switch, below) claims every id in its own
    // namespace before checking type. An id inside that namespace would let the
    // export controller wrongly claim this reply — rejecting an unrelated
    // export with the tessellation failure text, or dropping the reply, AND
    // leaving importMeshState stranded at "requested" (mount's own switch,
    // which would have reset it, never runs). The "tess-" prefix makes that
    // collision impossible.
    let importTessellateJobId = null;
    let importTessellateJobSeq = 0;

    // ?debug shows the cache debug overlay; ?debug&nocache starts with caching off.
    const qs = new URLSearchParams(location.search);
    const debug = qs.has("debug");
    let cachingOn = !(debug && qs.has("nocache"));
    // The host's bound on the worker's solid cache, sent with every generate (null =
    // unbounded). A phone host passes a small one: the cache of a very large view is
    // most of its heap (feedback #212). Anything but a positive finite number is ignored.
    const cacheBudgetBytes = Number.isFinite(cacheBudgetMB) && cacheBudgetMB > 0 ? Math.round(cacheBudgetMB * 2 ** 20) : null;
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
    // The popover's Parts section (attachViewStyleControls' `parts` seam) follows
    // the active view; declared here because tabsCtl's onChange reads it.
    const viewChangeListeners = new Set();
    const tabsCtl = createViewTabs(els.tabs, part, {
      onChange: (name) => {
        // FIRST: the outgoing animation restores its param snapshot, so the
        // incoming view composes its assembly from un-animated params. Anything
        // that reads params (refreshView / updateRelevance / the loop kick) must
        // run after it. autoplayKick stays LAST — it starts the new view's own.
        animCtl?.viewChanged();
        pendingPosed.clear(); cutawayChrome.reset(); refreshView();
        // place() may read `view`: re-pose the incoming view's canonical meshes
        // (and clear the posed ones' matrices) before anything else reads them.
        fastPath.apply(viewSubParts(part, view(), params));
        updateRelevance(); loop.kick(); animCtl?.autoplayKick();
        for (const cb of [...viewChangeListeners]) { try { cb(name); } catch { /* listener's problem */ } }
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
    // thunk. getReads reads the mesh cache (created further below) lazily.
    let panelRef = null;
    const measureMode = createMeasureMode(viewer, {
      part,
      getContext: () => ({ view: view(), params }),
      revealParams: (keys, focusKey) => panelRef?.revealParams(keys, focusKey),
      getReads: (name) => displayReadsOf(name),
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
    // Orientation cube (and the view style button). Generated chrome — no host markup
    // declares it, so an embedder gets it for free. The projection is restored
    // BEFORE any framing happens so a remount into ortho frames once instead of
    // framing in perspective and then visibly re-framing.
    //
    // The projection is AUTOMATIC (viewer.js's tweenCameraTo): orthographic
    // only on a face view, so it is not a preference and is not persisted —
    // a page reload opens in perspective. What IS restored is a carried
    // viewerState, because a host that remounts per edit (partforge-cloud)
    // would otherwise drop the user out of the face view they were in. Only
    // when the carried camera is itself a face view, though: an orthographic
    // state carried with a free-orbit camera (an older host's token, from
    // when projection was a manual toggle) comes back perspective. The camera
    // itself lands later (showView); setCameraState re-arms the ortho view on
    // it, so the first rotation still returns to perspective.
    viewer.setProjection(
      viewerState?.projection === "orthographic" && isFaceAlignedState(viewerState.camera)
        ? "orthographic"
        : "perspective",
    );
    // The environment by the same precedence (carried, stored, then the part's
    // own meta.environment — which the viewer already starts on, unchosen). A
    // carried or stored one was chosen, so it stays chosen and carries on. In
    // CAD this only records the id, so the realistic restore below loads the
    // right rig first time rather than the default and then this one.
    const initialEnv = viewerState?.environment ?? loadEnvironment();
    if (initialEnv) viewer.setEnvironment(initialEnv);
    // Carried display overrides, pruned for THIS part (materials/overrides.js):
    // a renamed sub-part's entry goes, and an appearance key that now equals the
    // authored value goes — which is how an owner's saved change self-cleans
    // after the remount that applied it. Restored before the first showView so
    // the first frame already draws the override, hidden pieces included.
    for (const [name, override] of Object.entries(pruneOverrides(viewerState?.display, part))) {
      viewer.setSubPartDisplay(name, override);
    }
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
    // The view style button + popover (the style grid). With a #viewbar
    // (looked up the same way sketchHides does) it joins the bottom toolbar's
    // appearance group, before #theme behind a divider, and its popover
    // closes when the bar hides (Sketch). Without one it falls back to the
    // cube's bottom-right corner, in the stack, hiding with the cube. It is
    // a #viewbar child, so --pf-viewbar-clear below measures it for free (the
    // bar grows wider, not taller).
    // The Parts seam (view-style-controls.js), shared with the selection
    // popover below; an older popover ignores it.
    const partsSeam = {
      list: () => subPartRows(part, { view: view(), params, overrides: viewer.getDisplayOverrides?.() ?? {} }),
      setDisplay: (name, patch) => viewer.setSubPartDisplay(name, patch),
      clear: (opts) => viewer.clearSubPartDisplay(opts),
      onChange: (cb) => viewer.onDisplayChange?.(cb) ?? (() => {}),
      onViewChange: (cb) => { viewChangeListeners.add(cb); return () => viewChangeListeners.delete(cb); },
      getState: (name) => viewer.getSubPartDisplayState(name),
    };
    const viewStyle = attachViewStyleControls(viewer, {
      stage: els.viewer,
      toolbar: els.viewer.querySelector("#viewbar"),
      anchor: viewcube.element,
      parts: partsSeam,
    }, { tooltip });
    cleanup.defer(() => viewStyle.detach());
    // The selection popover (spec 2026-10-14): opened by the picker below,
    // following the held pick marker. Only with onPick, and only for a host
    // that passed the option as an object.
    const selectionOpt = onPick && selectionPopover && typeof selectionPopover === "object"
      ? { slot: selectionPopover.slot === true } : null;
    let selPopover = null;
    let pendingSelection = null; // a carried selection waiting for its marker's first anchor
    // The marker's anchor is in canvas px; the popover lives in the stage.
    const toStage = (a) => {
      if (!a) return null;
      const s = els.viewer.getBoundingClientRect();
      const c = viewer.domElement.getBoundingClientRect();
      return { x: a.x + c.left - s.left, y: a.y + c.top - s.top, visible: a.visible !== false };
    };
    if (selectionOpt) {
      selPopover = attachSelectionPopover({
        stage: els.viewer, canvas: viewer.domElement, slot: selectionOpt.slot, parts: partsSeam,
        renderThumb: viewer.renderMaterialThumbnail ? (id, display) => viewer.renderMaterialThumbnail(display, { size: 96 }) : null,
        getSaveState: () => viewStyle.getSaveState?.() ?? "screen-only",
        // Every close lets the marker go. Its null anchor arrives with the
        // popover already closed, so the listener below ignores it.
        onClosed: () => viewer.releaseFlashPoints?.(),
        // Converted at every placement, not once per anchor: the canvas can
        // move within the stage (a dock inset) with no new anchor arriving.
        toStage,
      });
      cleanup.defer(() => selPopover.detach());
      cleanup.defer(viewer.onFlashAnchorChange?.((a) => {
        if (pendingSelection && a) {
          const carried = pendingSelection;
          pendingSelection = null;
          // Straight onto the carried page: one slot report, not open-then-collapsed.
          // A refusal lets go of the marker restoreCarriedSelection lit and held.
          if (!selPopover.open({ subPart: carried.subPart, anchor: a, page: carried.page })) viewer.releaseFlashPoints?.();
          return;
        }
        if (!selPopover.isOpen()) return;
        if (!a) { selPopover.close("gone"); return; }
        selPopover.setAnchor(a);
      }) ?? (() => {}));
      const closeGone = () => selPopover.close("gone");
      viewChangeListeners.add(closeGone);
      cleanup.defer(() => viewChangeListeners.delete(closeGone));
      // A mode that claims the canvas closes it (measureMode and annotateMode
      // are both created above).
      cleanup.defer(measureMode.onModeChange(() => { if (measureMode.isEnabled()) selPopover.close("gone"); }));
      if (annotateMode) cleanup.defer(annotateMode.onModeChange(() => { if (annotateMode.isEnabled()) selPopover.close("gone"); }));
    }
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
    cleanup.defer(observeViewbarClear(els.viewer, els.viewer.querySelector("#viewbar")));
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
      hover.setSuppressed(previewGate.isActive() || measureMode.isEnabled() || (annotateMode?.isEnabled() ?? false));
    cleanup.defer(measureMode.onModeChange(syncHoverSuppression));
    if (annotateMode) cleanup.defer(annotateMode.onModeChange(syncHoverSuppression));
    cleanup.defer(previewGate.onChange(syncHoverSuppression));
    // Deferred AFTER the cutaway/measure/annotate chrome attached, so at dispose
    // (LIFO) the gate hands the buttons back before those controls restore the
    // host's own attributes.
    cleanup.defer(() => previewGate.end());

    // Current selection context for the pickers: the active view + live params +
    // derived values. Shared by every pick mode below.
    const getContext = () => {
      let derived = {};
      // A throwing derive must not crash the pick flow — proceed without derived context.
      try { derived = resolveDerived(part, { ...part.defaults, ...params }); } catch { /* derived stays {} */ }
      return { view: view(), params, derived, readsOf: (name) => displayReadsOf(name) };
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
        suppressed: () => previewGate.isActive() || measureMode.isEnabled() || (annotateMode?.isEnabled() ?? false),
        onPick: (selection, anchor) => {
          onPick({
            selection,
            label: selection.feature?.label ?? part.parts[selection.subPart]?.label ?? selection.subPart,
            prompt: formatSelection(selection, { style: "prompt" }),
            token: formatSelection(selection, { style: "token" }),
            // Where the marker is on the canvas, in CSS px from its top-left, so
            // a host can put its own UI beside the dot on the first frame rather
            // than a round trip later.
            anchor,
          });
          // After the host has its chip: open at the spot, and keep the marker.
          if (selPopover && selPopover.open({ subPart: selection.subPart ?? null, anchor })) {
            viewer.holdFlashPoint?.();
          } else if (selPopover?.isOpen()) {
            // A pick it cannot show (slot-less, no listed sub-part) moves on from
            // the open one rather than leaving it, and its held dot, behind.
            selPopover.close("dismiss");
          }
        },
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
    let partialView = null;        // the view whose first build is shown in batches (showPartial)
    let partialCameraKept = false; // that build must not reframe on completion
    let cutawayRestored = false; // a carried cutaway, applied once — after any preview, never on one
    let selectionRestored = false; // a carried selection, tried once, after the camera
    function restoreCarriedSelection() {
      selectionRestored = true;
      const c = viewerState?.selection;
      if (!selPopover || !c || !Array.isArray(c.point) || c.point.length !== 3 || !c.point.every(Number.isFinite)) return;
      const subPart = typeof c.subPart === "string" ? c.subPart : null;
      if (subPart !== null && !partsSeam.list().some((r) => r.name === subPart && r.inView)) return;
      pendingSelection = { subPart, page: c.page === "appearance" ? "appearance" : "spot" };
      viewer.flashPoint(c.point);
      // hold() publishes the marker's anchor synchronously; the listener opens us.
      if (!viewer.holdFlashPoint?.()) pendingSelection = null;
    }

    // Per-sub-part cache-validity tracker (Layer 1): view/version/caching change over
    // time, so they're passed as getters; params is a stable in-place-mutated object.
    const cache = createMeshCache(viewer, {
      params,
      getView: view,
      getParamsVersion: () => loop.version(),
      isCaching: () => cachingOn,
    });
    const isCurrent = cache.isCurrent;
    // Recorded reads for DISPLAY consumers (panel dimming, pickers, measure,
    // controlsFor). A mesh the cache stamped every-param (its reply carried no
    // reads) answers every param key, so the ladder never falls back to the
    // probe for it; only a sub-part with no stamp at all gets the prediction.
    // (cache.readsOf itself keeps null for both — the pose fast path needs that.)
    const displayReadsOf = (name) => cache.readsOf(name) ?? (cache.hasStamp(name) ? new Set(Object.keys(params)) : null);
    const missingParts = () => viewSubParts(part, view(), params).filter((n) => !isCurrent(n));

    // The regenerate state machine (ready gating / debounce / stale-redo) lives in
    // regen-loop.js; this send callback is the one place a build job is dispatched.
    // Routing is per SUB-part: the missing set splits by backend and each group goes
    // to its own worker in parallel, so a mixed part previews its plain sub-parts at
    // Manifold speed while only the OCCT-routed ones wait. The return value is
    // the job count — the loop holds the cycle open until every group has replied.
    // Each dispatched sub-part remembers the { view, params } its job was sent with
    // (`dispatched`): the frames the realistic look reads must describe the geometry
    // that job builds, and a delivery shown during playback was built at params the
    // live ones have already left (see recordFrames). One cycle is in flight at a time,
    // so a sub-part's entry is its in-flight job's until the cycle's last reply.
    const dispatched = new Map(); // sub-part -> { view, params } its latest job was sent with
    let updateRelevance = () => {}; // assigned once the panel exists; message handlers call it
    const loop = createRegenLoop({
      missingParts,
      send: (missing) => {
        const needed = viewSubParts(part, view(), params);
        // for the overlay; this build reports the poses repaired in its own cycle.
        lastGen = { skipped: needed.length - missing.length, rebuilt: missing.length, posed: pendingPosed.size };
        pendingPosed.clear(); // consumed — never counted against a second build
        const at = { view: view(), params: { ...params } };
        for (const n of missing) dispatched.set(n, at);
        ui.showBusy("generating");
        const backends = backendPolicy.backendsFor(params);
        let jobs = 0;
        for (const backend of ["manifold", "occt"]) {
          const subparts = missing.filter((n) => (backends[n] ?? "manifold") === backend);
          if (subparts.length === 0) continue;
          service.send({ type: "generate", subparts, view: view(), params, cache: cachingOn, cacheBudget: cacheBudgetBytes, ...(progressiveBuild ? { progressive: true } : {}) }, backend);
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

    // ?debug: how the in-view meshes were delivered, e.g. "3 canonical / 1 posed".
    const frameSummary = () => {
      const n = { canonical: 0, posed: 0 };
      for (const name of viewSubParts(part, view(), params)) {
        const f = cache.frameOf(name);
        if (f in n) n[f]++;
      }
      return `${n.canonical} canonical / ${n.posed} posed`;
    };

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
    // A carried cutaway goes back on once, and never onto a cached preview: the
    // section needs live solids to cut. `cam` is the pose to place again after
    // it (an ortho face view's size is matched at the surface the cut decides).
    function restoreCarriedCutaway(cam) {
      cutawayRestored = true;
      if (viewerState?.cutaway?.enabled && viewer.setCutawayState?.(viewerState.cutaway)) {
        cutawayChrome.sync(); // the button was not what turned it on
        if (cam) viewer.setCameraState(cam);
      }
    }

    function showView(needed) {
      let frame = view() !== framedView;
      // A first build shown in batches (showPartial) completes: frame the whole view now,
      // unless the user moved the camera meanwhile or a restored camera stands.
      if (partialView === view()) {
        partialView = null;
        if (frame && partialCameraKept) { frame = false; framedView = view(); cameraRestored = true; }
      }
      viewer.showAssembly(needed, { frame });
      if (frame) {
        framedView = view();
        if (!cameraRestored) {
          // A carried camera beats the persisted one: it is this session's live
          // answer, where the stored one is the last page-reload's — and it is
          // also the accurate one, since the persisted pose is only written at
          // the end of an orbit drag. An orthographic restore above was made
          // only for a face-view camera, and this is the call that re-arms it.
          const cam = viewerState?.camera ?? loadCamera();
          if (cam) viewer.setCameraState(cam);
          cameraRestored = true;
          // The cutaway goes back on AFTER the camera and only here, on the
          // first accepted build: enabling it needs the sub-parts registered
          // and real bounds to size the plane against, neither of which exists
          // until showAssembly above has run. (Its initial pose also reads the
          // camera direction, so a restore before the camera would seed the
          // fallback pose from the wrong view.) A cached preview defers it to
          // the live build below.
          if (!previewGate.isActive()) restoreCarriedCutaway(cam);
        }
      }
      if (cameraRestored && !cutawayRestored && !previewGate.isActive()) {
        // The preview held the cut back and the live build is in. Re-place the
        // camera the user is looking at NOW — they may have orbited the preview
        // — not the carried one.
        restoreCarriedCutaway(viewer.getCameraState());
      }
      if (cameraRestored && !selectionRestored && !previewGate.isActive()) restoreCarriedSelection();
    }

    // Frames the realistic look reads, for the geometry just delivered:
    //  - print frames for the layer-line pattern: the display → export map, so layers run
    //    the way the part is printed rather than the way it is displayed. Only sub-parts
    //    whose material draws layer lines have one — which includes every sub-part naming
    //    no material, since realistic mode shows those as PLA (resolve.js) — except a laser
    //    sheet part, which it shows as its stock (sheet-look.js realisticDisplay). One
    //    without a place() is identity at once; one with it costs two geometry-free probe
    //    builds.
    //  - sheet frames for the burn pass (materials/sheet-look.js): a laser sheet in a wood,
    //    mapped back into its canonical frame — from data, no probe.
    // Each describes the delivered mesh (which a later pose-only repair only moves).
    // Which sub-parts need frames is read off the EFFECTIVE display at the time
    // the frames are computed, not fixed at mount: a live material change (the
    // Parts section) can turn a plain piece into a layer-lined print, and it
    // must get its print frame without a rebuild. So every delivery's
    // dispatch record is kept (one small object per sub-part), and computeFrames
    // decides per name.
    const effectiveSubPart = (n) => ({ ...part.parts[n], display: viewer.effectiveDisplayOf?.(n) ?? part.parts[n].display });
    const isLayerLined = (n) => {
      try { return resolveMaterial(realisticDisplay(effectiveSubPart(n))).params.pattern === "layer-lines"; } catch { return false; }
    };
    // A burning laser sheet, or a canonical sheet part (laser or routed) in plywood.
    const isBurning = (n) => wantsSheetFrame(effectiveSubPart(n));
    // LAZY: a delivery only records the view and params its job was DISPATCHED with
    // (`dispatched`, set where the loop sends) — not the live ones, which a delivery shown
    // during playback was never built at; the viewer pulls the frames (computeFrames)
    // when it is about to draw the realistic look — live, loading, or borrowed by a
    // capture — so a CAD-only session computes nothing (viewer.js setFrameSource). The
    // snapshot keeps a late computation describing the mesh actually delivered.
    const printFrames = {};
    const sheetFrames = {};
    const deliveredAt = new Map(); // sub-part -> { at: { view, params }, frame } of its delivered mesh (kept, not consumed)
    const undrawnFrames = new Set(); // sub-part names whose frames are stale
    // The (print, burn) pair each name's frames were last computed for. A display
    // change re-stales a name only when its pair flips — hide, show, opacity and a
    // swap between two layer-lined (or two burning) materials leave the frames
    // valid, so a see-through drag in realistic mode never re-probes a placed piece.
    const frameNeeds = new Map();
    const needsKey = (n) => `${isLayerLined(n) ? 1 : 0}${isBurning(n) ? 1 : 0}`;
    // `meshes` are the reply's deliveries: each one's `frame` ("canonical" | "posed"; an older
    // worker sends none, so posed) rides beside the view/params so the frames describe it.
    function recordFrames(meshes) {
      for (const m of meshes) {
        deliveredAt.set(m.name, { at: dispatched.get(m.name) ?? null, frame: m.frame ?? "posed" }); // at null: built at params nobody recorded
        undrawnFrames.add(m.name);
      }
      viewer.invalidateFrames?.();
    }
    function computeFrames() {
      const resolvedFor = new Map(); // one resolveParams per delivery, not per sub-part
      for (const n of undrawnFrames) {
        const rec = deliveredAt.get(n);
        if (!rec) continue;
        const { at, frame } = rec;
        const needPrint = isLayerLined(n), needBurn = isBurning(n);
        frameNeeds.set(n, `${needPrint ? 1 : 0}${needBurn ? 1 : 0}`);
        if (!needPrint && !needBurn) { delete sheetFrames[n]; continue; }
        if (at && !resolvedFor.has(at)) {
          try { resolvedFor.set(at, resolveParams(part, at.params)); } catch { resolvedFor.set(at, null); } // diagnosed by the build
        }
        const resolved = at ? resolvedFor.get(at) : null;
        // No params to frame this mesh by: a burning sheet draws plain wood rather than
        // keep a frame that describes other geometry — a sub-millimetre lag along its
        // normal is enough to char a whole face. A print frame keeps its last value (the
        // worst it can do is run layer lines the wrong way).
        if (!resolved) { delete sheetFrames[n]; continue; }
        // For a views-map sub-part the export pose is the build itself (plus a sheet pose), so a canonical
        // delivery's print frame is identity — no special case, the probe reads the compiled placement.
        if (needPrint) printFrames[n] = printFrameMatrix(part.parts[n], { view: at.view, ...resolved, frame });
        if (needBurn) {
          const f = sheetFrameFor(part.parts[n], { ...resolved, frame });
          if (f) sheetFrames[n] = f; else delete sheetFrames[n];
        }
      }
      undrawnFrames.clear();
      return { print: { ...printFrames }, sheet: { ...sheetFrames } };
    }
    // A display change re-stales a delivered sub-part's frames when it changes
    // WHICH frames that piece needs (frameNeeds above); a `null` event (a clear)
    // re-checks every delivered name. computeFrames stays lazy (viewer.js
    // syncFrames), so a CAD-only session still computes nothing.
    cleanup.defer(viewer.onDisplayChange?.((evt) => {
      let stale = false;
      for (const n of evt?.name ? [evt.name] : deliveredAt.keys()) {
        if (!deliveredAt.has(n) || undrawnFrames.has(n)) continue; // nothing drawn yet, or already stale
        if (frameNeeds.get(n) === needsKey(n)) continue;
        undrawnFrames.add(n);
        stale = true;
      }
      if (stale) viewer.invalidateFrames?.();
    }) ?? (() => {}));
    viewer.setFrameSource?.(computeFrames);

    // Sub-parts whose latest fresh delivery had zero triangles (see the `meshes` case).
    const emptySubParts = new Set();
    // Any live delivery has landed. A preview decoded after this is dropped unseen.
    let liveDelivered = false;

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
      } else if (previewGate.isActive()) {
        // A cached preview that covers only part of the view: show what it has.
        showView(needed.filter((n) => viewer.hasSubMesh(n)));
        ui.setExportEnabled(false);
      } else {
        viewer.hideAssembly();
        ui.setExportEnabled(false);
      }
    }

    // Apply a delivery built at the LIVE params — a final `meshes` whose build is still
    // fresh, or a progressive batch (meshes-partial) of a build that still is.
    function applyFreshMeshes(meshes) {
      liveDelivered = true; // only a delivery that is applied beats a preview still decoding
      for (const m of meshes) {
        viewer.setSubGeometry(m.name, m); // disposes any previous mesh for this name
        // The view its job was SENT for, and the frame the worker delivered
        // in: "canonical" (place() not applied — mount poses it below) or
        // "posed". An older worker sends no frame; its meshes are posed.
        cache.record(m.name, m.reads, dispatched.get(m.name)?.view ?? view(), m.frame ?? "posed");
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
      // setSubGeometry reset every delivered mesh's matrix, so each one gets
      // its display pose now, after its geometry landed: a canonical mesh
      // place() at the live params, a posed one a cleared matrix. `fresh`:
      // an untrusted live place() here clears the pose but keeps the stamp
      // (host and worker probes agree by construction at these params;
      // forgetting on a disagreement would rebuild at the same params forever).
      fastPath.apply(meshes.map((m) => m.name), undefined, { fresh: true });
      recordFrames(meshes);
    }

    // Progressive delivery (feedback #212). A view with many sub-parts posts what it has
    // built in batches while the job runs, and the view fills in as they land. Framing is
    // the one hazard: showView frames once per view, and framing to the first batch
    // would leave a park's camera zoomed in on five plates. So a first build with nothing
    // on screen frames to the first batch, and showView frames the whole view when the
    // build completes — unless the user has moved the camera since, or a carried or
    // persisted camera was restored, which win as they always have.
    cleanup.defer(viewer.onCameraStart(() => { if (partialView === view()) partialCameraKept = true; }));
    function showPartial() {
      const needed = viewSubParts(part, view(), params);
      // Everything already on screen (an edit), or a cached preview filling the
      // gaps: the ordinary path shows it.
      if (previewGate.isActive() || needed.every((n) => viewer.hasSubMesh(n))) return refreshView();
      const present = needed.filter((n) => viewer.hasSubMesh(n));
      let frame = false;
      if (view() !== framedView && partialView !== view()) {
        partialView = view();
        partialCameraKept = false;
        const cam = !cameraRestored ? viewerState?.camera ?? loadCamera() : null;
        if (cam) { viewer.setCameraState(cam); cameraRestored = true; partialCameraKept = true; }
        else frame = true;
      }
      viewer.showAssembly(present, { frame });
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
      // Like exportCtl, it also claims a disposed mount's late capture reply on
      // a worker the host kept, so a stale "error" never reads as a failed build.
      if (captureBuild.handleMessage(data)) return;
      switch (data.type) {
        case "ready":
          loop.ready(); // auto-build the default view (keeps the busy spinner up)
          break;
        case "progress":
          ui.showBusy(data.phase);
          ui.setStatus(`${data.phase}…`);
          break;
        case "meshes-partial":
          // A batch of a progressive build: shown only while that build is still
          // current. It settles nothing — the job's final `meshes` does.
          if (!loop.isFresh()) break;
          applyFreshMeshes(data.meshes);
          showPartial();
          updateRelevance();
          break;
        case "meshes": {
          const fresh = loop.buildDone();
          if (fresh) { // stale results (params changed mid-build) are discarded
            applyFreshMeshes(data.meshes);
            // The whole view is live: every sub-part the preview drew has just been
            // replaced in place, so the tools it held back come back. Before
            // refreshView, so showView restores a carried cutaway on this build.
            if (previewGate.isActive() && missingParts().length === 0) previewGate.end();
            // A split dispatch answers in two meshes replies; the busy spinner
            // stays up until the view has everything (the other worker's job may
            // still be running — often OCCT, the slow one).
            if (missingParts().length === 0) ui.hideBusy();
            refreshView();
            updateRelevance(); // dimming follows each delivery's recorded reads
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
            dbg?.update({ ms: data.ms, hits: data.cache?.hits ?? 0, misses: data.cache?.misses ?? 0, skipped: lastGen.skipped, rebuilt: lastGen.rebuilt, posed: lastGen.posed, frame: frameSummary() });
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
            // but record nothing about the LIVE params. Cache and fast-path stamps
            // must describe geometry built at the live params, and this delivery
            // wasn't; the fast-path stamp is dropped too, so a later pose-only
            // repair can never re-pose this newer geometry off an older delivery's
            // stamp. Its material frames are the exception: those are recorded
            // against the params its job was dispatched with, which is what it was
            // built at — keeping the last fresh delivery's frame instead would lay a
            // sheet's burn over geometry that has moved along its normal.
            // A user edit mid-play pauses playback and bumps the version WITHOUT
            // touching lastAnimApplyVersion, so a genuinely user-stale result
            // fails this test and is discarded exactly as before.
            for (const m of data.meshes) {
              viewer.setSubGeometry(m.name, m);
              fastPath.forget(m.name);
              cache.forget(m.name); // the stamp described the last FRESH delivery; this mesh was built at other params, so no stamp may describe it (spec §2)
            }
            // With the stamps gone the frame comes from the reply: a canonical
            // mesh is posed by place() at the LIVE params (a rigid place() needs
            // no geometry at those params), or cleared when the probe is untrusted.
            fastPath.apply(data.meshes.map((m) => m.name),
              Object.fromEntries(data.meshes.map((m) => [m.name, m.frame ?? "posed"])));
            recordFrames(data.meshes);
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
      organicFor: ({ view: v, params: q, parts }) => organicExportParts(part, { view: v, params: q, parts }),
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
    updateRelevance = () => {
      // A throwing derive() must not break every slider drag — mount's pick
      // flow already guards its own resolveDerived call the same way
      // (mount.js ~:250). Readouts simply stay em-dashed.
      let derived = {};
      try { derived = resolveDerived(part, params); } catch { /* diagnosed by lint/build */ }
      panel.refresh({ relevant: recordedRelevantKeys(part, view(), params, displayReadsOf), derived });
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

    // Through the export controller, which runs a part with organic sub-parts in two legs
    // (mesh them on Manifold, then write on OCCT) and a plain one as the single OCCT job.
    const onStepClick = () => {
      ui.showBusy("exporting STEP");
      exportCtl.exportParts({
        format: "step",
        onProgress: (phase) => { ui.showBusy(phase); ui.setStatus(`${phase}…`); },
      }).then(() => {
        ui.hideBusy();
        ui.setStatus("STEP downloaded");
      }, (e) => {
        ui.hideBusy();
        ui.setStatus(`failed: ${e?.message ?? e}`, true);
      });
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
    // renderMeshPayloads' own options (including `background` and
    // `style`: "thumbnail" by default, "cad" for the agent look) pass straight
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

    // Set by the first cleanup to run at dispose (LIFO): late async work checks it.
    let disposed = false;
    cleanup.defer(() => { disposed = true; });

    // The cached preview: a GLB from partforge/gltf, decoded off the worker path
    // and drawn through setSubGeometry like any delivery — so the first live
    // `meshes` reply replaces it in place, sub-part by sub-part, and showView
    // keeps the camera (the view was already framed). Only a file for the view on
    // screen is drawn, and only its sub-parts of that view; anything else — or a
    // file that will not decode — is logged once and ignored.
    if (preview != null) {
      // Loaded on demand: the GLTFLoader and meshopt decoder behind it stay out
      // of every bundle that never passes a preview.
      import("./gltf/decode-preview.js").then(({ decodePreviewGlb }) => (
        disposed ? null : decodePreviewGlb(preview)
      )).then((decoded) => {
        if (decoded == null) return;
        const { view: previewView, meshes } = decoded;
        if (disposed || liveDelivered) return; // live geometry always wins
        const current = view();
        if (previewView != null && previewView !== current) {
          console.warn(`partforge: preview ignored — it shows view "${previewView}", the viewer opened on "${current}"`);
          return;
        }
        const needed = viewSubParts(part, current, params);
        const shown = meshes.filter((m) => needed.includes(m.name));
        if (shown.length === 0) {
          console.warn("partforge: preview ignored — none of its meshes is a sub-part of the view on screen");
          return;
        }
        measureMode.setEnabled(false);
        annotateMode?.setEnabled(false);
        previewGate.start();
        for (const m of shown) viewer.setSubGeometry(m.name, m);
        refreshView();
      }).catch((error) => {
        if (!disposed) console.warn(`partforge: preview ignored — ${error?.message ?? error}`);
      });
    }

    // runtime.exportPreview: the view on screen as a preview GLB — every sub-part's
    // drawn mesh with its fast-path pose baked in, the posed meshes a headless
    // buildView returns. Only the view on screen (no other view's meshes are held),
    // only when it is fully built at the live params (missingParts covers both a
    // first build and an edit still rebuilding), never a cached preview. The
    // view's autoplay animation rides along as channels when every track is
    // place-only (samplePreviewAnimation decides; otherwise the file is still).
    // The encoder loads on first use: a host that never exports never pays for it.
    async function exportPreview({ view: wanted } = {}) {
      if (disposed) throw new Error("exportPreview: this mount is disposed");
      if (previewGate.isActive()) throw new Error("exportPreview: a cached preview is showing — wait for the first build");
      const current = view();
      if (wanted != null && wanted !== current) {
        throw new Error(`exportPreview: "${wanted}" is not the view on screen ("${current}")`);
      }
      const needed = viewSubParts(part, current, params);
      if (needed.length === 0 || missingParts().length > 0) {
        throw new Error("exportPreview: the view on screen is not fully built");
      }
      const meshes = needed.map((name) => viewer.getSubMeshPayload(name)).filter(Boolean);
      // The view's autoplay animation, sampled at the params the meshes above were
      // built at. Build reads come from the cache's stamps; null (no stamp, or an
      // every-param stamp) is unknown, so the animation is left out.
      const animation = samplePreviewAnimation(part, current, params, {
        buildReads: (name) => (cache.hasStamp(name) ? cache.readsOf(name) : null),
      });
      const { encodePreviewGlb } = await import("./gltf/encode-preview.js");
      return encodePreviewGlb({ meshes, part, view: current, ...(animation ? { animation } : {}) });
    }

    return makeHandle({
      ready, dispose, viewer, setParams,
      isPreviewActive: () => previewGate.isActive(),
      pendingCutaway: () => (!cutawayRestored ? viewerState?.cutaway ?? null : null),
      exportPreview,
      attachTooltips: attachHostTooltips,
      setHostPane: paneTabs.setHostPane,
      setRailLayout: paneTabs.setRailLayout,
      getView: view,                         // () => tabsCtl.current()
      // `opts` may be null from a host (a destructuring default covers only undefined).
      listSubParts: (opts) => subPartRows(part, { view: opts?.view ?? view(), params, overrides: viewer.getDisplayOverrides?.() ?? {} }),
      openAppearance: (name) => viewStyle.openCard?.(name) ?? false,
      setDisplaySaveState: (state) => { viewStyle.setSaveState?.(state); selPopover?.refreshSaveState(); },
      selection: selPopover ? {
        setSlotHeight: (px) => selPopover.setSlotHeight(px),
        onSlotChange: (cb) => selPopover.onSlotChange(cb),
        onClose: (cb) => selPopover.onClose(cb),
        close: () => selPopover.close(),
        isOpen: () => selPopover.isOpen(),
      } : null,
      selectionState: () => {
        const st = selPopover?.getState();
        const point = st ? viewer.getHeldAnchorPoint?.() : null;
        return st && point ? { subPart: st.subPart, point, page: st.page } : null;
      },
      setView: (name) => tabsCtl.select(name),
      captureView,
      getPanelState: () => panelRef?.getState() ?? {},
      getPanelErrors: () => panelRef?.errors() ?? [],
      // The param keys relevant to a pick — today the clicked sub-part's recorded
      // reads (spec §5). The one place a host asks "which controls shape this?".
      controlsFor: (selection) => subPartParamKeys(part, view(), params, displayReadsOf, selection?.subPart),
      // A sheet part's row carries its stock, evaluated here on the main thread at the
      // live params the way enabled() is, and omitted when it cannot be (export-rows.js).
      listExportableParts: () => exportableRows(part, params),
      listExportFormats: exportFormatList,
      exportParts: (opts) => exportCtl.exportParts(opts),
      warmExportKernel: () => exportCtl.warmKernel(),
      animation: animCtl?.runtime ?? null,
      measure: {
        isEnabled: measureMode.isEnabled,
        // Held off while a cached preview shows (no feature ids to dimension).
        setEnabled: (on) => { if (on && previewGate.isActive()) return; measureMode.setEnabled(on); },
        clearPins: measureMode.clearPins,
        pinCount: measureMode.pinCount,
      },
      annotate: annotateMode ? {
        isEnabled: annotateMode.isEnabled,
        setEnabled: (on) => { if (on && previewGate.isActive()) return; annotateMode.setEnabled(on); },
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
