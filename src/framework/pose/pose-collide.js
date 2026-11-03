// Pose mode's collision index and drag guards (spec "Pose mode: collision in the solver"),
// mount's half: the session (pose-session.js) decides, this supplies the guard.
//
// - INDEXING happens in idle time (requestIdleCallback, else setTimeout): after each
//   delivery — transient mid-drag ones included — and on a view switch, every in-view
//   sub-part whose mesh is not indexed yet is queued, and each idle slice indexes what
//   it has time for, one sub-part at a time (collide/world.js's buildIndex, over the
//   viewer's delivery-frame mesh, getSubMeshLocal). Only while Pose mode is live, and
//   only for a part whose `collisions` block leaves Pose mode on (`pose` not false).
//   The world module (and with it the BVH and the native core) is loaded on the first
//   idle slice, never by the app bundle's first paint.
// - An index belongs to the mesh it was built over: one whose viewer mesh has since been
//   replaced is not used (and is re-queued), so a drag never reads a stale shape.
// - A GUARD (guardFor, the session's collide factory) is a world over the indexes ready
//   at drag begin: a drag that starts before every piece is indexed is guarded among the
//   pieces that are (fewer than two: no guard). Placements are the pose ladder's rung 1
//   (fastPath.matricesAt) at each evaluation's resolved (p, d) — run inside the drag
//   frame's withDeriveMemo scope, the evaluation's derive and this one are one — and a
//   posed, stale or untrusted piece is excluded (null), as the mats contract has it.
//   `moving` is the in-world pieces the handle's params re-place (movingSubParts, over
//   the handle's DOFs — dofsOf — its goal, aim and seed params, and its joint rings').
//   The guard's blocked pair comes back with `b` the piece it stopped against (the one
//   not moving, when only one is). Indexes a drag borrows outlive a re-index until the
//   drag lets its guard go (`release`).
// - TINT: while a drag is held at contact, both pieces of the pair get the feature
//   highlight's whole-sub-part tint (selection/feature-highlight.js), one per piece.
import { normalizeCollisions } from "../collide/declaration.js";
import { createDragGuard } from "../collide/guard.js";
import { resolveParams, viewSubParts } from "../part-model.js";
import { dofsOf } from "./param-solve.js";

const idleSchedule = (cb) => {
  if (typeof globalThis.requestIdleCallback === "function") {
    const id = globalThis.requestIdleCallback(cb, { timeout: 1000 });
    return () => globalThis.cancelIdleCallback?.(id);
  }
  const id = setTimeout(() => cb({ timeRemaining: () => 8, didTimeout: true }), 16);
  return () => clearTimeout(id);
};

/**
 * Every param a drag of `handle` can write: its DOFs (dofsOf), a goal's position, aim and
 * seed, and its `joints` entries' (its rings') — less any a locked handle lists.
 */
export function handleKeys(handle, allHandles, params) {
  const frozen = new Set();
  for (const h of allHandles) if (h?.lock != null && params[h.lock] && Array.isArray(h.params)) for (const k of h.params) frozen.add(k);
  const keys = new Set(dofsOf(handle, allHandles, params));
  const add = (k) => { if (typeof k === "string" && !frozen.has(k)) keys.add(k); };
  const gp = handle?.params;
  if (gp && typeof gp === "object" && !Array.isArray(gp)) for (const list of Object.values(gp)) if (Array.isArray(list)) list.forEach(add);
  if (Array.isArray(handle?.seed)) handle.seed.forEach(add);
  for (const entry of Object.values(handle?.joints ?? {})) {
    if (typeof entry === "string") add(entry);
    else if (entry && typeof entry === "object") Object.values(entry).forEach(add);
  }
  return [...keys];
}

/**
 * @param opts.part the part; nothing is indexed unless normalizeCollisions(part)?.pose.
 * @param opts.viewer hasSubMesh, getSubMeshLocal, _subMeshes (for the tint).
 * @param opts.fastPath the pose ladder (matricesAt).
 * @param opts.getView the active view; opts.getParams the live params.
 * @param opts.isLive () => whether Pose mode is live (indexing waits until it is).
 * @param opts.frameOf (name) => the mesh's delivery frame (the mesh cache's): only a
 *   "canonical" mesh is indexed, since matricesAt places no other (a posed one reads null).
 * @param opts.schedule (cb) => cancel: an idle callback (cb gets a deadline). Tests inject one.
 * @param opts.loadModules () => Promise of { world: collide/world.js, partGuard: collide/part-guard.js }.
 * @param opts.createHighlight (viewer) => a feature highlight (show / clear / dispose).
 */
export function createPoseCollide({
  part, viewer, fastPath, getView, getParams = () => ({}), isLive = () => true,
  frameOf = () => "canonical",
  schedule = idleSchedule,
  loadModules = async () => ({ world: await import("../collide/world.js"), partGuard: await import("../collide/part-guard.js") }),
  createHighlight = null,
}) {
  const decl = normalizeCollisions(part);
  const enabled = !!decl?.pose;
  const entries = new Map(); // name -> { ix, positions }: the index and the mesh array it was built over
  const queue = new Set();
  let mods = null, loading = null;
  let cancelTick = null;
  let borrowers = 0;
  const retired = []; // indexes replaced while a drag borrowed them
  let disposed = false;
  let tints = null, tinted = null;

  const meshOf = (name) => viewer.getSubMeshLocal?.(name) ?? null;
  const fresh = (name) => {
    const e = entries.get(name);
    return !!e && meshOf(name)?.positions === e.positions;
  };
  const free = (ixs) => { if (ixs.length && mods) mods.world.disposeIndexes(ixs); };
  const indexable = (name) => frameOf(name) === "canonical";
  /** Drop a name's index: freed now, or once no drag borrows it. */
  function drop(name) {
    const e = entries.get(name);
    if (!e) return;
    entries.delete(name);
    if (borrowers) retired.push(e.ix); else free([e.ix]);
  }

  function kick() {
    if (!enabled || disposed || cancelTick || !queue.size || !isLive()) return;
    cancelTick = schedule(tick);
  }

  async function tick(deadline) {
    cancelTick = null;
    if (disposed) return;
    if (!mods) {
      loading ??= loadModules().then((m) => { mods = m; }, (err) => { console.error("pose collisions: the collision world failed to load", err); });
      await loading;
      if (!mods || disposed) return;
    }
    if (!isLive()) return; // a live change kicks again
    for (const name of [...queue]) {
      queue.delete(name);
      if (fresh(name)) continue; // the very mesh array already indexed: nothing to rebuild
      const mesh = meshOf(name);
      if (!mesh?.positions?.length || !indexable(name)) { drop(name); continue; }
      const ix = mods.world.buildIndex(mesh);
      drop(name);
      entries.set(name, { ix, positions: mesh.positions });
      if (!(deadline?.timeRemaining?.() > 2)) break;
    }
    kick();
  }

  /** Queue `names` (default: every in-view sub-part) whose index is missing or stale. */
  function want(names) {
    if (!enabled || disposed) return;
    for (const name of names) {
      if (!indexable(name)) { drop(name); continue; } // matricesAt would place it nowhere
      if (!fresh(name)) queue.add(name);
    }
    kick();
  }
  const inView = () => viewSubParts(part, getView(), { ...part.defaults, ...getParams() });

  function orient(blocked, movingSet) {
    if (!blocked) return null;
    const { a, b } = blocked;
    return movingSet.has(b) && !movingSet.has(a) ? { a: b, b: a } : { a, b };
  }

  /** The drag guard for one drag (the session's collide factory), or null. */
  function guardFor({ handle, snapshot }) {
    if (!enabled || disposed || !mods || !handle) return null;
    const view = getView();
    const start = { ...part.defaults, ...snapshot };
    const { p } = resolveParams(part, start);
    const indexes = new Map();
    for (const name of viewSubParts(part, view, p)) {
      if (fresh(name)) indexes.set(name, entries.get(name).ix);
      else if (viewer.hasSubMesh?.(name)) queue.add(name);
    }
    kick();
    if (indexes.size < 2) return null;
    const names = [...indexes.keys()];
    const matsAt = (params, only) => {
      const { p: pp, d } = resolveParams(part, { ...part.defaults, ...params });
      const want = only ? [...only].filter((n) => indexes.has(n)) : names;
      const m = fastPath.matricesAt(pp, d, want);
      const out = new Map();
      for (const n of want) out.set(n, m.get(n) ?? null);
      return out;
    };
    const allHandles = Object.values(part.handles ?? {});
    const keys = handleKeys(handle, allHandles, start);
    const moving = mods.partGuard.movingSubParts(part, view, start, keys).filter((n) => indexes.has(n));
    if (!moving.length) return null;
    const world = mods.world.createCollisionWorld({ indexes, decl });
    let guard;
    try {
      guard = createDragGuard({ world, matsAt, start, moving, clearance: decl.clearance });
    } catch (err) {
      world.dispose();
      throw err;
    }
    borrowers++;
    const movingSet = new Set(moving);
    let released = false;
    return {
      get rowCount() { return guard.rowCount; },
      get active() { return guard.active; },
      beginFrame: guard.beginFrame,
      linearise: guard.linearise,
      rows: guard.rows,
      isClear: guard.isClear,
      moving,
      settle(from, to, opts) {
        const r = guard.settle(from, to, opts);
        return r.blocked ? { ...r, blocked: orient(r.blocked, movingSet) } : r;
      },
      release() {
        if (released) return;
        released = true;
        world.dispose(); // its indexes are borrowed: this frees none of them, only scratch
        if (--borrowers === 0 && retired.length && !disposed) free(retired.splice(0));
      },
    };
  }

  function tint(pair) {
    if (disposed) return;
    if (!createHighlight) { tinted = pair ? { ...pair } : null; return; }
    tints ??= [createHighlight(viewer), createHighlight(viewer)];
    tinted = null;
    tints.forEach((h) => h.clear());
    if (!pair) return;
    [pair.a, pair.b].forEach((name, i) => {
      const mesh = viewer._subMeshes?.[name];
      if (mesh?.geometry) tints[i].show({ mesh, subPart: name, feature: null });
    });
    tinted = { a: pair.a, b: pair.b };
  }

  return {
    enabled,
    /** Mount: these sub-parts' meshes were just shown (any delivery): re-index them in idle time. */
    delivered(names) {
      if (tinted && names.some((n) => n === tinted.a || n === tinted.b)) tint(tinted);
      want(names);
    },
    /** Mount: the view switched, or Pose mode went live — index what this view shows. */
    refresh() {
      // an index whose sub-part has no mesh any more goes (freed once no drag borrows it)
      for (const name of [...entries.keys()]) if (!meshOf(name)) drop(name);
      want(inView().filter((n) => viewer.hasSubMesh?.(n)));
    },
    guardFor,
    /** The session's blockedChange: tint the pair a held drag stopped at (null: none). */
    tint,
    /** For tests and the browser check: the sub-parts indexed now, and the pair tinted. */
    state: () => ({ indexed: [...entries.keys()].filter(fresh), queued: queue.size, tinted: tinted ? { ...tinted } : null }),
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelTick?.();
      cancelTick = null;
      queue.clear();
      free([...[...entries.values()].map((e) => e.ix), ...retired.splice(0)]);
      entries.clear();
      for (const h of tints ?? []) { try { h.dispose(); } catch { /* best effort */ } }
      tints = null;
    },
  };
}
