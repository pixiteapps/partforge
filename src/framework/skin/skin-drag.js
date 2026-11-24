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
//
// A second kind of base, for a k.subdiv(cage) body (docs/superpowers/specs/2026-11-22-
// cage-pose-drag-design.md): a CAGE BASE is a canonical delivery carrying `ties` whose
// probe entry is trusted and cagePosable and whose ties carry that entry's cage topology
// key. A slider change may deform it when, against the live probe: both sides are trusted
// and cagePosable, the shapeHash (the build less the cage's point positions) is equal, and
// deformCage accepts the live cage's topology. A sub-part's base is one kind or the other,
// never both; restore, hold and the drag flag are shared.
//
// A cage base is cheap until a drag needs it: at delivery it keeps references to the
// delivered arrays, the ties and its probe entry's snapshot, and nothing else (a phone's
// memory budget does not count what the skin holds). Its DRAG STATE (the subdiv plan built
// from that snapshot, cage-deform.js; the copies of positions and normals; the scratch) is
// made the first time a drag needs it (prepareCage), copying the delivered arrays before
// anything writes into them, and only after tiesAgree has proved the plan and the ties
// agree; a base that fails is forgotten, and the change takes the exact build. The drag
// state is dropped once nothing is deformed or held and the drag is over (endDrag,
// restoreAll, deform() finding the drag over), and with the base (forget, a new delivery):
// an idle cage part holds no copy.
//
// A cage pose must not pass through itself (the design's "Stopping at the last valid
// pose"). Before a cage base draws a live pose, the drag validity check runs on it
// (cage-deform.js's cagePoseValidity); while the drag is live (the sub-part is deformed or
// held, or a handle is being dragged), a live entry whose build THREW (the probe's
// `threw`: rotate and scale refuse an edge shorter than 1e-6) fails too. An entry
// untrusted for any other reason (the build queries geometry) fails nothing: the skin
// cannot re-pose it, and the exact build takes the change. A pose that fails is not drawn:
// the sub-part HOLDS what it shows (the last valid pose, or its base), the controller
// reports it held (holdsInvalid), and lastValidParams() names the params of the last pose a
// cage base drew, or where the drag began. mount.js puts the params back there before a
// build goes out, and a handle drag asks first through validityGuard. An implicit base
// never runs any of it.
//
// Where a cage drag began (cageDragStart, and lastValidParams before any pose is drawn) is
// the LIVE params just before its first deform: deform({ before }) is handed them, never
// a base's dispatch record, whose values for keys the cage does not read can be older than
// the live ones (another sub-part's edit), and putting those back would undo that edit.
import { viewSubParts } from "../part-model.js";
import { probePoses } from "../pose-probe.js";
import { framesOnlyChange } from "./frames-only.js";
import { frameMotions, skinVertices } from "./deform.js";
import { makeCageBase, tiesFitCage, tiesAgree, deformCage, cagePoseValidity, cagePosableEntry } from "./cage-deform.js";

/** The pause with no slider input after which a drag's exact build is dispatched. */
export const SKIN_PAUSE_MS = 150;

const skinnableEntry = (e) => !!(e && e.trusted && e.skinnable && Array.isArray(e.implicitSpecs) && e.implicitSpecs.length > 0);

// Can a mesh built at `from` be deformed to `to`? (Both build-scope probe entries.)
const skinnableBetween = (from, to) =>
  skinnableEntry(from) && skinnableEntry(to)
  && from.shapeHash !== undefined && from.shapeHash === to.shapeHash
  && framesOnlyChange(from.implicitSpecs, to.implicitSpecs);

// A cage base's entry: cage-deform.js's cagePosableEntry (one cage, trusted, cage-posable,
// a defined shapeHash).

// Can a cage body built at `from` be re-posed to `to`? (deformCage checks the topology.)
const cagePosableBetween = (from, to) =>
  cagePosableEntry(from) && cagePosableEntry(to) && from.shapeHash === to.shapeHash;

export function createSkinDrag(part, viewer, { params, getView, getParamsVersion, probe = probePoses }) {
  // name -> { kind: "implicit", positions, normals, bindings, specs, shapeHash, baseHash, scratch }
  //       | { kind: "cage", delivered: { positions, normals }, ties, snapshot, shapeHash, baseHash,
  //           drag: null | { cage, positions, normals, scratch } }
  const bases = new Map();
  const deformed = new Set();
  let dragging = false;
  // Cage bases held at an invalid live pose by the last deform(), and the params of the
  // last pose a cage base drew (where the drag began, before it drew one).
  const invalid = new Set();
  let lastValid = null;
  let dragStart = null;   // the live params just before the current cage drag's first deform
  // hold(): while any hold is out, nothing deforms (an async capture is reading the
  // exact meshes). A counter, so overlapping holders compose.
  let holds = 0;

  // The live build-scope probe and the per-name motions, memoized per (version, view).
  let liveKey = null, liveMap = null, motionMemo = new Map();
  // The probe validityGuard last ran, at its candidate params: a handle frame checks a
  // pose and then writes it, so the deform that follows reuses it instead of probing again.
  let checked = null;
  const sameParams = (a, b) => {
    for (const k of Object.keys(a)) if (!Object.is(a[k], b[k])) return false;
    for (const k of Object.keys(b)) if (!(k in a)) return false;
    return true;
  };
  const liveProbe = () => {
    const key = `${getParamsVersion()}|${getView()}`;
    if (key !== liveKey) {
      liveKey = key;
      liveMap = checked && checked.view === getView() && sameParams(checked.params, params)
        ? checked.map : probe(part, getView(), params, { scope: "build" });
      motionMemo = new Map();
    }
    return liveMap;
  };
  const cageEntryOf = (base) => ({ trusted: true, cagePosable: true, cages: [base.snapshot], shapeHash: base.shapeHash });
  // A cage base's verdict on a probe entry: undefined (not a cage drag: no cage base, or a
  // live cage it cannot re-pose), null (valid) or { message }. An entry whose build threw
  // fails only while a cage drag is live (`dragLive`): the cage code threw at this pose.
  // Before that, and for an entry untrusted for any other reason, it is an ordinary change
  // the probe cannot follow, and the exact build takes it. The base's own build is valid
  // without a check (it is what the base shows). A trusted entry's verdict is memoized per
  // probe map (one check per params version).
  const verdictMemo = new WeakMap();
  function cageVerdict(name, map, dragLive) {
    const base = bases.get(name);
    if (base?.kind !== "cage") return undefined;
    const e = map.get(name);
    if (!e?.trusted) return dragLive && e?.threw ? { message: "subdiv: the cage code failed at this pose" } : undefined;
    if (e.baseHash !== undefined && e.baseHash === base.baseHash) return null;
    let memo = verdictMemo.get(map);
    if (!memo) verdictMemo.set(map, (memo = new Map()));
    if (!memo.has(name)) {
      const drag = cagePosableBetween(cageEntryOf(base), e) ? prepareCage(name) : null;
      memo.set(name, drag ? cagePoseValidity(drag.cage, e.cages[0]) : undefined);
    }
    return memo.get(name);
  }
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
    invalid.delete(name);
    motionMemo.delete(name);
  }

  function recordDelivered(name, mesh, at) {
    if (mesh?.ties && recordCage(name, mesh, at)) return;
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
      kind: "implicit",
      positions: mesh.positions.slice(),
      normals: mesh.normals.slice(),
      bindings: b,
      specs: e.implicitSpecs,
      shapeHash: e.shapeHash,
      baseHash: e.trusted ? e.baseHash : undefined,
      scratch: { positions: new Float32Array(n), normals: new Float32Array(n) },
    });
    deformed.delete(name); // a delivery replaced the geometry: whatever was deformed is gone
    invalid.delete(name);
    motionMemo.delete(name);
  }

  // A delivery with ties becomes a cage base when its probe entry is cage-posable and
  // the ties carry that entry's cage topology. False records nothing (recordDelivered goes
  // on to the implicit rule, which forgets a delivery without bindings). Nothing is built
  // or copied here (see the header): prepareCage does that when a drag needs it.
  function recordCage(name, mesh, at) {
    const ties = mesh.ties;
    if (mesh.frame !== "canonical" || !at?.params || !mesh.positions || !mesh.normals
      || !ties.tri || ties.tri.length * 3 !== mesh.positions.length || mesh.normals.length !== mesh.positions.length) return false;
    const e = probeAt(at).get(name);
    // The plan will come from the base delivery's own snapshot: the ties index its triangles.
    if (!cagePosableEntry(e) || !tiesFitCage(e.cages[0], ties)) return false;
    bases.set(name, {
      kind: "cage",
      delivered: { positions: mesh.positions, normals: mesh.normals },
      ties,
      snapshot: e.cages[0],
      shapeHash: e.shapeHash,
      baseHash: e.baseHash,
      drag: null,
    });
    deformed.delete(name);
    invalid.delete(name);
    motionMemo.delete(name);
    return true;
  }

  // A cage base's drag state, made on first need: the plan, checked against the ties
  // (tiesAgree), then copies of the delivered arrays (nothing has written into them: the
  // state is dropped only while the sub-part is not deformed, and a restore writes the
  // copies back first) and the scratch. Null, forgetting the base, when the plan and the
  // ties do not agree: no fast drag, the exact build takes every change.
  function prepareCage(name) {
    const base = bases.get(name);
    if (base?.kind !== "cage") return null;
    if (base.drag) return base.drag;
    const { positions, normals } = base.delivered;
    const cage = makeCageBase(base.snapshot, base.ties);
    if (!cage || !tiesAgree(cage, positions)) { forget(name); return null; }
    const n = positions.length;
    base.drag = {
      cage,
      positions: positions.slice(),
      normals: normals.slice(),
      scratch: { positions: new Float32Array(n), normals: new Float32Array(n) },
    };
    return base.drag;
  }

  // Drop the drag state of every cage base that is neither deformed nor held: the
  // delivered arrays hold the exact base again, so the next drag copies them afresh.
  function dropIdleCageState() {
    for (const [name, base] of bases) {
      if (base.kind === "cage" && base.drag && !deformed.has(name) && !invalid.has(name)) base.drag = null;
    }
  }

  function canSkin(name) {
    const base = bases.get(name);
    if (!base) return false;
    const live = liveProbe().get(name);
    if (base.kind === "cage") return cagePosableBetween(cageEntryOf(base), live);
    return skinnableBetween({ trusted: true, skinnable: true, implicitSpecs: base.specs, shapeHash: base.shapeHash }, live);
  }

  // Implicit bases only: mount rebases a stale delivery with bindings mid-drag, because
  // skinning drifts from the exact shape as the pose moves away from the base. A cage
  // base is never rebased: its smooth skin is exact at the live points wherever the drag
  // goes. (A cut is not redone during a drag, so the seam vertices ride the skin until the
  // exact build lands.)
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
    // A cage base with no drag state has written nothing into the delivered arrays.
    const exact = base.kind === "cage" ? base.drag : base;
    if (!exact) return true;
    try {
      viewer.setSubVertices(name, { positions: exact.positions, normals: exact.normals }, { deformed: false });
    } catch {
      forget(name);
      return false;
    }
    return true;
  }

  // `before`: the live params just before the change this call shows (mount.js's), where a
  // cage drag that begins here began. Without it, the live params.
  function deform({ before } = {}) {
    if (holds > 0) {
      restoreAll();
      dragging = false;
      return [];
    }
    const inView = viewSubParts(part, getView(), params);
    const skinned = [];
    let cageDrawn = false;
    const cageWasLive = cageDragNames().length > 0;
    const wasHeld = new Set(invalid);
    invalid.clear();
    for (const name of inView) {
      if (!bases.has(name) || !viewer.hasSubMesh(name)) continue;
      const base = bases.get(name);
      // A cage pose that fails the check is not drawn: what is on screen stays.
      if (base.kind === "cage" && cageVerdict(name, liveProbe(), deformed.has(name) || wasHeld.has(name))) {
        invalid.add(name);
        dragging = true;
        skinned.push(name);
        continue;
      }
      const live = canSkin(name) ? liveProbe().get(name) : null;
      // At the base's own build the exact base IS the live shape: show it, not an
      // identity skin (which would also keep the edge lines hidden).
      const atBase = live && base.baseHash !== undefined && live.baseHash === base.baseHash;
      let moved = false;
      let scratch = base.scratch;
      if (live && !atBase) {
        if (base.kind === "cage") {
          const drag = prepareCage(name);
          scratch = drag?.scratch;
          moved = !!drag && deformCage(drag.cage, live.cages[0], scratch.positions, scratch.normals);
        } else {
          const motions = motionsOf(name);
          if (motions) { skinVertices(base, motions, base.scratch); moved = true; }
        }
      }
      if (!moved) {
        if (deformed.has(name)) restore(name);
        if (atBase && base.kind === "cage") cageDrawn = true;
        continue;
      }
      let ok;
      try {
        ok = viewer.setSubVertices(name, scratch, { deformed: true });
      } catch {
        forget(name);
        continue;
      }
      if (!ok) continue;
      deformed.add(name);
      dragging = true;
      skinned.push(name);
      if (base.kind === "cage") cageDrawn = true;
    }
    // A cage drag that begins here began at the live params before this change.
    if (!cageWasLive && cageDragNames().length > 0) {
      dragStart = { ...(before ?? params) };
      lastValid = { ...dragStart };
    }
    if (cageDrawn && invalid.size === 0) lastValid = { ...params };
    // A deformed sub-part that left the view goes back to its exact base.
    const shown = new Set(inView);
    for (const name of [...deformed]) if (!shown.has(name)) restore(name);
    // Nothing left deformed (back at the base, or a change skinning cannot follow) and
    // nothing held: the drag is over, so a release takes the ordinary path.
    if (deformed.size === 0 && invalid.size === 0) {
      dragging = false;
      dropIdleCageState();
    }
    return skinned;
  }

  // Is every in-view cage base's pose at `candidate` drawable? A handle drag is a live drag
  // from its first frame. (One probe, kept for the deform that follows a write of these
  // params.)
  function poseValidAt(candidate) {
    const view = getView();
    const map = probe(part, view, candidate, { scope: "build" });
    checked = { view, params: { ...candidate }, map };
    for (const name of viewSubParts(part, view, candidate)) {
      if (viewer.hasSubMesh(name) && cageVerdict(name, map, true)) return false;
    }
    return true;
  }

  function cageDragNames() {
    const out = [...invalid];
    for (const n of deformed) if (bases.get(n)?.kind === "cage" && !invalid.has(n)) out.push(n);
    return out;
  }

  function restoreAll() {
    const restored = [];
    for (const name of [...deformed]) if (restore(name)) restored.push(name);
    dropIdleCageState();
    return restored;
  }

  return {
    recordDelivered, forget, canSkin, canRebase, deform, restore, restoreAll,
    hasBase: (name) => bases.has(name),
    isDeformed: (name) => deformed.has(name),
    anyDeformed: () => deformed.size > 0,
    isDragging: () => dragging,
    endDrag: () => { dragging = false; invalid.clear(); dropIdleCageState(); },
    // A cage pose the last deform() refused is held on screen (see the header).
    holdsInvalid: () => invalid.size > 0,
    lastValidParams: () => (lastValid ? { ...lastValid } : null),
    // A cage base is deformed or held: what a build sent now follows is a cage drag.
    cageDragActive: () => cageDragNames().length > 0,
    // The cage bases a drag is showing (deformed or held), and where that drag began: the
    // live params just before its first deform (null with none).
    cageDragNames,
    cageDragStart: () => (cageDragNames().length > 0 && dragStart ? { ...dragStart } : null),
    /**
     * A Pose-mode drag guard (pose-session.js's COLLISIONS contract) that refuses a pose an
     * in-view cage base may not draw, wrapping `inner` (the collision guard, or null).
     * Returns `inner` itself when no cage base is in view, so a part with no cage gets
     * exactly the guard it had. A refused settle stays at `from`, the last clear pose.
     */
    validityGuard(inner) {
      const view = getView();
      const anyCage = viewSubParts(part, view, params).some((n) => bases.get(n)?.kind === "cage" && viewer.hasSubMesh(n));
      if (!anyCage) return inner;
      return {
        settle(from, to, opts) {
          const s = inner ? inner.settle(from, to, opts) : { params: { ...to }, blocked: null };
          return poseValidAt({ ...from, ...s.params }) ? s : { params: { ...from }, blocked: null };
        },
        isClear: (p) => (inner ? inner.isClear(p) : true) && poseValidAt(p),
        release: () => inner?.release?.(),
      };
    },
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
