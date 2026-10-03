import { viewSubParts, resolveParams, buildPosed } from "../part-model.js";

// Build every sub-part of a view in its display (assembly) pose with the given
// Manifold kernel, returning live solids + copied-out meshes. Mirrors the
// `generate` path in jobs.js, but keeps solids LIVE (does NOT call
// kernel.cleanup()) so callers can read exact solid facts (volume/genus/empty)
// before they free the kernel. Meshes are JS-owned arrays and survive cleanup.
export function buildView(kernel, part, view, params = {}, { reads } = {}) {
  const { p, d } = resolveParams(part, params, undefined, reads);
  // Cache round for the whole view. The name is the ORACLE's, deliberately not the
  // display sub-part names the generate path brackets under: a distinct partition
  // still reuses those solids (the cache indexes entries by content hash across
  // partitions), while keeping this round's own eviction away from the geometry the
  // viewer is showing — bracketing under the display names would make running the
  // oracle throw away the display cache. One name per view also bounds retention:
  // verify walks its cases through here, so each case evicts the previous rather
  // than accumulating every case's geometry at once.
  kernel.beginSubPart?.(`oracle:view:${view}`);
  try {
    return viewSubParts(part, view, p).map((name) => {
      const solid = buildPosed(kernel, part, name, { purpose: "display", view, p, d });
      return { name, solid, mesh: solid.toMesh() };
    });
  } finally { kernel.endSubPart?.(); }
}
