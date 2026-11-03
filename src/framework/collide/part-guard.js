// A drag guard for a part (guard.js is part-agnostic): the matsAt it reads resolves the
// part's own params, and its world takes the part's `collisions` block. What Pose mode and
// the solver tests build one from. Pure, like the guard and the world.
import { createDragGuard } from "./guard.js";
import { createCollisionWorld, poseMatrices, relativeMatsAt } from "./world.js";
import { normalizeCollisions } from "./declaration.js";
import { resolveParams } from "../part-model.js";
import { sameMat } from "./motion.js";

/**
 * The in-view sub-parts whose placement any of `keys` moves at `params`: each key nudged
 * by `step` either way (a key at a range end still moves one way), placements compared.
 * A sub-part that a key rebuilds rather than re-places is not caught — the guard's meshes
 * are rigid, so such a piece has no business in `moving` anyway.
 */
export function movingSubParts(part, view, params, keys, { step = 1e-3 } = {}) {
  const base = { ...part.defaults, ...params };
  const at = (q) => { const { p, d } = resolveParams(part, q); return poseMatrices(part, view, p, d); };
  const m0 = at(base);
  const out = new Set();
  for (const k of keys) {
    if (typeof base[k] !== "number") continue;
    for (const dv of [step, -step]) {
      let m1;
      try { m1 = at({ ...base, [k]: base[k] + dv }); } catch { continue; }
      for (const [name, m] of m1) if (!sameMat(m, m0.get(name))) out.add(name);
    }
  }
  return [...m0.keys()].filter((n) => out.has(n));
}

/**
 * `{ guard, world, matsAt }` for one drag of `part` in `view`, starting at params `start`.
 * `meshes` (name → mesh, posed at `meshAt`, default `start`) builds a world; or pass a
 * `world` already built over meshes posed at `meshAt`. `matsAt(params)` resolves the part
 * at `{ ...defaults, ...params }` and carries each mesh from `meshAt` to that pose (with
 * `matsAt(params, names)`, only those names' — the rest read identity) — run
 * the solve inside withDeriveMemo and the evaluation's derive and this one are the same.
 */
export function createPartGuard({ part, view = "assembly", meshes, world, start, meshAt = start, moving, decl = normalizeCollisions(part) }) {
  const full = (params) => ({ ...part.defaults, ...params });
  const m = resolveParams(part, full(meshAt));
  const relMats = relativeMatsAt(part, view, m.p, m.d);
  // `only` (optional names): just those placements (the guard's rows read no others)
  const matsAt = (params, only) => { const { p, d } = resolveParams(part, full(params)); return relMats(p, d, only); };
  const w = world ?? createCollisionWorld({ meshes, decl });
  const guard = createDragGuard({ world: w, matsAt, start: full(start), moving, clearance: decl?.clearance });
  return { guard, world: w, matsAt };
}
