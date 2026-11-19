import { viewSubParts, resolveParams, resolveParamsAttributed, recordedParams, buildPosed } from "../part-model.js";
import { newReadSink, expandReads } from "../read-recorder.js";
import { placeOf } from "../sub-part-views.js";

// Build every sub-part of a view in its display (assembly) pose with the given
// Manifold kernel, returning live solids + copied-out meshes. Mirrors the
// `generate` path in jobs.js, but keeps solids LIVE (does NOT call
// kernel.cleanup()) so callers can read exact solid facts (volume/genus/empty)
// before they free the kernel. Meshes are JS-owned arrays and survive cleanup.
//
// `reads` (a read sink) records every param the whole view read, build AND place.
// `readsBySubPart` (a Map) is filled with name → the expanded params that
// sub-part's build() read, place() reads EXCLUDED — the same split jobs.js's
// displayWithReads makes: build runs on per-sub-part recorded p/d, place on the
// view's own p/d (never the sub-part's recorder), so a pose-only param (a lid
// angle read only in place()) never looks like a rebuild.
export function buildView(kernel, part, view, params = {}, { reads, readsBySubPart } = {}) {
  const { p, d } = resolveParams(part, params, undefined, reads);
  const attribution = readsBySubPart ? resolveParamsAttributed(part, params).attribution : undefined;
  // Cache round for the whole view. The name is the ORACLE's, deliberately not the
  // display sub-part names the generate path brackets under: a distinct partition
  // still reuses those solids (the cache indexes entries by content hash across
  // partitions), while keeping this round's own eviction away from the geometry the
  // viewer is showing — bracketing under the display names would make running the
  // oracle throw away the display cache. One name per view also bounds retention:
  // verify walks its cases through here, so each case evicts the previous rather
  // than accumulating every case's geometry at once.
  kernel.beginSubPart?.(`oracle:view:${view}`);
  // The kernel's build warnings (a thin implicit feature, a skipped fillet), drained per
  // sub-part as jobs.js does — first once to drop an earlier build's stragglers.
  kernel.takeBuildWarnings?.();
  try {
    return viewSubParts(part, view, p).map((name) => {
      const solid = readsBySubPart
        ? buildRecorded(kernel, part, name, view, p, d, attribution, readsBySubPart)
        : buildPosed(kernel, part, name, { purpose: "display", view, p, d });
      const mesh = solid.toMesh();
      return { name, solid, mesh, warnings: kernel.takeBuildWarnings?.() ?? [] };
    });
  } finally { kernel.endSubPart?.(); }
}

// buildPosed split in two: build() on recorded p/d (a fresh sink per sub-part),
// place() on the p/d the view resolved — so place reads land only in the
// view-level `reads` sink, never in the sub-part's.
function buildRecorded(kernel, part, name, view, p, d, attribution, readsBySubPart) {
  const sp = part.parts[name];
  const sink = newReadSink();
  sink.attribution = attribution;
  const rec = recordedParams({ p, d }, sink);
  const built = sp.build(kernel, rec.p, rec.d);
  const place = placeOf(sp);
  const solid = place ? place(built, { view, purpose: "display", p, d }) : built;
  readsBySubPart.set(name, expandReads(sink));
  return solid;
}
