import * as THREE from "three";

import { createCutawayGizmo } from "./cutaway-gizmo.js";
import {
  cutawayPoseSize,
  initialCutawayPose,
  planeFromPose,
  pointSurvivesPlane,
} from "./cutaway-math.js";
import { createSectionRenderSet } from "./cutaway-render.js";

const IDLE_DELAY_MS = 800;

// Slicing rides on top of everything else in the frame, so the whole visible
// assembly gets about an eighth of a 60 fps frame before outlines step aside
// for the duration of a drag.
export const OUTLINE_SLICE_BUDGET_MS = 2;

function defaultSchedule(callback, delay) {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
}

function validBounds(getBounds) {
  try {
    const bounds = getBounds?.();
    return bounds?.isBox3 && !bounds.isEmpty() ? bounds : null;
  } catch {
    return null;
  }
}

export function createCutaway({
  renderer,
  scene,
  camera: initialCamera,
  orbitControls,
  domElement,
  getBounds,
  edgeColor,
  schedule = defaultSchedule,
  now,
}) {
  // Reassignable: a projection swap (perspective <-> ortho) hands the cutaway
  // a new camera after construction, and the gizmo must follow it too.
  let camera = initialCamera;
  let supported = false;
  try {
    supported = Boolean(
      renderer.getContext().getContextAttributes().stencil,
    );
  } catch {
    supported = false;
  }

  const plane = new THREE.Plane();
  const planeNormal = new THREE.Vector3();
  const capGeometry = new THREE.PlaneGeometry(1, 1);
  const overlayScene = new THREE.Scene();
  const renderSets = new Map();
  const auxiliaryMaterials = new Map();
  let selectedNames = null;
  let nextOrder = 0;
  let enabled = false;
  let flipped = false;
  let theme = "dark";
  let hatchInk = edgeColor;
  let pose = null;
  let viewportSize = null;
  let cancelIdle = null;
  let previousLocalClippingEnabled;
  let disposed = false;
  let disabling = false;
  let outlinesSuppressed = false;
  let hoveredHandle = null;
  const handleHoverSubscribers = new Set();
  const pendingHandlePublications = [];
  let publishingHandleHover = false;

  function reportHandleHoverError(error) {
    try {
      console.error("Cutaway handle hover subscriber failed", error);
    } catch {
      // Reporting must not let application callbacks interrupt controller work.
    }
  }

  function drainHandleHoverPublications() {
    while (pendingHandlePublications.length > 0) {
      const publication = pendingHandlePublications.shift();
      for (const record of publication.subscribers) {
        if (!record.active) continue;
        try {
          record.listener(publication.handle);
        } catch (error) {
          reportHandleHoverError(error);
        }
      }
    }
  }

  function publishHandleHover(nextHandle) {
    const normalized = nextHandle === "translate"
      || nextHandle === "rotate-x"
      || nextHandle === "rotate-y"
      ? nextHandle
      : null;
    if (normalized === hoveredHandle) return;
    hoveredHandle = normalized;
    pendingHandlePublications.push({
      handle: normalized,
      subscribers: [...handleHoverSubscribers],
    });
    if (publishingHandleHover) return;

    publishingHandleHover = true;
    try {
      drainHandleHoverPublications();
    } finally {
      publishingHandleHover = false;
    }
  }

  function onHandleHoverChange(listener) {
    if (disposed || typeof listener !== "function") return () => {};
    const record = { listener, active: true };
    handleHoverSubscribers.add(record);
    try {
      listener(hoveredHandle);
    } catch (error) {
      record.active = false;
      handleHoverSubscribers.delete(record);
      throw error;
    }
    return () => {
      if (!record.active) return;
      record.active = false;
      handleHoverSubscribers.delete(record);
    };
  }

  function clearHandleHoverSubscribers() {
    for (const record of handleHoverSubscribers) record.active = false;
    handleHoverSubscribers.clear();
  }

  function selected(name) {
    return selectedNames == null || selectedNames.has(name);
  }

  function applyCapPose(renderSet) {
    if (!pose) return;
    renderSet.setCapPose({
      position: pose.position,
      quaternion: pose.quaternion,
      size: pose.size,
    });
  }

  function cancelIdleFade() {
    if (!cancelIdle) return;
    cancelIdle();
    cancelIdle = null;
  }

  function showActive() {
    cancelIdleFade();
    gizmo.setActiveAppearance(true);
    const scheduled = schedule(() => {
      cancelIdle = null;
      if (enabled && !disposed) gizmo.setActiveAppearance(false);
    }, IDLE_DELAY_MS);
    cancelIdle = typeof scheduled === "function"
      ? scheduled
      : () => clearTimeout(scheduled);
  }

  function setMaterialClippingPlanes(material, clippingPlanes) {
    if (material.clippingPlanes === clippingPlanes) return;
    material.clippingPlanes = clippingPlanes;
    material.needsUpdate = true;
  }

  function syncAuxiliaryMaterial(material, entry) {
    if (enabled) {
      if (
        !Array.isArray(material.clippingPlanes)
        || material.clippingPlanes.length !== 1
        || material.clippingPlanes[0] !== plane
      ) {
        setMaterialClippingPlanes(material, [plane]);
      }
    } else {
      setMaterialClippingPlanes(material, entry.originalClippingPlanes);
    }
  }

  function syncAuxiliaryMaterials() {
    for (const [material, entry] of auxiliaryMaterials) {
      syncAuxiliaryMaterial(material, entry);
    }
  }

  function applyPose(nextPose, { resetFlip = false, activeAppearance = false } = {}) {
    pose = {
      position: nextPose.position.clone(),
      quaternion: nextPose.quaternion.clone(),
      size: nextPose.size,
    };
    if (resetFlip) flipped = false;
    planeFromPose(plane, planeNormal, pose.position, pose.quaternion, flipped);
    for (const { renderSet } of renderSets.values()) applyCapPose(renderSet);
    gizmo.setFlipped(flipped);
    gizmo.setPose(pose);
    if (activeAppearance) showActive();
  }

  function onPoseChange(nextPose) {
    if (!enabled || disposed) return;
    applyPose(nextPose, { activeAppearance: true });
  }

  const gizmo = createCutawayGizmo({
    scene,
    overlayScene,
    camera,
    domElement,
    orbitControls,
    onPoseChange,
    onActivity: showActive,
    onHandleHoverChange: publishHandleHover,
    onDragChange: setDragging,
  });
  gizmo.setVisible(false);
  gizmo.setTheme(theme);

  function setSubpart(name, mesh, edgeLines) {
    if (disposed) return false;
    const previous = renderSets.get(name);
    const order = previous?.order ?? nextOrder++;
    previous?.renderSet.dispose();

    const renderSet = createSectionRenderSet({
      scene,
      mesh,
      edgeLines,
      plane,
      capGeometry,
      order,
      inkColor: hatchInk,
      now,
    });
    renderSets.set(name, { renderSet, mesh, edgeLines, order });
    if (viewportSize) {
      renderSet.setViewportSize(
        viewportSize.width,
        viewportSize.height,
        viewportSize.pixelRatio,
      );
    }
    applyCapPose(renderSet);
    renderSet.setVisible(enabled && selected(name));
    renderSet.setEnabled(enabled);
    renderSet.setOutlineSuppressed(outlinesSuppressed);
    return true;
  }

  function updateGeometry(name, geometry) {
    const entry = renderSets.get(name);
    if (!entry || disposed) return false;
    entry.renderSet.setGeometry(geometry);
    return true;
  }

  function setVisible(names) {
    if (disposed) return false;
    selectedNames = new Set(typeof names === "string" ? [names] : names ?? []);
    for (const [name, { renderSet }] of renderSets) {
      renderSet.setVisible(enabled && selected(name));
    }
    return true;
  }

  function disable() {
    if (disabling) return true;
    disabling = true;
    let firstError = null;
    const attempt = (callback) => {
      try {
        callback();
      } catch (error) {
        firstError ??= error;
      }
    };
    const wasEnabled = enabled;
    enabled = false;
    try {
      attempt(cancelIdleFade);
      attempt(() => gizmo.setVisible(false));
      publishHandleHover(null);
      if (wasEnabled) {
        for (const { renderSet } of renderSets.values()) {
          attempt(() => renderSet.setVisible(false));
          attempt(() => renderSet.setEnabled(false));
        }
        for (const [material, entry] of auxiliaryMaterials) {
          attempt(() => syncAuxiliaryMaterial(material, entry));
        }
        attempt(() => {
          renderer.localClippingEnabled = previousLocalClippingEnabled;
        });
        previousLocalClippingEnabled = undefined;
      }
    } finally {
      disabling = false;
    }
    if (firstError) throw firstError;
    return true;
  }

  function setEnabled(on) {
    if (disposed || disabling) return false;
    if (!on) return disable();
    if (enabled) return true;
    if (!supported) return false;
    const bounds = validBounds(getBounds);
    if (!bounds) return false;

    const initialPose = initialCutawayPose(bounds, camera);
    previousLocalClippingEnabled = renderer.localClippingEnabled;
    enabled = true;
    flipped = false;
    applyPose(initialPose);
    renderer.localClippingEnabled = true;
    for (const [name, { renderSet }] of renderSets) {
      renderSet.setVisible(selected(name));
      renderSet.setEnabled(true);
    }
    syncAuxiliaryMaterials();
    gizmo.setVisible(true);
    gizmo.updateForCamera();
    showActive();
    return true;
  }

  function reset() {
    if (!enabled || disposed) return false;
    const bounds = validBounds(getBounds);
    if (!bounds) return false;
    applyPose(initialCutawayPose(bounds, camera), {
      resetFlip: true,
      activeAppearance: true,
    });
    return true;
  }

  function flip() {
    if (!enabled || disposed || !pose) return false;
    flipped = !flipped;
    planeFromPose(plane, planeNormal, pose.position, pose.quaternion, flipped);
    gizmo.setFlipped(flipped);
    showActive();
    return true;
  }

  // --- state carry-over ------------------------------------------------------
  // The cutaway lives and dies with its mount, and an embedder that applies
  // every edit by REMOUNTING (partforge-cloud does — the agent's edits, undo,
  // redo, a settings commit) would otherwise close the user's slice on every
  // turn. These two carry it across; mount.js owns the handoff.
  //
  // The snapshot is plain JSON on purpose. It outlives the mount that produced
  // it, so a live THREE object would hand the next mount a reference into a
  // disposed scene — and a host free to store or post it needs something
  // structured-cloneable either way.
  const isFiniteTuple = (value, length) =>
    Array.isArray(value) && value.length === length && value.every(Number.isFinite);

  function getState() {
    // `size` is deliberately absent. It is a function of the part's bounds, and
    // the part is exactly what changed between the snapshot and the restore —
    // carrying it would size the cap and the gizmo for geometry that no longer
    // exists. What the user actually chose is where the plane sits, which way
    // it faces, and the flip; setState re-derives the rest.
    if (!enabled || !pose) return { enabled: false, flipped: false, pose: null };
    return {
      enabled: true,
      flipped,
      pose: {
        position: pose.position.toArray(),
        quaternion: pose.quaternion.toArray(),
      },
    };
  }

  function setState(state) {
    if (disposed || disabling) return false;
    // A snapshot taken with the cutaway off carries nothing to restore. This is
    // not an instruction to disable — setState only ever turns the mode ON, so
    // restoring into a fresh mount (already off) is correctly a no-op.
    if (!state?.enabled) return true;
    // Enable first: this is the path that refuses when the restore is
    // impossible (no stencil, no geometry yet), and it seeds a pose against the
    // CURRENT bounds for the malformed-snapshot fallback below to land on.
    if (!setEnabled(true)) return false;
    if (!isFiniteTuple(state.pose?.position, 3) || !isFiniteTuple(state.pose?.quaternion, 4)) {
      return true; // enabled at the fresh pose, which beats refusing the restore outright
    }
    const bounds = validBounds(getBounds);
    flipped = Boolean(state.flipped); // read by applyPose, through planeFromPose and gizmo.setFlipped
    applyPose({
      position: new THREE.Vector3().fromArray(state.pose.position),
      quaternion: new THREE.Quaternion().fromArray(state.pose.quaternion).normalize(),
      // Re-derived, never carried — see getState above. The fallback covers
      // setState on an ALREADY-enabled cutaway, where setEnabled returned early
      // and bounds may since have gone away.
      size: bounds ? cutawayPoseSize(bounds) : pose.size,
    }, { activeAppearance: true });
    return true;
  }

  function setTheme(mode, edgeColor) {
    if (disposed) return false;
    theme = mode;
    if (edgeColor != null) hatchInk = edgeColor;
    gizmo.setTheme(mode);
    for (const { renderSet } of renderSets.values()) {
      renderSet.refreshSourceMaterial();
      renderSet.setHatchInk(hatchInk);
    }
    return true;
  }

  function setViewportSize(width, height, pixelRatio = 1) {
    if (disposed) return false;
    viewportSize = { width, height, pixelRatio };
    for (const { renderSet } of renderSets.values()) {
      renderSet.setViewportSize(width, height, pixelRatio);
    }
    return true;
  }

  function isPointVisible(point) {
    return !enabled || pointSurvivesPlane(plane, point);
  }

  // The live clip plane, for a caller that has to reason about the CUT itself
  // rather than test a point against it — clicking the cut face is the only one
  // today. Null while disabled, and a copy either way, so no caller can hold a
  // stale plane or move ours.
  function getPlane(target = new THREE.Plane()) {
    return enabled ? target.copy(plane) : null;
  }

  function registerClippableMaterial(material) {
    if (disposed || !material) return () => {};
    let entry = auxiliaryMaterials.get(material);
    if (entry) {
      entry.count += 1;
    } else {
      entry = {
        count: 1,
        originalClippingPlanes: material.clippingPlanes,
      };
      auxiliaryMaterials.set(material, entry);
    }
    syncAuxiliaryMaterial(material, entry);
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      const current = auxiliaryMaterials.get(material);
      if (!current) return;
      current.count -= 1;
      if (current.count > 0) {
        return;
      }
      auxiliaryMaterials.delete(material);
      setMaterialClippingPlanes(material, current.originalClippingPlanes);
    };
  }

  // Re-assert this sub-part's enabled-state material assignment. The viewer
  // calls it after taking a sub-part OFF a fade clone: while the cutaway is
  // enabled the mesh belongs on clippedMeshMaterial, and only the render set
  // knows that material. setEnabled is idempotent, so this is a cheap
  // re-assert, not a rebuild.
  function resyncSubpart(name) {
    if (disposed) return false;
    const entry = renderSets.get(name);
    if (!entry) return false;
    entry.renderSet.setEnabled(enabled);
    return true;
  }

  // Swap one sub-part's SOURCE material (realistic mode). The render set
  // re-derives its clipped clone and cap colour from it and reassigns
  // mesh.material for the current enabled state.
  function refreshSubpartMaterial(name, meshMaterial) {
    if (disposed) return false;
    const entry = renderSets.get(name);
    if (!entry) return false;
    entry.renderSet.refreshSourceMaterial(meshMaterial);
    return true;
  }

  // Per-frame maintenance while the cutaway is on: the gizmo rescales for the
  // camera, and every visible section re-slices its outline if anything it
  // depends on moved. Both are cheap no-ops when nothing changed.
  function refreshSections() {
    for (const { renderSet } of renderSets.values()) renderSet.refreshOutline();
  }

  // Outlines re-slice on every frame of a gizmo drag. On heavy assemblies that
  // is the one place the cost could show, so decide once at drag start — from
  // costs already measured, so the drag never pays a spike to discover it is
  // too expensive — and hide all of them or none. Half-outlined assemblies read
  // as broken. Only sections that are actually showing count toward the budget:
  // a hidden section's refresh() early-returns without slicing, so its cost
  // entry is whatever was last measured while it *was* visible — stale, and
  // irrelevant to what the drag will actually spend time on.
  function setDragging(active) {
    if (disposed) return;
    if (active) {
      let total = 0;
      for (const [name, { renderSet }] of renderSets) {
        if (enabled && selected(name)) total += renderSet.outlineSliceCost();
      }
      outlinesSuppressed = total > OUTLINE_SLICE_BUDGET_MS;
    } else {
      outlinesSuppressed = false;
    }
    for (const { renderSet } of renderSets.values()) {
      renderSet.setOutlineSuppressed(outlinesSuppressed);
    }
    if (!active) refreshSections();
  }

  function updateForCamera() {
    if (!enabled || disposed) return;
    gizmo.updateForCamera();
    refreshSections();
  }

  function renderOverlay(targetRenderer, targetCamera) {
    if (!enabled || disposed) return false;
    const previousAutoClear = targetRenderer.autoClear;
    try {
      targetRenderer.autoClear = false;
      targetRenderer.clearDepth();
      targetRenderer.render(overlayScene, targetCamera);
    } finally {
      targetRenderer.autoClear = previousAutoClear;
    }
    return true;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    let firstError = null;
    const attempt = (callback) => {
      try {
        callback();
      } catch (error) {
        firstError ??= error;
      }
    };
    attempt(disable);
    for (const { renderSet } of renderSets.values()) {
      attempt(() => renderSet.dispose());
    }
    renderSets.clear();
    for (const [material, entry] of auxiliaryMaterials) {
      attempt(() => setMaterialClippingPlanes(material, entry.originalClippingPlanes));
    }
    auxiliaryMaterials.clear();
    attempt(() => gizmo.dispose());
    publishHandleHover(null);
    drainHandleHoverPublications();
    clearHandleHoverSubscribers();
    attempt(() => overlayScene.clear());
    attempt(() => capGeometry.dispose());
    if (firstError) throw firstError;
  }

  return {
    get isSupported() { return supported; },
    get isEnabled() { return enabled; },
    setSubpart,
    updateGeometry,
    setVisible,
    setEnabled,
    resyncSubpart,
    refreshSubpartMaterial,
    reset,
    flip,
    getState,
    setState,
    setTheme,
    setViewportSize,
    isPointVisible,
    getPlane,
    registerClippableMaterial,
    updateForCamera,
    renderOverlay,
    onHandleHoverChange,
    setCamera(next) {
      if (!next) return;
      camera = next;
      gizmo?.setCamera(next);
    },
    dispose,
    _renderSetFor: (name) => renderSets.get(name)?.renderSet ?? null,
    _setDragging: setDragging,
  };
}
