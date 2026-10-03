// Decision layer of the pose fast path (no DOM, no three.js — viewer/cache are
// injected). At mesh delivery each subpart is STAMPED with its probe result at
// the delivered params; on a later edit, a stale subpart whose baseHash is
// unchanged gets its delivered mesh re-posed in the viewer (delta vs. the
// delivered pose) and is re-stamped current — no worker job. Everything else
// falls through to the normal regen loop.
import { viewSubParts } from "./part-model.js";
import { probePoses } from "./pose-probe.js";
import { poseDelta } from "./geometry/pose.js";

export function createPoseFastPath(part, viewer, cache, { params, getView, getParamsVersion }) {
  const stamps = {}; // name -> probe entry captured when that subpart's mesh was delivered

  // Memoize the probe per (paramsVersion, view), so it runs once per change
  // rather than per sub-part; params is the live in-place-mutated object.
  let probeKey = null, probeMap = null;
  const probeFor = () => {
    const key = `${getParamsVersion()}|${getView()}`;
    if (probeKey !== key) { probeKey = key; probeMap = probePoses(part, getView(), params); }
    return probeMap;
  };

  return {
    // Stamp a freshly delivered mesh with its probe result at the current params.
    // (The caller only records on non-stale builds — buildDone() guarantees the
    // live params are the ones the worker built with.)
    recordDelivered(name) {
      stamps[name] = probeFor().get(name);
    },

    // Drop a subpart's stamp: the mesh in the viewer is no longer known to
    // correspond to any probed pose. Used when meshes are SHOWN without being
    // recorded — a build delivered stale because animation frames kept bumping
    // the version is displayed best-effort, but its geometry was not built at
    // the live params, so no stamp may describe it. Without this the next edit
    // would re-pose that newer mesh off the PREVIOUS delivery's stamp, i.e.
    // apply a delta measured against geometry that is no longer on screen.
    forget(name) {
      delete stamps[name];
    },

    // Re-pose every visible stale subpart whose base geometry is unchanged.
    // Returns the NAMES repaired (empty = nothing pose-only to do). Names, not a
    // count: a slider drag repairs the same subpart on every input event, so only
    // the caller's set union across a drag is a meaningful "how many were posed".
    repair() {
      const posed = [];
      const poses = probeFor();
      for (const name of viewSubParts(part, getView(), params)) {
        if (cache.isCurrent(name) || !viewer.hasSubMesh(name)) continue;
        const now = poses.get(name), was = stamps[name];
        if (!now?.trusted || !was?.trusted || now.baseHash !== was.baseHash) continue;
        viewer.setSubPose(name, poseDelta(now.pose, was.pose));
        // Same geometry, new pose: keep the delivered build's recorded keys,
        // re-hashed at the live params (spec §2). Task 4 adds the pose probe's
        // own reads. An unknown stamp stays unknown.
        const had = cache.readsOf(name);
        cache.record(name, had ? [...had] : undefined); // current again — regen loop sees nothing missing
        posed.push(name);
      }
      return posed;
    },
  };
}
