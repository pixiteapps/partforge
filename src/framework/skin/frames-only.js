// Is a slider change confined to the k.implicit specs' `frames` tables? Then the viewer can
// deform the last exact mesh by skinning instead of waiting for a rebuild
// (docs/superpowers/specs/2026-10-31-implicit-pose-drag-design.md). Pure leaf, worker-safe.
import { implicitCallId } from "../geometry/implicit/call-id.js";

const sameKeys = (a, b) => {
  const ka = Object.keys(a ?? {}), kb = Object.keys(b ?? {});
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
};

// A caller must require skinnable on both sides AND equal probe shapeHash AND framesOnlyChange.
/**
 * True when both builds made the same k.implicit calls (same count, same shape per call, same
 * frame names in the same order) and nothing differs but values inside `frames`.
 */
export function framesOnlyChange(oldSpecs, newSpecs) {
  if (!Array.isArray(oldSpecs) || !Array.isArray(newSpecs)) return false;
  if (oldSpecs.length !== newSpecs.length || oldSpecs.length === 0) return false;
  for (let i = 0; i < oldSpecs.length; i++) {
    const a = oldSpecs[i], b = newSpecs[i];
    if (implicitCallId(a, oldSpecs.slice(0, i)) !== implicitCallId(b, newSpecs.slice(0, i))) return false;
    if (!sameKeys(a?.frames, b?.frames)) return false;
  }
  return true;
}
