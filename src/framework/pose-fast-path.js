// The pose ladder: the decision layer that poses delivered meshes in the viewer
// without a worker job (no DOM, no three.js — viewer/cache are injected). Every
// matrix it applies is ABSOLUTE relative to the delivered mesh, so nothing
// accumulates across frames and setSubGeometry's matrix reset stays correct.
//
// A mesh's delivery frame (the mesh cache's stamp, spec §3–4) picks the rung:
// The applied matrix is place(now) · delta (canonical) or delta (posed), where
// delta is the stamp's stored build/full delta: identity at every delivery (and
// after forget), set only by a rung-2 or posed repair. Storing it is what keeps a
// later rung-1 pose or apply() (an unrelated param, a view switch) from snapping
// a delta-repaired mesh back to its delivered pose while the cache says current.
//
// - canonical + current — rung 1: posed by place() at the live params
//   (place-scope probe) over the stored delta. An untrusted live place() clears
//   the pose and forgets the cache stamp so the regen loop rebuilds it (posed, at
//   those params) — except on mount's fresh-delivery apply ({ fresh: true }),
//   where the mesh was just built at these params: there the pose is cleared and
//   the stamp kept, so a host/worker probe disagreement cannot loop
//   forget→rebuild. A matrix equal to the one last applied is never re-sent to
//   the viewer (setSubPose restarts the contact shadow), and repair() reports a
//   rung-1 name only when its matrix actually CHANGED, so the debug `posed`
//   count ("produced a pose and no job") stays honest during playback: a
//   sub-part whose place() ignores the animated param is not counted.
// - canonical + stale — rung 2: a trailing transform INSIDE build. When the live
//   build-scope probe is trusted with the delivered baseHash, the delta becomes
//   delta(build now, build delivered), the matrix place(now) · delta, and the
//   mesh is re-stamped with the build's reads alone (place() reads are rung 1's).
//   An untrusted live place() refuses the rung (Ruling F): the regen loop rebuilds.
// - posed (the worker baked place() in): today's full-scope delta; apply()
//   re-applies the stored delta.
// Anything else falls through to the normal regen loop.
import { viewSubParts } from "./part-model.js";
import { probePoses } from "./pose-probe.js";
import { composePose, poseDelta, mulMat4 } from "./geometry/pose.js";

export function createPoseFastPath(part, viewer, cache, { params, getView, getParamsVersion }) {
  // name -> { frame, entry, delta }: the delivery frame; at the delivered params,
  // the build-scope probe entry (canonical — rung 2's baseline) or the
  // full-scope one (posed); and the delta the last repair applied (null =
  // identity, as delivered).
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

  // The matrix this module last applied per name (null = cleared, absent =
  // never applied: unknown). An unchanged matrix never reaches the viewer:
  // setSubPose bumps the match generation and restarts the realistic contact
  // shadow, and rung 1 re-poses every current canonical sub-part on every param
  // change. recordDelivered/forget set null because setSubGeometry reset the
  // matrix, so a delivery's first non-identity pose always lands. Returns true
  // only when a non-null matrix actually changed (repair's rung-1 count).
  const shown = {};
  const same = (a, b) => a === b || (a != null && b != null && a.every((v, i) => v === b[i]));
  const setPose = (name, m) => {
    if (name in shown && same(shown[name], m)) return false;
    shown[name] = m;
    viewer.setSubPose(name, m);
    return m != null;
  };

  // Pose each in-view, meshed name from its frame (an override wins over the
  // cache stamp's — mount's stale-shown branch forgets the stamp first).
  // `fresh` (mount's fresh-delivery call only): an untrusted live place() clears
  // the pose but keeps the cache stamp — the mesh was just built at these very
  // params, so forgetting would rebuild at identical params and disagree again.
  // Returns the names given a CHANGED place pose (used by repair's count).
  function poseByFrame(names, frames, { fresh = false } = {}) {
    const moved = [];
    const inView = new Set(viewSubParts(part, getView(), params));
    for (const name of names) {
      if (!inView.has(name) || !viewer.hasSubMesh(name)) continue;
      const frame = frames?.[name] ?? cache.frameOf(name);
      const delta = stamps[name]?.delta ?? null; // no stamp (stale-shown): as delivered
      if (frame === "posed") { setPose(name, delta); continue; }
      if (frame !== "canonical") continue; // unknown frame: nothing to say about the mesh
      const now = probe("place").get(name);
      if (!now?.trusted) { if (!fresh) cache.forget(name); setPose(name, null); continue; }
      const place = composePose(now.pose);
      if (setPose(name, delta ? mulMat4(place, delta) : place)) moved.push(name);
    }
    return moved;
  }
  const apply = (names, frames, opts) => { poseByFrame(names, frames, opts); };

  return {
    // Stamp a freshly delivered mesh with its probe baseline at the current
    // params, by the frame the cache recorded for it. (The caller only records on
    // non-stale builds — buildDone() guarantees the live params are the ones the
    // worker built with.)
    recordDelivered(name) {
      const frame = cache.frameOf(name) ?? "posed";
      stamps[name] = { frame, entry: probe(frame === "canonical" ? "build" : "full").get(name), delta: null };
      shown[name] = null; // setSubGeometry just reset the mesh's matrix
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
      shown[name] = null; // the shown-unrecorded mesh arrived with its matrix reset
    },

    // Pose names right after a delivery or a view switch. See the header.
    apply,

    // One call per param change. Re-poses every visible current canonical
    // subpart from place() (rung 1) and every visible stale subpart whose base
    // geometry is unchanged (rung 2, posed delta). Returns the NAMES that change
    // posed without a job — rung 2 and posed repairs always, rung 1 only when
    // its matrix moved (empty = nothing pose-only to do). Names, not a count: a
    // slider drag poses the same subpart on every input event, so only the
    // caller's set union across a drag is meaningful.
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
        let matrix, delta, now;
        if (was.frame === "canonical") {
          now = probe("build").get(name);
          if (!now?.trusted || now.baseHash !== was.entry.baseHash) continue;
          const place = probe("place").get(name);
          if (!place?.trusted) continue;
          delta = poseDelta(now.pose, was.entry.pose);
          matrix = mulMat4(composePose(place.pose), delta);
        } else {
          now = probe("full").get(name);
          if (!now?.trusted || now.baseHash !== was.entry.baseHash) continue;
          matrix = delta = poseDelta(now.pose, was.entry.pose);
        }
        was.delta = delta;
        setPose(name, matrix);
        // Same geometry, new pose: the delivered build's reads plus whatever the
        // probe read at THIS pose, re-hashed at the live params (spec §2), keeping
        // the delivery frame. A canonical stamp takes the build-scope probe's
        // reads only — place() reads stay out, since rung 1 owns them (spec §3:
        // recorded keys are the build's); a posed one the full scope's. An
        // unknown stamp stays unknown.
        const had = cache.readsOf(name);
        cache.record(name, had ? [...had, ...(now.reads ?? [])] : undefined, getView(), was.frame); // current again — regen loop sees nothing missing
        posed.push(name);
      }
      return [...poseByFrame(placeOnly), ...posed];
    },
  };
}
