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
// mount(), not here). Under prefers-reduced-motion the player shows the opening
// pose and never moves. Parking (setActive(false)) stops the viewer's frame loop,
// and the player's clock with it, so a parked preview is a paused one.
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

export function mountPreview(container, { glb, elements = {}, viewerState = null, animate = true } = {}) {
  if (!container) throw new TypeError("mountPreview: a container element is required");
  let disposed = false;
  let active = true;
  let carried = viewerState ?? null; // applied once the viewer exists, and on every setViewerState
  let live = null;                   // { viewer, view } once the GLB has decoded
  let player = null;                 // the baked animation's player, once drawn
  const cleanups = [];
  const modeListeners = new Set();
  const envListeners = new Set();
  const lostListeners = new Set();

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
    const viewer = createViewer(container, previewPart({ ...decoded, view }));
    cleanups.push(() => viewer.dispose());
    const tooltip = createTooltipPresenter({ id: null });
    cleanups.push(() => tooltip.dispose());
    const viewcube = attachViewcubeControls(viewer, { stage: container });
    cleanups.push(() => viewcube.detach());
    const toolbar = container.querySelector("#viewbar");
    const viewStyle = attachViewStyleControls(viewer, { stage: container, toolbar, anchor: viewcube.element }, { tooltip });
    cleanups.push(() => viewStyle.detach());
    cleanups.push(observeViewbarClear(container, toolbar));
    const chrome = attachViewerControls(viewer, elements.chrome ?? {}, { tooltip });
    cleanups.push(() => chrome.detach());
    cleanups.push(viewer.onRenderModeChange(relay(modeListeners)));
    cleanups.push(viewer.onEnvironmentChange(relay(envListeners)));
    cleanups.push(viewer.onContextLost(relay(lostListeners)));
    for (const m of decoded.meshes) viewer.setSubGeometry(m.name, m);
    viewer.showAssembly(decoded.meshes.map((m) => m.name), { frame: true });
    live = { viewer, view };
    applyState(carried);
    if (!active) viewer.setActive(false);
    if (decoded.animation && animate !== false) {
      const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      player = createPreviewPlayer(viewer, decoded.animation, { reducedMotion });
      cleanups.push(() => player.dispose());
      player.start();
    }
  });
  ready.catch(() => {}); // the host awaits it; never an unhandled rejection

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
    dispose() {
      if (disposed) return;
      disposed = true;
      live = null;
      const errors = [];
      while (cleanups.length) {
        try { cleanups.pop()(); } catch (error) { errors.push(error); }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "partforge mountPreview cleanup failed");
    },
    getView: () => live?.view ?? null,
    // null before ready, for a still file, and with animate: false.
    get animation() {
      return player ? { state: player.state, pause: player.pause, resume: player.resume } : null;
    },
    getViewerState,
    setViewerState(next) {
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
