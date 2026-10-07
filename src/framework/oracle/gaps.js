import { buildView } from "./build.js";
import { cachedBVH, disposeBVHs } from "./bvh.js";

// A measured pair distance at or below this (mm) counts as touching — absorbs
// posing float error while staying far below any real print clearance.
export const CONTACT_EPS = 1e-3;

// Default near-miss threshold (mm): pairs closer than this without touching are
// the "did you mean these to touch?" signal.
export const GAP_THRESHOLD = 0.5;

// Canonical order-insensitive pair identity — the one rule for "the same pair"
// shared by measure's overlap exclusion and verify's declared-pair matching.
export const pairKey = (a, b) => [a, b].sort().join("×");

// Minimum surface-to-surface distance for every sub-part pair of pre-built posed
// meshes ([{ name, mesh }] — buildView output). Distance 0 = touching or
// interpenetrating surfaces; callers filter. Pairs involving an empty mesh are
// skipped (the watertight gate owns that failure). Pure mesh math — both backends.
// `bvhCache` is an optional caller-owned Map — see cachedBVH for the doctrine;
// measure() draws min-wall's index out of the same one, so each sub-part mesh is
// indexed once, not twice.
// `prior(a, b) → {distance, at}|undefined` lets a caller skip a pair's distance
// query entirely (the measure memo: both sub-parts' hashes matched a stored
// pair). `onPair(a, b, gap)` is called for every pair, computed or reused, so
// the caller can re-store what it just confirmed or learned. BVHs are built
// lazily, one per sub-part, only for a sub-part that has at least one pair not
// covered by `prior` — an all-unchanged view builds no BVH at all.
//   → [{ a, b, distance, at: [x,y,z] }]
export function meshGaps(built, { bvhCache, prior, onPair } = {}) {
  const hasTris = (m) => (m.indices ? m.indices.length > 0 : m.positions.length > 0);
  const items = built.filter(({ mesh }) => hasTris(mesh));
  const bvhOf = new Map();
  const bvh = (it) => {
    if (!bvhOf.has(it.name)) bvhOf.set(it.name, cachedBVH(it.mesh, bvhCache));
    return bvhOf.get(it.name);
  };
  const out = [];
  try {
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i].name, b = items[j].name;
        const reused = prior?.(a, b);
        const { distance, at } = reused ?? bvh(items[i]).distanceTo(bvh(items[j]));
        const g = { a, b, distance, at };
        onPair?.(a, b, { distance, at });
        out.push(g);
      }
    }
  } finally {
    // With no caller Map these indexes are ours; with one, its owner frees them.
    if (!bvhCache) disposeBVHs(bvhOf.values());
  }
  return out;
}

// Near-miss check for an assembled view — the complement of assemblyOverlaps:
// sub-part pairs that *almost* touch (0 < distance < threshold mm) in the display
// pose. Same posing path as assemblyOverlaps; no kernel booleans, so it runs on
// Manifold and OCCT alike.
//   → [{ a, b, distance, at }] (empty = no near misses)
export function assemblyGaps(kernel, part, view, params = {}, { threshold = GAP_THRESHOLD } = {}) {
  if (!(threshold > CONTACT_EPS)) {
    throw new Error(`assemblyGaps: threshold must exceed CONTACT_EPS (${CONTACT_EPS} mm), got ${threshold}`);
  }
  const gaps = meshGaps(buildView(kernel, part, view, params));
  kernel.cleanup?.(); // free the per-check WASM objects (meshes are JS-owned copies)
  return gaps.filter((g) => g.distance > CONTACT_EPS && g.distance < threshold);
}
