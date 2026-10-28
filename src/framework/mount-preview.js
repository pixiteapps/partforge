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
// `showcase` is the marketing card: a small model beside a page's own copy,
// with nothing to operate. No view cube, no #viewbar controls, no view style,
// no tooltips, no play button, no `elements.chrome` wiring; a transparent
// canvas with no grid (the page shows through) and the product shot's contact
// shadow under the part; orbit only — zoom and pan are off, so a wheel scrolls
// the page. Always CAD (renderMode.set answers "cad"), and `viewerState` /
// setViewerState are ignored: each showcase mount opens at its own default
// framing. A baked animation plays as authored (a looping one loops, a
// one-time one holds its end pose — there is no replay button); a still file
// (or `animate: false`) turns about the vertical at `turntableDegPerSec`
// (default 14) off the viewer's frame loop, never under reduced motion, and the
// first camera grab stops the turn for good. Dragging an animated model orbits
// the camera and the animation plays on.
//
// `handle.drawn` resolves after the first frame that includes the meshes has
// rendered (so a host can cross-fade from a still image without a flash). It
// rejects with `ready`'s error when the file will not decode, and rejects if
// the handle is disposed before that frame. A parked preview draws nothing, so
// `drawn` waits for setActive(true).
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
import { createPreviewPlayer } from "./preview-player.js";
import { attachPreviewPlayButton } from "./preview-play-button.js";

const SHOWCASE_TURNTABLE_DEG_PER_SEC = 14;

function showcaseOptions(showcase) {
  if (!showcase) return null;
  const rate = showcase.turntableDegPerSec;
  return { turntableDegPerSec: typeof rate === "number" && Number.isFinite(rate) && rate >= 0 ? rate : SHOWCASE_TURNTABLE_DEG_PER_SEC };
}

// Turn the camera about the vertical at `degPerSec` until the first camera grab.
// It turns through viewer.orbitBy, which itself announces a camera grab — so the
// turntable's own steps are told apart from the user's by a flag held across
// the call. Returns stop().
function startTurntable(viewer, container, degPerSec) {
  let turning = false, stopped = false;
  const offFrame = viewer.onFrame((dt) => {
    // orbitBy's rate: a drag the full stage height is a full turn.
    const dx = ((degPerSec * dt) / 360) * Math.max(1, container.clientHeight || 1);
    if (!(dx > 0)) return;
    turning = true;
    try { viewer.orbitBy(dx, 0); } finally { turning = false; }
  });
  const offGrab = viewer.onCameraStart(() => { if (!turning) stop(); });
  function stop() {
    if (stopped) return;
    stopped = true;
    offFrame();
    offGrab();
  }
  return stop;
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

const relay = (listeners) => (event) => {
  for (const cb of [...listeners]) {
    try { cb(event); } catch (error) { console.warn("partforge: preview listener failed", error); }
  }
};

export function mountPreview(container, { glb, elements = {}, viewerState = null, animate = true, showcase = null } = {}) {
  if (!container) throw new TypeError("mountPreview: a container element is required");
  const show = showcaseOptions(showcase);
  let disposed = false;
  let active = true;
  // Applied once the viewer exists, and on every setViewerState — never in showcase.
  let carried = show ? null : viewerState ?? null;
  let live = null;                   // { viewer, view } once the GLB has decoded
  let player = null;                 // the baked animation's player, once drawn
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
    viewer.setProjection(s.projection === "orthographic" && isFaceAlignedState(s.camera) ? "orthographic" : "perspective");
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
    const viewer = createViewer(container, previewPart({ ...decoded, view }),
      show ? { transparent: true, contactShadow: true, zoom: false, pan: false } : undefined);
    cleanups.push(() => viewer.dispose());
    let tooltip = null, toolbar = null, viewStyle = null;
    if (!show) {
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
    live = { viewer, view };
    applyState(carried);
    if (!active) viewer.setActive(false);
    const offRendered = viewer.onRendered(() => { offRendered(); resolveDrawn(); });
    cleanups.push(offRendered);
    const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (decoded.animation && animate !== false) {
      player = createPreviewPlayer(viewer, decoded.animation, { reducedMotion });
      const own = player;
      cleanups.push(() => own.dispose());
      player.start();
      if (!reducedMotion && toolbar) {
        const playButton = attachPreviewPlayButton(own, { toolbar, before: viewStyle.element }, { tooltip });
        cleanups.push(() => playButton.detach());
      }
    } else if (show && !reducedMotion && show.turntableDegPerSec > 0) {
      cleanups.push(startTurntable(viewer, container, show.turntableDegPerSec));
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
      player = null; // `animation` answers null once disposed (the cleanup below disposes it)
      const errors = [];
      while (cleanups.length) {
        try { cleanups.pop()(); } catch (error) { errors.push(error); }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "partforge mountPreview cleanup failed");
    },
    getView: () => live?.view ?? null,
    // null before ready, for a still file, with animate: false, and once disposed.
    get animation() {
      return player ? { state: player.state, pause: player.pause, resume: player.resume, replay: player.replay } : null;
    },
    getViewerState,
    setViewerState(next) {
      if (show) return; // a showcase keeps its own framing and the CAD look
      carried = next ?? null;
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
      set: (mode) => (show ? Promise.resolve("cad") : whenLive((v) => v.setRenderMode(mode), "cad")),
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
