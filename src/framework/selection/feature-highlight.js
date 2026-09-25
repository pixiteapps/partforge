// Shared surface-highlight helper: an overlay mesh tinting one feature's
// triangle subset (or a whole sub-part). Extracted from hover.js so the hover
// tooltip and measurement mode share one implementation and one subset cache.
import * as THREE from "three";
import { CUTAWAY_OVERLAY_RENDER_ORDER } from "../cutaway-render.js";
import { runCleanupSteps } from "../teardown.js";

const HIGHLIGHT = 0x4da3ff;

// Extract the subset of a geometry belonging to one feature id. Handles both
// non-indexed (Manifold) and indexed (OCCT) payloads.
function featureSubset(geometry, featureId) {
  const { featureIds } = geometry.userData;
  const pos = geometry.getAttribute("position");
  const index = geometry.getIndex();
  const vertAt = index ? (t, v) => index.getX(t * 3 + v) : (t, v) => t * 3 + v;
  let count = 0;
  for (let t = 0; t < featureIds.length; t++) if (featureIds[t] === featureId) count++;
  const out = new Float32Array(count * 9);
  let o = 0;
  for (let t = 0; t < featureIds.length; t++) {
    if (featureIds[t] !== featureId) continue;
    for (let v = 0; v < 3; v++) {
      const i = vertAt(t, v);
      out[o++] = pos.getX(i); out[o++] = pos.getY(i); out[o++] = pos.getZ(i);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(out, 3));
  return g;
}

export function createFeatureHighlight(viewer) {
  const material = new THREE.MeshBasicMaterial({
    color: HIGHLIGHT, transparent: true, opacity: 0.35,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const unregisterCutaway = viewer.registerCutawayMaterial?.(material) ?? (() => {});
  let emptyOverlayGeometry = new THREE.BufferGeometry();
  const overlay = new THREE.Mesh(emptyOverlayGeometry, material);
  overlay.visible = false;
  overlay.renderOrder = CUTAWAY_OVERLAY_RENDER_ORDER;
  // Pointer feedback, never part of a capture (it tints what it covers).
  const unregisterCapture = viewer.registerCaptureHidden?.(overlay) ?? (() => {});
  let overlayParent = null;
  // Subset cache per sub-part: rebuilt when the sub-part's geometry object
  // changes (i.e. after a regenerate) — keyed on the geometry instance.
  const subsets = new Map(); // subPart -> { geo, byId: Map(featureId -> BufferGeometry) }

  function mount(geometry, mesh) {
    emptyOverlayGeometry?.dispose();
    emptyOverlayGeometry = null;
    overlay.geometry = geometry;
    // Parent to the sub-part mesh, not the scene: the overlay geometry is a
    // subset of the mesh's own (delivered-frame) vertices, so it must inherit
    // whatever fast-path pose viewer.setSubPose has written onto that mesh.
    if (overlayParent !== mesh) {
      mesh.add(overlay);
      overlayParent = mesh;
    }
    overlay.visible = true;
  }

  // The overlay is edited in place, not through a viewer call, so it asks for
  // the frame itself (the viewer draws on demand).
  const redraw = () => viewer.requestRender?.();

  return {
    show(hit) {
      redraw();
      if (!hit.feature) { mount(hit.mesh.geometry, hit.mesh); return; }
      const cached = subsets.get(hit.subPart);
      let byId = cached?.geo === hit.mesh.geometry ? cached.byId : null;
      if (!byId) {
        for (const g of cached?.byId.values() ?? []) g.dispose();
        byId = new Map();
        subsets.set(hit.subPart, { geo: hit.mesh.geometry, byId });
      }
      let g = byId.get(hit.feature.id);
      if (!g) { g = featureSubset(hit.mesh.geometry, hit.feature.id); byId.set(hit.feature.id, g); }
      mount(g, hit.mesh);
    },
    clear() { overlay.visible = false; redraw(); },
    dispose() {
      // Every step isolated: a throw disposing one cached subset (or
      // unregistering from cutaway) must not skip the rest — same discipline
      // as hover.js's own cleanup list, which this dispose() call is itself
      // one step of (test/selection-hover.test.js's aggregated-failure case
      // exercises both layers together).
      const steps = [
        () => { overlay.visible = false; },
        () => { overlayParent?.remove(overlay); },
      ];
      for (const { byId } of subsets.values()) {
        for (const g of byId.values()) steps.push(() => g.dispose());
      }
      steps.push(
        () => subsets.clear(),
        () => emptyOverlayGeometry?.dispose(),
        unregisterCutaway,
        unregisterCapture,
        () => material.dispose(),
      );
      runCleanupSteps(steps, "feature highlight cleanup failed");
    },
  };
}
