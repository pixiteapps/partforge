// The pose-drag controller (docs/superpowers/specs/2026-10-31-implicit-pose-drag-design.md
// §2-4): while a slider that changes only the k.implicit specs' frames is dragged, the
// viewer shows the last exact mesh deformed by the new frames (skin/deform.js) and no
// worker job runs; mount.js dispatches the exact build on release or after SKIN_PAUSE_MS.
//
// A sub-part's SKIN BASE is its last exact canonical delivery that carries bindings, at
// params whose build-scope probe is trusted and skinnable. The base keeps its OWN copies
// of positions and normals: the viewer wraps a delivered payload's arrays without copying
// and setSubVertices writes into them, so the payload stops being the base on the first
// deform. Every deformation starts from the base, never from a previous one (no drift).
//
// A slider change may deform a base only when, against the live build-scope probe: both
// sides are trusted and skinnable, the shapeHash (the build less every spec's frames — a
// plain operand beside the implicit counts) is equal, and framesOnlyChange holds. Anything
// else restores the base and leaves the change to the regen loop.
//
// The deformed mesh is display only: mount restores the base before any capture, and
// nothing that reads geometry as exact (exports, inspect, the geometry cache) reads the
// viewer. No DOM, no three.js: the viewer is injected.
import { viewSubParts } from "../part-model.js";
import { probePoses } from "../pose-probe.js";
import { framesOnlyChange } from "./frames-only.js";
import { frameMotions, skinVertices } from "./deform.js";

/** The pause with no slider input after which a drag's exact build is dispatched. */
export const SKIN_PAUSE_MS = 150;

const skinnableEntry = (e) => !!(e && e.trusted && e.skinnable && Array.isArray(e.implicitSpecs) && e.implicitSpecs.length > 0);

// Can a mesh built at `from` be deformed to `to`? (Both build-scope probe entries.)
const skinnableBetween = (from, to) =>
  skinnableEntry(from) && skinnableEntry(to)
  && from.shapeHash !== undefined && from.shapeHash === to.shapeHash
  && framesOnlyChange(from.implicitSpecs, to.implicitSpecs);

export function createSkinDrag(part, viewer, { params, getView, getParamsVersion, probe = probePoses }) {
  // name -> { positions, normals, bindings, specs, shapeHash, baseHash, scratch }
  const bases = new Map();
  const deformed = new Set();
  let dragging = false;
  // hold(): while any hold is out, nothing deforms (an async capture is reading the
  // exact meshes). A counter, so overlapping holders compose.
  let holds = 0;

  // The live build-scope probe and the per-name motions, memoized per (version, view).
  let liveKey = null, liveMap = null, motionMemo = new Map();
  const liveProbe = () => {
    const key = `${getParamsVersion()}|${getView()}`;
    if (key !== liveKey) {
      liveKey = key;
      liveMap = probe(part, getView(), params, { scope: "build" });
      motionMemo = new Map();
    }
    return liveMap;
  };
  // The probe at a dispatch record's params. One record is shared by every sub-part of
  // its dispatch, so it is memoized by identity.
  const atMemo = new WeakMap();
  const probeAt = (at) => {
    let m = atMemo.get(at);
    if (!m) { m = probe(part, at.view ?? getView(), at.params, { scope: "build" }); atMemo.set(at, m); }
    return m;
  };

  function forget(name) {
    bases.delete(name);
    deformed.delete(name);
    motionMemo.delete(name);
  }

  function recordDelivered(name, mesh, at) {
    const b = mesh?.bindings;
    if (!b || mesh.frame !== "canonical" || !at?.params || !mesh.positions || !mesh.normals
      || !b.frameA || b.frameA.length * 3 !== mesh.positions.length || mesh.normals.length !== mesh.positions.length) {
      forget(name);
      return;
    }
    const e = probeAt(at).get(name);
    if (!skinnableEntry(e) || e.shapeHash === undefined) { forget(name); return; }
    const n = mesh.positions.length;
    bases.set(name, {
      positions: mesh.positions.slice(),
      normals: mesh.normals.slice(),
      bindings: b,
      specs: e.implicitSpecs,
      shapeHash: e.shapeHash,
      baseHash: e.trusted ? e.baseHash : undefined,
      scratch: { positions: new Float32Array(n), normals: new Float32Array(n) },
    });
    deformed.delete(name); // a delivery replaced the geometry: whatever was deformed is gone
    motionMemo.delete(name);
  }

  function canSkin(name) {
    const base = bases.get(name);
    if (!base) return false;
    const live = liveProbe().get(name);
    return skinnableBetween({ trusted: true, skinnable: true, implicitSpecs: base.specs, shapeHash: base.shapeHash }, live);
  }

  function canRebase(name, at) {
    if (!at?.params) return false;
    return skinnableBetween(probeAt(at).get(name), liveProbe().get(name));
  }

  function motionsOf(name) {
    liveProbe();
    if (!motionMemo.has(name)) {
      const base = bases.get(name);
      motionMemo.set(name, frameMotions(base.specs, liveMap.get(name).implicitSpecs, base.bindings.frames));
    }
    return motionMemo.get(name);
  }

  // Write the base back. A geometry that no longer matches the base (a delivery this
  // controller was not told about) drops the base rather than throwing.
  function restore(name) {
    const base = bases.get(name);
    deformed.delete(name);
    if (!base) return false;
    try {
      viewer.setSubVertices(name, { positions: base.positions, normals: base.normals }, { deformed: false });
    } catch {
      forget(name);
      return false;
    }
    return true;
  }

  function deform() {
    if (holds > 0) {
      restoreAll();
      dragging = false;
      return [];
    }
    const inView = viewSubParts(part, getView(), params);
    const skinned = [];
    for (const name of inView) {
      if (!bases.has(name) || !viewer.hasSubMesh(name)) continue;
      const live = canSkin(name) ? liveProbe().get(name) : null;
      // At the base's own build the exact base IS the live shape: show it, not an
      // identity skin (which would also keep the edge lines hidden).
      const atBase = live && bases.get(name).baseHash !== undefined && live.baseHash === bases.get(name).baseHash;
      const motions = live && !atBase ? motionsOf(name) : null;
      if (!motions) {
        if (deformed.has(name)) restore(name);
        continue;
      }
      const base = bases.get(name);
      skinVertices(base, motions, base.scratch);
      let ok;
      try {
        ok = viewer.setSubVertices(name, base.scratch, { deformed: true });
      } catch {
        forget(name);
        continue;
      }
      if (!ok) continue;
      deformed.add(name);
      dragging = true;
      skinned.push(name);
    }
    // A deformed sub-part that left the view goes back to its exact base.
    const shown = new Set(inView);
    for (const name of [...deformed]) if (!shown.has(name)) restore(name);
    // Nothing left deformed (back at the base, or a change skinning cannot follow):
    // the drag is over, so a release takes the ordinary path.
    if (deformed.size === 0) dragging = false;
    return skinned;
  }

  function restoreAll() {
    const restored = [];
    for (const name of [...deformed]) if (restore(name)) restored.push(name);
    return restored;
  }

  return {
    recordDelivered, forget, canSkin, canRebase, deform, restore, restoreAll,
    hasBase: (name) => bases.has(name),
    isDeformed: (name) => deformed.has(name),
    anyDeformed: () => deformed.size > 0,
    isDragging: () => dragging,
    endDrag: () => { dragging = false; },
    // Hold deformation off until the returned release is called (idempotent). The
    // caller restores what is deformed now (restoreAll); later deform() calls restore
    // and return [] while held.
    hold() {
      holds++;
      let released = false;
      return () => { if (!released) { released = true; holds--; } };
    },
    isHeld: () => holds > 0,
  };
}
