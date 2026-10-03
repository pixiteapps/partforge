import { viewSubParts, resolveParams, buildPosed } from "./part-model.js";

// Collision check for an assembled view: build each sub-part in its display
// (assembly) pose and return the pairs whose solid-intersection volume exceeds
// `tolerance` (mm³) — i.e. parts that interpenetrate rather than merely touch.
// Parts meant to fit together (e.g. a block seated in a pocket void) read ~0 and
// don't trip it. Manifold-only (needs Solid.intersect + Solid.volume); meant for
// part tests so an author/LLM editing a part sees collisions fail.
//   → [{ a, b, volume, location }] for each offending pair (empty = no collisions)
export function assemblyOverlaps(kernel, part, view, params = {}, { tolerance = 1, reads } = {}) {
  const { p, d } = resolveParams(part, params, undefined, reads);
  // Same posed solids buildView builds, so this round is almost entirely hits off
  // that one; only the pairwise intersects below are new. Its own oracle partition,
  // for the reason buildView's comment gives.
  kernel.beginSubPart?.(`oracle:overlaps:${view}`);
  let posed;
  try {
    posed = viewSubParts(part, view, p).map((name) => ({
      name,
      solid: buildPosed(kernel, part, name, { purpose: "display", view, p, d }),
    }));
  } catch (e) { kernel.endSubPart?.(); throw e; } // never strand the round on a failed build

  const overlaps = [];
  for (let i = 0; i < posed.length; i++) {
    for (let j = i + 1; j < posed.length; j++) {
      const inter = posed[i].solid.intersect(posed[j].solid);
      const volume = inter.volume();
      if (volume > tolerance) {
        // location = the intersection's bounding-box center — a nearby indicator, not
        // an exact contact point: for a disjoint (multi-region) intersection it is the
        // midpoint of those regions and can land in the empty space between them.
        overlaps.push({ a: posed[i].name, b: posed[j].name, volume, location: inter.boundingBox().center });
      }
    }
  }
  kernel.endSubPart?.();
  kernel.cleanup?.(); // free the per-check WASM objects (cached solids are pinned)
  return overlaps;
}
