import { relevanceHash } from "./param-deps.js";

// Whether each sub-part's cached display mesh is still valid ("Layer 1": skip
// regenerating sub-parts whose inputs didn't change). Each delivered mesh is
// stamped with the params its REAL build read (recorded in the worker, jobs.js),
// their values, and the view it was built for. It stays current while those are
// unchanged — sound for a deterministic build: unchanged reads replay the same
// path (spec 2026-10-03). Nothing is predicted; a sub-part with no stamp is not
// current. `params` is a stable object mutated in place; the rest are getters.
export function createMeshCache(part, viewer, { params, getView, getParamsVersion, isCaching }) {
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
    record: (name, reads) => {
      const keys = reads == null ? null : [...new Set(reads)].sort();
      stamps[name] = { keys, hash: hashOf(keys), view: getView() };
    },
    readsOf: (name) => (stamps[name]?.keys ? new Set(stamps[name].keys) : null),
    forget: (name) => { delete stamps[name]; },
  };
}
