// Geometry-free pose probe over a view — see pose-probe-core.js for the probe
// session itself and the trust model. This wrapper resolves params/derive and
// walks the view's sub-parts; it stays separate so lint can import the core
// without dragging in the part-model/jobs layer (purity).
import { probeSubPartPose } from "./pose-probe-core.js";
import { viewSubParts, resolveParamsAttributed, recordedParams } from "./part-model.js";
import { newReadSink, expandReads } from "./read-recorder.js";
// From the import-free leaf, never fonts/images/vectors.js: vectors.js reaches paper
// (test/mount-no-paper.test.js).
import { fontsFor, imagesFor, vectorsFor } from "./asset-decls.js";
import { h, byteAwareReplacer } from "./geometry/solid-hash.js";

// The sources behind every NAMED asset a build can reach. A build says
// `k.text2d(s, { font: "face" })`, `k.heightfield("img")` or `k.vector2d("art")`,
// and the probe sees only the name — which stays the same whichever font,
// image or artwork a control has picked. Without this, a font pick hashed
// identically before and after, so the fast path re-posed the OLD letters
// instead of rebuilding them (the Lattice Box's raised text kept its previous
// typeface while the pocket cut from the same text updated, 2026-10-02). Folded
// into every trusted sub-part's baseHash: coarser than tracking which sub-part
// names which asset, and the cost of that is only a rebuild on an asset change.
// Serialized with byteAwareReplacer, not h(): h() reads an ArrayBuffer as {},
// so two byte-valued fonts would hash alike — the same bug one level down.
function assetSources(part, p) {
  return [fontsFor(part, p) ?? null, imagesFor(part, p) ?? null, vectorsFor(part, p) ?? null];
}

// Probe every subpart the view shows. Never throws; a failing/queried/weird
// subpart yields { trusted: false } and the others still probe.
export function probePoses(part, view, params, { scope = "full", purpose = "display" } = {}) {
  const out = new Map();
  let resolved, assets;
  try {
    resolved = resolveParamsAttributed(part, params);
    assets = h("assets", JSON.stringify(assetSources(part, resolved.p), byteAwareReplacer));
  } catch {
    for (const name of viewSubParts(part, view, params)) out.set(name, { trusted: false });
    return out;
  }
  for (const name of viewSubParts(part, view, params)) {
    const sink = newReadSink();
    sink.attribution = resolved.attribution;
    const rec = recordedParams(resolved, sink);
    const entry = probeSubPartPose(part.parts[name], { view, purpose, p: rec.p, d: rec.d }, { scope });
    // Assets fold in only outside place scope: a place probe hashes nothing
    // geometry-dependent, and the mesh cache's asset reads cover the font case.
    out.set(name, entry.trusted
      ? { ...entry, baseHash: scope === "place" ? entry.baseHash : h("with-assets", entry.baseHash, assets), reads: expandReads(sink) }
      : entry);
  }
  return out;
}
