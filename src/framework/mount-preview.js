// mountPreview: the kernel-free viewer. A cached preview GLB (partforge/gltf) in
// the SAME viewer mount() uses — scene, camera, lights, materials, the view cube,
// the view style and the theme — with no part source, no worker, no rail, no
// export and no picking. For a page that only shows a model (partforge-cloud's
// public forge page).
//
// createViewer needs a part's sub-part names at construction, so the viewer is
// built once the GLB has decoded, from a synthetic part: one sub-part per glTF
// mesh, carrying the `display` block the writer stored beside it, and the file's
// background/environment meta. The CAD look is exact; realistic mode uses each
// sub-part's display only — no sheet stock, no layer-line print frames (a
// residual of the format). CAD feature edges come from the file (encoder
// version 2, sharing the surface's vertices since version 3); a version-1 file
// decodes with none.
//
// A file that carries a baked autoplay animation (encoder version 4) plays it
// once drawn, through preview-player.js — poses, opacities and camera cues off
// the viewer's own frame loop, still with no part code. `animate: false` shows
// the opening pose and no player (the editor's own boot preview goes through
// mount(), not here). Under prefers-reduced-motion the player never starts: the
// file's opening pose, every sub-part opaque, nothing moves. Parking
// (setActive(false)) stops the viewer's frame loop, and the player's clock with
// it, so a parked preview is a paused one. `handle.animation` is null once
// disposed.
//
// A playing animation also gets a play/pause/replay button in #viewbar,
// directly before the view style button (preview-play-button.js): Pause while
// it plays (or tweens to its intro view), Play while paused, Replay once a
// one-time animation has finished. No button under reduced motion, for a still
// file, with `animate: false`, or for a host with no #viewbar; the host can
// still drive `handle.animation` (state / pause / resume / replay) itself.
//
// Presentation options (0.168.0), each usable alone; every default is the
// viewer above, so a mount that names none is unchanged:
//  - `chrome: false` — no view cube, no #viewbar controls, no view style, no
//    tooltips, no play button and no `elements.chrome` wiring. A one-time
//    animation still holds its end pose; there is just no replay button.
//  - `background: "transparent"` — the canvas clears to alpha 0 with no theme
//    background and no grid, so the host page shows through. CAD mode ONLY:
//    realistic mode draws its own environment backdrop (pair it with
//    `renderMode: "cad"` to open transparent).
//  - `contactShadow: true` — the product shot's soft contact shadow under the
//    part. CAD mode ONLY: realistic mode draws its own ground and shadow. Cast
//    once, at showAssembly, from the meshes as the file stores them (the rest
//    pose, before a player applies its first pose); a playing animation does
//    not move it.
//  - `zoom: false`, `pan: false` — those orbit gestures are off (a wheel then
//    scrolls the page); orbiting stays on.
//  - `turntable: <degrees per second>` (default 0, off) — a file with no
//    playing animation (a still file, or `animate: false`) turns about the
//    vertical off the viewer's frame loop. Never under reduced motion; the
//    first camera grab — a canvas drag or the view cube, or a handle press with
//    `part` — stops it (until
//    `motion.restart()`). Dragging an animated model orbits the camera and the
//    animation plays on.
//  - `fill: <0 < f <= 1>` — the opening framing (and the viewer's reframe)
//    places the camera, along the kept view direction, so the model's posed
//    bounding box as projected on screen spans that fraction of the viewport
//    along its limiting axis. A turning model is framed swept a full turn
//    about the vertical (its farthest vertex from the axis), so the turntable
//    never clips and a round part still fills, centred on its horizontal
//    vertex centroid (a lopsided part turns about its hub). A model that is
//    not turning (a still, or a playing animation) is fitted by its posed
//    VERTICES and its silhouette centred on screen (0.169.0): the target moves
//    in the screen plane so the projected outline's bounding box is centred,
//    spanning `fill`. A playing animation is fitted over EVERY pose it passes
//    through (0.171.0; each part's outermost points at each keyframe), so a
//    part that swings out of its first pose's outline stays in frame — the
//    outline of all its poses together spans `fill`.
//    Unset, the viewer's fixed framing distance, as before.
//    The swept framing follows the configuration, not reduced motion (0.169.0):
//    a turntable mount is framed swept even when reduced motion keeps it still.
//  - `camera: "default"` — the camera and projection of `viewerState` and of
//    every setViewerState are dropped: the mount opens, and stays, at the
//    file's own default framing. Their render mode and environment still apply.
//  - `renderMode: "cad" | "realistic"` — the OPENING mode: applied at mount,
//    over any carried render mode. After that it is an ordinary mode —
//    setViewerState, renderMode.set and the view style control change it.
//    Unset, the carried state decides, as before.
//  - `autostart: false` (0.169.0; default true) — the motion (a playing
//    animation, or the turntable) is set up but WAITS: the model is drawn at
//    the animation's first pose (the t = 0 pose a started player draws first)
//    and at turntable angle 0, and nothing moves until `handle.motion.start()`.
//    `drawn` resolves on a frame showing exactly that pose, so a host can
//    cross-fade from a still of it and then say go. A waiting animation's play
//    button reads Play.
//  - `edgeWidth` (0.170.0; CSS px, 0 < w <= 8, default 1) and `edgeOpacity`
//    (0.170.0; 0 < o <= 1, default 1) — the CAD feature edge lines' thickness
//    and strength. A small preview card reads the default 1 px lines as heavy;
//    0.5 px is one device pixel on a 2x screen. Fixed for the mount.
//  Any other key throws (an option this version does not know is a host bug).
//
// `handle.motion` (0.169.0; null before ready and once disposed, present for
// every decoded file) drives the motion whatever `autostart` said:
//  - `start()` begins a waiting motion. Idempotent; a no-op once started, under
//    reduced motion, or with nothing to move.
//  - `restart()` puts the model back as it opened and starts it: the camera
//    returns to the opening framing (showAssembly's framing at mount — the
//    file's default view direction at the fill distance, before any carried
//    camera — so a visitor's orbit is undone), the animation replays from
//    t = 0 (intro cue included) or the turntable turns again from there,
//    re-armed so the next grab stops it again. Under reduced motion it only
//    resets the camera (the pose already is t = 0).
//  - `state` — "waiting" | "playing" | "stopped" (a turntable stopped by a
//    grab, an animation paused from its button, reduced motion, or nothing to
//    move) | "finished" (a play-once animation resting at its end pose).
//  - `onChange(cb)` → unsubscribe: hears each state change.
// `handle.animation` is unchanged.
//
// `handle.drawn` resolves after the first frame that includes the meshes has
// rendered (so a host can cross-fade from a still image without a flash). It
// rejects with `ready`'s error when the file will not decode, and rejects if
// the handle is disposed before that frame. A parked preview draws nothing, so
// `drawn` waits for setActive(true).
//
// `part` (0.186.0): the part module the file was written from. Pose mode then runs
// on the file's meshes, as the editor's does, with no kernel: every handle the editor
// would show in this view whose params move pieces by placement alone
// (preview-pose.js's previewHandles, decided in idle time after `drawn`) can be
// dragged, IK included. A drag writes the preview's own params — seeded from the
// file's (`getParams()`) — and re-poses each mesh by matrix (createFilePlacer); it
// edits nothing else. `handle.pose` is mount()'s pose surface plus `onDragEnd`;
// without `part` it is mount()'s no-op stand-in and `getParams()` is null. A file
// whose view the part does not declare gets nothing attached (warned once).
// While a baked animation plays, `getParams()` follows the player (the part's own
// animation at the player's t), so the handles ride the moving meshes; a press
// pauses it there and the drag starts from that pose (cancel returns to it). A
// press stops a turntable as a camera grab does. `motion.restart()` puts the
// params, and every mesh, back where the file put them first.
//
// The decoder loads on demand (it carries the
// GLTFLoader and meshopt), so a bundle that never mounts a preview never ships it.
// Hence `ready`. Every handle method is safe before it resolves.
import "./app.css";
import { createViewer } from "./viewer.js";
import { attachViewerControls } from "./viewer-controls.js";
import { attachViewcubeControls } from "./viewcube/viewcube-controls.js";
import { attachViewStyleControls } from "./view-style-controls.js";
import { observeViewbarClear } from "./viewbar-clear.js";
import { createTooltipPresenter } from "./tooltip.js";
import { isFaceAlignedState } from "./projection.js";
import { ENVIRONMENTS } from "./materials/environments.js";
import { createPreviewPlayer, animationPoses } from "./preview-player.js";
import { attachPreviewPlayButton } from "./preview-play-button.js";
import { NOOP_POSE } from "./mount.js";
import { createFilePlacer, previewHandles } from "./preview-pose.js";
import { createPoseMode } from "./pose/pose-mode.js";
import { attachPoseControls } from "./pose/pose-controls.js";
import { attachDragReadout } from "./pose/drag-readout.js";
import { attachReadoutChip } from "./pose/readout-chip.js";
import { withDeriveMemo } from "./derive-memo.js";
import { raycastViewer } from "./selection/raycast.js";
import { createPoseCollide } from "./pose/pose-collide.js";
import { createFeatureHighlight } from "./selection/feature-highlight.js";
import { normalizeCollisions } from "./collide/declaration.js";
import { viewAnimations, evaluate } from "./animation.js";

// A value the option does not know is a host bug: say so at the call rather
// than quietly showing the default.
function oneOf(name, value, allowed, fallback) {
  if (value === undefined) return fallback;
  if (!allowed.includes(value)) throw new TypeError(`mountPreview: ${name} must be ${allowed.map((a) => JSON.stringify(a)).join(" or ")}`);
  return value;
}
function flag(name, value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new TypeError(`mountPreview: ${name} must be a boolean`);
  return value;
}
const KNOWN_OPTIONS = new Set([
  "glb", "elements", "viewerState", "animate",
  "chrome", "background", "contactShadow", "zoom", "pan", "turntable", "fill", "camera", "renderMode",
  "autostart", "edgeWidth", "edgeOpacity", "part",
]);

function presentation({ chrome, background, contactShadow, zoom, pan, turntable, fill, camera, renderMode, autostart, edgeWidth, edgeOpacity }) {
  if (edgeWidth !== undefined && !(typeof edgeWidth === "number" && edgeWidth > 0 && edgeWidth <= 8)) {
    throw new TypeError("mountPreview: edgeWidth must be a number of CSS pixels above 0 and at most 8");
  }
  if (edgeOpacity !== undefined && !(typeof edgeOpacity === "number" && edgeOpacity > 0 && edgeOpacity <= 1)) {
    throw new TypeError("mountPreview: edgeOpacity must be a number above 0 and at most 1");
  }
  if (fill !== undefined && !(typeof fill === "number" && fill > 0 && fill <= 1)) {
    throw new TypeError("mountPreview: fill must be a number above 0 and at most 1");
  }
  if (turntable !== undefined && !(typeof turntable === "number" && Number.isFinite(turntable) && turntable >= 0)) {
    throw new TypeError("mountPreview: turntable must be degrees per second, 0 or more");
  }
  return {
    chrome: flag("chrome", chrome, true),
    transparent: oneOf("background", background, ["theme", "transparent"], "theme") === "transparent",
    contactShadow: flag("contactShadow", contactShadow, false),
    zoom: flag("zoom", zoom, true),
    pan: flag("pan", pan, true),
    turntable: turntable ?? 0,
    fill: fill ?? null,
    defaultCamera: oneOf("camera", camera, ["carry", "default"], "carry") === "default",
    renderMode: oneOf("renderMode", renderMode, ["cad", "realistic"], null),
    autostart: flag("autostart", autostart, true),
    edgeWidth: edgeWidth ?? 1,
    edgeOpacity: edgeOpacity ?? 1,
  };
}

// Turn the camera about the vertical at `degPerSec` until the first camera grab.
// It turns through viewer.orbitBy, which itself announces a camera grab — so the
// turntable's own steps are told apart from the user's by a flag held across
// the call. It begins "waiting" (angle 0, nothing moves) until start(); the
// first grab — while waiting or turning — stops it for good; restart() re-arms
// it and turns again from wherever the camera is now (the host has just put it
// back). `onChange` hears every phase change.
function createTurntable(viewer, container, degPerSec, onChange) {
  let turning = false, phase = "waiting", offFrame = null;
  const set = (next) => { if (next !== phase) { phase = next; onChange(); } };
  function step(dt) {
    // orbitBy's rate: a drag the full stage height is a full turn.
    const dx = ((degPerSec * dt) / 360) * Math.max(1, container.clientHeight || 1);
    if (!(dx > 0)) return;
    turning = true;
    try { viewer.orbitBy(dx, 0); } finally { turning = false; }
  }
  function halt() { offFrame?.(); offFrame = null; }
  // Stopped for good, until restart(): by a camera grab, or a handle press.
  function stop() { halt(); set("stopped"); }
  const offGrab = viewer.onCameraStart(() => {
    if (turning || phase === "stopped") return;
    stop();
  });
  return {
    phase: () => phase,
    stop,
    start() {
      if (phase !== "waiting") return;
      offFrame = viewer.onFrame(step);
      set("playing");
    },
    restart() {
      halt();
      offFrame = viewer.onFrame(step);
      set("playing");
    },
    dispose() { halt(); offGrab(); },
  };
}

// Pose mode on the file (`part`): the editor's pose mode (mount.js) over the file's
// meshes, its params the preview's own and every write re-posing by matrix. Pushes its
// teardown onto `cleanups`, pose mode's detach FIRST so it runs LAST (they pop LIFO),
// and every effect is a no-op once `isDisposed()`. Fills `preview` as it decides.
function attachPosing({ viewer, part, view, decoded, container, toolbar, tooltip, chrome, drawn, cleanups, isDisposed, cueBlocked, onDragEnd, preview, player, turntable, reducedMotion }) {
  const drawnNames = decoded.meshes.map((m) => m.name).filter((n) => Object.hasOwn(part.parts, n));
  const params = { ...(part.defaults ?? {}), ...(decoded.params ?? {}) };
  const fileParams = Object.freeze({ ...params });
  const placer = createFilePlacer(part, view, fileParams, drawnNames);
  const live = (fn) => (...args) => (isDisposed() ? undefined : fn(...args));

  // The params follow the player (spec §5). While the baked animation plays (or tweens
  // to its intro view) the meshes sit at the player's matrices, so getParams answers the
  // part's own animation at the player's t — Pose mode draws its dots from it, and a
  // press's session snapshots it, locates its pins and builds its guard from it, all
  // BEFORE hold(true). Nothing is written while it plays. Once it stops — paused by a
  // press (hold), by its button, or done — the preview's own params take those values,
  // so getParams keeps answering what the meshes show.
  const anim = player && decoded.animation ? viewAnimations(part).get(view)?.find((a) => a.autoplay) ?? null : null;
  const following = () => {
    if (!player || !anim || reducedMotion || !player.started()) return false;
    const { status } = player.state();
    return status === "playing" || status === "intro";
  };
  const atPlayer = (t) => ({ ...fileParams, ...evaluate(anim, t).values });
  const getParams = () => (following() ? atPlayer(player.state().t) : params);
  let holding = false; // the pause hold() makes writes its own params
  // A press: a turning model stops; a playing animation pauses where it is, its params
  // written, so the placer's next apply finds every matrix where the player left it.
  const hold = live((on) => {
    if (!on) return;
    turntable?.stop();
    if (!following()) return;
    const { t } = player.state();
    holding = true;
    try { player.pause(); } finally { holding = false; }
    Object.assign(params, atPlayer(t));
  });
  // The session snaps on release (and the chip wraps), so a write takes values as given.
  const write = live((values) => {
    Object.assign(params, values);
    withDeriveMemo(() => placer.apply(viewer, params));
    viewer.requestRender();
  });
  // `showOn`: the sub-part under the last pointermove, raycast when asked (once per point).
  let pointer = null, hovered = null;
  const onMove = (ev) => { pointer = { x: ev.clientX, y: ev.clientY }; hovered = undefined; };
  const hoveredSubPart = () => {
    if (!pointer) return null;
    if (hovered === undefined) hovered = raycastViewer(viewer, pointer.x, pointer.y)?.subPart ?? null;
    return hovered;
  };
  let lastDragEnd = null;
  // The editor's collision index (mount.js's), over the file's meshes: only for a part
  // whose `collisions` block leaves Pose mode on, so any other loads no BVH.
  let poseCollide = null;
  const poseMode = createPoseMode(viewer, {
    part,
    orbitControls: viewer.orbitControls,
    getParams,
    write,
    restore: write,
    // onDragEnd's listeners are pose mode's own; this only keeps the __lastDragEnd hook.
    commit: live((changed) => { lastDragEnd = { changed }; }),
    staleSubParts: () => [], // nothing rebuilds: a shown handle is place-only
    ghost() {},
    unghost() {},
    hold,
    collide: (args) => poseCollide?.guardFor(args) ?? null,
    onBlocked: live((pair) => poseCollide?.tint(pair)),
    visibleHandles: () => preview.visible?.shown ?? [],
    hoveredSubPart,
    cueBlocked,
  });
  cleanups.push(() => poseMode.detach());
  // A pause from the button (or the end of a one-time animation) writes the player's
  // params, so a later press finds them in place; hold's own pause writes them itself.
  if (anim) {
    cleanups.push(player.onChange(({ status, t }) => {
      if (holding || isDisposed() || reducedMotion) return;
      if (status === "paused" || status === "done") Object.assign(params, atPlayer(t));
    }));
  }
  viewer.domElement.addEventListener("pointermove", onMove);
  cleanups.push(() => viewer.domElement.removeEventListener("pointermove", onMove));
  cleanups.push(poseMode.onDragEnd((e) => { lastDragEnd = e; onDragEnd(e); }));
  let readout = null;
  if (chrome) {
    const controls = attachPoseControls(viewer, poseMode, { viewbar: toolbar }, { tooltip });
    cleanups.push(() => controls.detach());
    const pill = readout = attachDragReadout(poseMode, { viewbar: toolbar });
    cleanups.push(() => pill.detach());
  }
  const chip = attachReadoutChip(viewer, poseMode, { stage: container }, { part, getParams, apply: (values) => write(values) });
  cleanups.push(() => chip.detach());

  // Every mesh the file draws is in its own canonical frame — the placer poses each by a
  // matrix relative to it — so each is indexable as it stands. Disposed before the viewer
  // (and before pose mode's detach), since its tint highlights live in the viewer's scene.
  if (normalizeCollisions(part)?.pose) {
    const pc = createPoseCollide({
      part, viewer, fastPath: placer, getView: () => view, getParams,
      isLive: () => poseMode.isLive(), frameOf: () => "canonical", createHighlight: createFeatureHighlight,
    });
    poseCollide = pc;
    cleanups.push(() => pc.dispose());
    // indexing waits while Pose mode is not live: going live indexes what the file shows
    cleanups.push(poseMode.onModeChange(live(() => { if (poseMode.isLive()) pc.refresh(); })));
    pc.delivered(drawnNames); // showAssembly drew them: the one delivery a preview gets
  }

  // Which handles may show is decided off the first frame's path: in idle time once drawn.
  const idle = (cb) => (typeof requestIdleCallback === "function" ? requestIdleCallback(cb) : setTimeout(cb, 0));
  drawn.then(() => idle(() => {
    if (isDisposed()) return;
    preview.visible = previewHandles(part, view, fileParams, drawnNames);
    poseMode.refresh();
    viewer.requestRender();
  }), () => {});

  Object.assign(preview, { params, fileParams, placer, poseMode, poseCollide });
  return {
    poseMode,
    getParams,
    // motion.restart(): every mesh back where the file put it (pins stay).
    resetParams: live(() => write(fileParams)),
    dragReadout: () => readout?.text() ?? null,
    lastDragEnd: () => (lastDragEnd ? { ...lastDragEnd } : null),
  };
}

function previewPart({ meshes, view, meta }) {
  return {
    meta: { title: "Preview", ...(meta ?? {}) },
    defaults: {},
    parameters: [],
    views: { [view]: { label: view } },
    parts: Object.fromEntries(meshes.map((m) => [m.name, {
      label: m.name,
      views: [view],
      ...(m.display ? { display: m.display } : {}),
    }])),
  };
}

// mount()'s no-op pose, plus the onDragEnd the preview's pose surface always carries.
const NOOP_PREVIEW_POSE = Object.freeze({ ...NOOP_POSE, onDragEnd: () => () => {} });

const relay = (listeners) => (event) => {
  for (const cb of [...listeners]) {
    try { cb(event); } catch (error) { console.warn("partforge: preview listener failed", error); }
  }
};

export function mountPreview(container, options = {}) {
  if (!container) throw new TypeError("mountPreview: a container element is required");
  for (const key of Object.keys(options ?? {})) {
    if (!KNOWN_OPTIONS.has(key)) throw new TypeError(`mountPreview: unknown option "${key}"`);
  }
  const { glb, elements = {}, viewerState = null, animate = true, part = null } = options ?? {};
  if (part !== null && !(part && typeof part === "object" && part.parts && typeof part.parts === "object")) {
    throw new TypeError("mountPreview: part must be a PartDefinition");
  }
  const opts = presentation(options ?? {});
  // A carried state as this mount applies it: under camera: "default" without
  // its camera and projection (render mode and environment still carry).
  const carry = (state) => {
    if (!state || !opts.defaultCamera) return state ?? null;
    const { camera: _camera, projection: _projection, ...rest } = state;
    return rest;
  };
  let disposed = false;
  let active = true;
  // Applied once the viewer exists, and on every setViewerState. The opening
  // render mode, when one is named, wins over the carried one at mount only.
  let carried = carry(viewerState);
  if (opts.renderMode) carried = { ...(carried ?? {}), renderMode: opts.renderMode };
  let live = null;                   // { viewer, view } once the GLB has decoded
  let player = null;                 // the baked animation's player, once drawn
  let motion = null;                 // handle.motion, once the GLB has decoded
  const motionListeners = new Set();
  const dragEndListeners = new Set(); // handle.pose.onDragEnd's, kept from before ready
  // Pose mode on the file, with `part`: what attachPosing decided (handle.__preview).
  const preview = part ? { params: null, fileParams: null, placer: null, poseMode: null, poseCollide: null, visible: null } : null;
  let posing = null;                 // attachPosing's result, once attached
  let poseEnabled = true;            // handle.pose.setEnabled's, kept from before ready
  const cleanups = [];
  const modeListeners = new Set();
  const envListeners = new Set();
  const lostListeners = new Set();
  let resolveDrawn, rejectDrawn;
  const drawn = new Promise((resolve, reject) => { resolveDrawn = resolve; rejectDrawn = reject; });
  drawn.catch(() => {}); // the host awaits it; never an unhandled rejection

  // Same precedence mount() uses: projection first (orthographic only for a
  // face-view camera), then the camera, then environment and render mode.
  function applyState(s) {
    if (!s || !live) return;
    const { viewer } = live;
    // Under camera: "default" the framing is the file's own: no projection either.
    if (!opts.defaultCamera) viewer.setProjection(s.projection === "orthographic" && isFaceAlignedState(s.camera) ? "orthographic" : "perspective");
    if (s.camera) viewer.setCameraState(s.camera);
    if (typeof s.environment === "string") viewer.setEnvironment(s.environment);
    if ((s.renderMode === "cad" || s.renderMode === "realistic") && s.renderMode !== viewer.getRenderMode()) {
      viewer.setRenderMode(s.renderMode);
    }
  }

  const ready = import("./gltf/decode-preview.js").then(({ decodePreviewGlb }) => decodePreviewGlb(glb)).then((decoded) => {
    if (disposed) return;
    if (decoded.meshes.length === 0) throw new Error("mountPreview: the preview holds no meshes");
    const view = decoded.view ?? "preview";
    const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const plays = !!decoded.animation && animate !== false;
    // Framing follows the configuration, not reduced motion: a turntable mount
    // is framed swept whether or not it is allowed to turn, so every visitor
    // sees the model at the same size and centre.
    const sweeps = !plays && opts.turntable > 0;
    const turns = sweeps && !reducedMotion;
    const viewer = createViewer(container, previewPart({ ...decoded, view }), {
      transparent: opts.transparent, contactShadow: opts.contactShadow, zoom: opts.zoom, pan: opts.pan,
      // A turning model is framed swept a full turn, so no angle of it clips.
      frameFill: opts.fill, frameSwept: sweeps,
      // An animation is framed over every pose it passes through (0.171.0).
      framePoses: plays ? animationPoses(decoded.animation) : null,
      edgeWidth: opts.edgeWidth, edgeOpacity: opts.edgeOpacity,
    });
    cleanups.push(() => viewer.dispose());
    let tooltip = null, toolbar = null, viewStyle = null;
    if (opts.chrome) {
      tooltip = createTooltipPresenter({ id: null });
      const tip = tooltip;
      cleanups.push(() => tip.dispose());
      const viewcube = attachViewcubeControls(viewer, { stage: container });
      cleanups.push(() => viewcube.detach());
      toolbar = container.querySelector("#viewbar");
      const style = viewStyle = attachViewStyleControls(viewer, { stage: container, toolbar, anchor: viewcube.element }, { tooltip });
      cleanups.push(() => style.detach());
      cleanups.push(observeViewbarClear(container, toolbar));
      const chrome = attachViewerControls(viewer, elements.chrome ?? {}, { tooltip });
      cleanups.push(() => chrome.detach());
    }
    cleanups.push(viewer.onRenderModeChange(relay(modeListeners)));
    cleanups.push(viewer.onEnvironmentChange(relay(envListeners)));
    cleanups.push(viewer.onContextLost(relay(lostListeners)));
    for (const m of decoded.meshes) viewer.setSubGeometry(m.name, m);
    viewer.showAssembly(decoded.meshes.map((m) => m.name), { frame: true });
    // The opening framing restart() returns to: the file's default view
    // direction at the fill distance, before any carried camera.
    const opening = viewer.getCameraState();
    live = { viewer, view };
    applyState(carried);
    if (!active) viewer.setActive(false);
    const offRendered = viewer.onRendered(() => { offRendered(); resolveDrawn(); });
    cleanups.push(offRendered);
    let turntable = null;
    let lastMotionState = null;
    const motionState = () => {
      if (player && !reducedMotion) {
        if (!player.started()) return "waiting";
        const { status } = player.state();
        return status === "done" ? "finished" : status === "playing" || status === "intro" ? "playing" : "stopped";
      }
      return turntable ? turntable.phase() : "stopped";
    };
    const motionChanged = () => {
      if (disposed) return;
      const now = motionState();
      if (now === lastMotionState) return;
      lastMotionState = now;
      relay(motionListeners)(now);
    };
    if (plays) {
      player = createPreviewPlayer(viewer, decoded.animation, { reducedMotion });
      const own = player;
      cleanups.push(() => own.dispose());
      cleanups.push(own.onChange(motionChanged));
      if (opts.autostart) player.start();
      else player.prime(); // drawn at the first frame, waiting for motion.start()
      if (!reducedMotion && toolbar) {
        const playButton = attachPreviewPlayButton(own, { toolbar, before: viewStyle.element }, { tooltip });
        cleanups.push(() => playButton.detach());
      }
    } else if (turns) {
      const own = turntable = createTurntable(viewer, container, opts.turntable, motionChanged);
      cleanups.push(() => own.dispose());
      if (opts.autostart) turntable.start();
    }
    lastMotionState = motionState();
    motion = {
      get state() { return motionState(); },
      start() {
        if (disposed) return;
        if (player) player.start(); // a no-op once started or under reduced motion
        else turntable?.start();
        motionChanged();
      },
      restart() {
        if (disposed) return;
        posing?.resetParams(); // a posed preview's params back to the file's first
        viewer.cancelCameraTween();
        viewer.setCameraState(opening);
        if (player) player.restart(); // nothing under reduced motion: the pose is already t = 0
        else turntable?.restart();
        motionChanged();
      },
      onChange(cb) {
        if (disposed) return () => {};
        motionListeners.add(cb);
        return () => motionListeners.delete(cb);
      },
    };
    if (part) {
      // A file that names no view has no view of the part to pose: nothing attaches.
      if (!Object.hasOwn(part.views ?? {}, view)) {
        if (decoded.view != null) console.warn(`partforge: preview part ignored — the file shows view "${decoded.view}", which the part does not declare`);
      } else {
        posing = attachPosing({
          viewer, part, view, decoded, container, toolbar, tooltip, chrome: opts.chrome, drawn, cleanups, preview,
          isDisposed: () => disposed,
          onDragEnd: relay(dragEndListeners),
          // the resting cue waits out a playing animation
          cueBlocked: () => (player ? motionState() === "playing" : false),
          player, turntable, reducedMotion,
        });
        if (!poseEnabled) posing.poseMode.setEnabled(false);
      }
    }
  });
  ready.catch(rejectDrawn); // the host awaits it; never an unhandled rejection

  function getViewerState() {
    if (!live) return { camera: null, projection: "perspective", renderMode: "cad", ...carried, cutaway: null };
    const v = live.viewer;
    return {
      camera: v.getCameraState(),
      projection: v.getProjection?.() ?? "perspective",
      cutaway: null, // a preview has no live solid to section
      renderMode: v.isRealisticPending?.() ? "realistic" : v.getRenderMode?.() ?? "cad",
      ...(v.isEnvironmentChosen?.() ? { environment: v.getEnvironment() } : {}),
    };
  }

  // A method that needs the viewer waits for it; a failed decode answers the default.
  const whenLive = async (fn, fallback) => {
    try { await ready; } catch { return fallback; }
    return live ? fn(live.viewer) : fallback;
  };

  return {
    ready,
    drawn,
    dispose() {
      if (disposed) return;
      disposed = true;
      rejectDrawn(new Error("mountPreview: disposed before the preview was drawn")); // a no-op once drawn
      live = null;
      posing = null; // getParams and pose answer as before ready (pose mode detaches below)
      player = null; // `animation` answers null once disposed (the cleanup below disposes it)
      motion = null;
      motionListeners.clear();
      dragEndListeners.clear();
      const errors = [];
      while (cleanups.length) {
        try { cleanups.pop()(); } catch (error) { errors.push(error); }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "partforge mountPreview cleanup failed");
    },
    getView: () => live?.view ?? null,
    // A copy of the preview's params (with `part`); null before ready, without part and once disposed.
    getParams: () => (posing && preview.params ? { ...posing.getParams() } : null),
    // mount()'s pose surface on the file's meshes; the no-op stand-in without `part`.
    pose: part ? {
      isEnabled: () => posing?.poseMode.isEnabled() ?? false,
      setEnabled(on) {
        if (disposed) return;
        poseEnabled = on !== false;
        posing?.poseMode.setEnabled(poseEnabled);
      },
      isLive: () => posing?.poseMode.isLive() ?? false,
      pinCount: () => posing?.poseMode.pinCount() ?? 0,
      releasePins: () => posing?.poseMode.releasePins(),
      handlePoints: (o) => posing?.poseMode.handlePoints(o) ?? [],
      onDragEnd(cb) {
        if (disposed) return () => {};
        dragEndListeners.add(cb);
        return () => dragEndListeners.delete(cb);
      },
      // Test hooks only (scripts/check-pose.mjs), as mount() names them.
      __dragReadout: () => posing?.dragReadout() ?? null,
      __lastDragEnd: () => posing?.lastDragEnd() ?? null,
    } : NOOP_PREVIEW_POSE,
    // Test hook only: what posing decided (params, fileParams, placer, poseMode, poseCollide, visible); null without part.
    __preview: preview,
    // null before ready, for a still file, with animate: false, and once disposed.
    get animation() {
      return player ? { state: player.state, pause: player.pause, resume: player.resume, replay: player.replay } : null;
    },
    // null before ready and once disposed; present for every decoded file.
    get motion() { return motion; },
    getViewerState,
    setViewerState(next) {
      carried = carry(next);
      applyState(carried);
    },
    setActive(next) {
      active = next !== false;
      live?.viewer.setActive(active);
    },
    onContextLost(listener) {
      lostListeners.add(listener);
      return () => lostListeners.delete(listener);
    },
    // No rail to place or pick: accepted so a host relaying mount()'s sticky state
    // can send it here unchanged.
    setHostPane: () => {},
    setRailLayout: () => {},
    renderMode: {
      get: () => live?.viewer.getRenderMode() ?? carried?.renderMode ?? "cad",
      set: (mode) => whenLive((v) => v.setRenderMode(mode), "cad"),
      onChange: (cb) => { modeListeners.add(cb); return () => modeListeners.delete(cb); },
    },
    environment: {
      get: () => live?.viewer.getEnvironment() ?? carried?.environment ?? "studio",
      set: (id) => whenLive((v) => v.setEnvironment(id), "studio"),
      onChange: (cb) => { envListeners.add(cb); return () => envListeners.delete(cb); },
      list: () => Object.values(ENVIRONMENTS).map(({ id, label }) => ({ id, label })),
    },
  };
}
