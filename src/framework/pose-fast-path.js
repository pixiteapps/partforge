// The pose ladder: the decision layer that poses delivered meshes in the viewer
// without a worker job (no DOM, no three.js — viewer/cache are injected). Every
// matrix it applies is ABSOLUTE relative to the delivered mesh, so nothing
// accumulates across frames and setSubGeometry's matrix reset stays correct.
//
// A mesh's delivery frame (the mesh cache's stamp, spec §3–4) picks the rung:
// - canonical + current — rung 1: posed by place() alone at the live params
//   (place-scope probe). No stamp, no delta. An untrusted live place() forgets
//   the cache stamp so the regen loop rebuilds it (posed, at those params).
// - canonical + stale — rung 2: a trailing transform INSIDE build. When the live
//   build-scope probe is trusted with the delivered baseHash, the matrix is
//   place(now) · delta(build now, build delivered) and the mesh is re-stamped.
// - posed (the worker baked place() in): today's full-scope delta, unchanged.
// Anything else falls through to the normal regen loop.
import { viewSubParts } from "./part-model.js";
import { probePoses } from "./pose-probe.js";
import { composePose, poseDelta, mulMat4 } from "./geometry/pose.js";

export function createPoseFastPath(part, viewer, cache, { params, getView, getParamsVersion }) {
  // name -> { frame, entry }: the delivery frame and, at the delivered params,
  // the build-scope probe entry (canonical — rung 2's baseline) or the
  // full-scope one (posed).
  const stamps = {};

  // Three probe maps memoized per (paramsVersion, view), each computed lazily on
  // first use — a part with no canonical sub-parts never runs the place or build
  // probe, and vice versa. params is the live in-place-mutated object.
  let probeKey = null, probeMaps = {};
  const probe = (scope) => {
    const key = `${getParamsVersion()}|${getView()}`;
    if (probeKey !== key) { probeKey = key; probeMaps = {}; }
    return (probeMaps[scope] ??= probePoses(part, getView(), params, { scope }));
  };

  // Pose each in-view, meshed name from its frame (an override wins over the
  // cache stamp's — mount's stale-shown branch forgets the stamp first).
  function apply(names, frames) {
    const inView = new Set(viewSubParts(part, getView(), params));
    for (const name of names) {
      if (!inView.has(name) || !viewer.hasSubMesh(name)) continue;
      const frame = frames?.[name] ?? cache.frameOf(name);
      if (frame === "posed") { viewer.setSubPose(name, null); continue; }
      if (frame !== "canonical") continue; // unknown frame: nothing to say about the mesh
      const now = probe("place").get(name);
      if (now?.trusted) viewer.setSubPose(name, composePose(now.pose));
      else { cache.forget(name); viewer.setSubPose(name, null); }
    }
  }

  return {
    // Stamp a freshly delivered mesh with its probe baseline at the current
    // params, by the frame the cache recorded for it. (The caller only records on
    // non-stale builds — buildDone() guarantees the live params are the ones the
    // worker built with.)
    recordDelivered(name) {
      const frame = cache.frameOf(name) ?? "posed";
      stamps[name] = { frame, entry: probe(frame === "canonical" ? "build" : "full").get(name) };
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

    // Pose names right after a delivery or a view switch. See the header.
    apply,

    // One call per param change. Re-poses every visible stale subpart whose base
    // geometry is unchanged (rung 2, posed delta) and returns the NAMES repaired
    // (empty = nothing pose-only to do). Names, not a count: a slider drag repairs
    // the same subpart on every input event, so only the caller's set union
    // across a drag is meaningful. Rung 1 is not a repair: every CURRENT
    // canonical name is re-posed by apply() here and is not returned.
    repair() {
      const posed = [], placeOnly = [];
      for (const name of viewSubParts(part, getView(), params)) {
        if (!viewer.hasSubMesh(name)) continue;
        if (cache.isCurrent(name)) {
          if (cache.frameOf(name) === "canonical") placeOnly.push(name);
          continue;
        }
        const was = stamps[name];
        if (!was?.entry?.trusted) continue;
        let matrix, placeReads = [], now;
        if (was.frame === "canonical") {
          now = probe("build").get(name);
          if (!now?.trusted || now.baseHash !== was.entry.baseHash) continue;
          const place = probe("place").get(name);
          if (!place?.trusted) continue;
          matrix = mulMat4(composePose(place.pose), poseDelta(now.pose, was.entry.pose));
          placeReads = place.reads ?? [];
        } else {
          now = probe("full").get(name);
          if (!now?.trusted || now.baseHash !== was.entry.baseHash) continue;
          matrix = poseDelta(now.pose, was.entry.pose);
        }
        viewer.setSubPose(name, matrix);
        // Same geometry, new pose: the delivered build's reads plus whatever the
        // probes read at THIS pose, re-hashed at the live params (spec §2), keeping
        // the delivery frame. An unknown stamp stays unknown.
        const had = cache.readsOf(name);
        cache.record(name, had ? [...had, ...(now.reads ?? []), ...placeReads] : undefined, getView(), was.frame); // current again — regen loop sees nothing missing
        posed.push(name);
      }
      apply(placeOnly);
      return posed;
    },
  };
}
