import { relevanceHash } from "./param-deps.js";

// Whether each sub-part's cached display mesh is still valid ("Layer 1": skip
// regenerating sub-parts whose inputs didn't change). Each delivered mesh is
// stamped with the params its REAL build read (recorded in the worker, jobs.js),
// their values, and the view it was built for. It stays current while those are
// unchanged — sound for a deterministic build: unchanged reads replay the same
// path (spec 2026-10-03). Nothing is predicted; a sub-part with no stamp is not
// current. `params` is a stable object mutated in place; the rest are getters.
export function createMeshCache(viewer, { params, getView, getParamsVersion, isCaching }) {
  const stamps = {}; // name -> { keys: string[] | null (null = every param), hash, view }

  const hashOf = (keys) => {
    if (!isCaching()) return `v${getParamsVersion()}`; // caching off: any edit invalidates
    return relevanceHash(keys ?? Object.keys(params), params);
  };

  return {
    isCurrent: (name) => {
      const s = stamps[name];
      return viewer.hasSubMesh(name) && s != null && s.view === getView() && s.hash === hashOf(s.keys);
    },
    // Stamp a mesh built at the LIVE params (mount's fresh branch, or the pose
    // fast path's in-place repair). `reads` undefined = unknown → every param.
    // `view` is the view the build was DISPATCHED for: a tab switch doesn't bump
    // the params version, so a reply can land fresh after the live view moved.
    record: (name, reads, view = getView()) => {
      const keys = reads == null ? null : [...new Set(reads)].sort();
      stamps[name] = { keys, hash: hashOf(keys), view };
    },
    // The recorded keys, or null for BOTH "no stamp" and "every-param stamp" —
    // the pose fast path relies on null meaning unknown. hasStamp tells them apart.
    readsOf: (name) => (stamps[name]?.keys ? new Set(stamps[name].keys) : null),
    hasStamp: (name) => stamps[name] != null,
    forget: (name) => { delete stamps[name]; },
  };
}
