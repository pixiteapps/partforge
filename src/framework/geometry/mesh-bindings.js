// Pose bindings as Manifold vertex properties (docs/superpowers/specs/2026-10-31-implicit-pose-drag-design.md).
// A preview k.implicit binds each vertex to ≤ 2 frames (implicit/bindings.js); the backend
// stores them as four extra properties after xyz — numProp 7: [codeA, codeB, weight, check] —
// so they ride through every boolean, and toMesh decodes them per output corner.
//
// A code names a frame of one k.implicit CALL in the sub-part: slot · BIND_CALL_STRIDE + frame
// (frame = 1 + its index in the call's frame table; 0 = unbound). A boolean INTERPOLATES the
// properties of the vertices it cuts between, so a cut vertex can carry a blend of two
// codes; `check` (a checksum of both codes) and the integer test make such a corner decode
// as unbound, never as some third frame. A plain (property-less) operand's vertices come
// out with zero properties — unbound too.
//
// Pure, DOM-free and three-free: the worker and the main thread (mergeBindings) both load it.

/** Codes per call slot: a frame index (≤ MAX_BIND_FRAMES = 1023) fits below it. */
export const BIND_CALL_STRIDE = 1024;
/** The props a binding adds after xyz. */
export const BIND_PROPS = 4;

const checkOf = (a, b) => (a * 31 + b) % 97;

/** `bind` (bindVertices' per-vertex frames) → Float32Array(nVert · 4) of [codeA, codeB, weight, check]. */
export function encodeBindingProps(bind, slot) {
  const { frameA, frameB, weight } = bind;
  const n = frameA.length, out = new Float32Array(n * BIND_PROPS), base = slot * BIND_CALL_STRIDE;
  for (let v = 0, o = 0; v < n; v++, o += BIND_PROPS) {
    const a = frameA[v] ? base + frameA[v] : 0, b = frameB[v] ? base + frameB[v] : 0;
    out[o] = a; out[o + 1] = b; out[o + 2] = weight[v]; out[o + 3] = checkOf(a, b);
  }
  return out;
}

// A code's (slot, local frame) if it names a frame of a known call, else null.
const frameOf = (code, calls) => {
  if (!Number.isInteger(code) || code <= 0) return null;
  const local = code % BIND_CALL_STRIDE, slot = Math.floor(code / BIND_CALL_STRIDE);
  if (local < 1 || slot >= calls.length || local > calls[slot].frames.length) return null;
  return calls[slot].id + ":" + calls[slot].frames[local - 1];
};

/**
 * A MeshGL's bindings per corner (triVerts order — the order creasedNormals emits its
 * non-indexed output in), or null when it carries none (numProp < 7) or no call was made.
 * `calls[slot] = { id, frames }`. `frames[0]` is null (unbound); the rest are
 * "<call id>:<frame name>" in order of first sight.
 */
export function decodeBindings(g, calls) {
  if (!g || !(g.numProp >= 3 + BIND_PROPS) || !calls?.length) return null;
  const np = g.numProp, vp = g.vertProperties, tris = g.triVerts, nC = tris.length;
  const frameA = new Uint16Array(nC), frameB = new Uint16Array(nC), weight = new Float32Array(nC).fill(1);
  const frames = [null], index = new Map();
  const idOf = (name) => {
    let i = index.get(name);
    if (i === undefined) { i = frames.length; frames.push(name); index.set(name, i); }
    return i;
  };
  // Decoded per vertex once (a vertex is shared by ~6 corners); -1 = not yet decoded.
  const nV = (vp.length / np) | 0;
  const vA = new Int32Array(nV).fill(-1), vB = new Uint16Array(nV), vW = new Float32Array(nV);
  for (let c = 0; c < nC; c++) {
    const v = tris[c];
    if (vA[v] < 0) {
      const o = v * np + 3, a = vp[o], b = vp[o + 1], w = vp[o + 2], chk = vp[o + 3];
      const nameA = w >= 0 && w <= 1 && Number.isInteger(b) && chk === checkOf(a, b) ? frameOf(a, calls) : null;
      if (nameA === null) { vA[v] = 0; vB[v] = 0; vW[v] = 1; }
      else {
        const nameB = frameOf(b, calls);
        vA[v] = idOf(nameA);
        if (nameB === null) { vB[v] = 0; vW[v] = 1; } else { vB[v] = idOf(nameB); vW[v] = w; }
      }
    }
    frameA[c] = vA[v]; frameB[c] = vB[v]; weight[c] = vW[v];
  }
  return { frameA, frameB, weight, frames };
}

/**
 * Concatenate per-corner binding sets: `list[i]` (or null/undefined: unbound) covers
 * `counts[i]` corners. One merged `frames` table keyed by string; null when no entry has
 * bindings. An entry without bindings contributes unbound corners (frame 0, weight 1).
 */
export function mergeBindings(list, counts) {
  if (!list.some(Boolean)) return null;
  const total = counts.reduce((s, n) => s + n, 0);
  const frameA = new Uint16Array(total), frameB = new Uint16Array(total), weight = new Float32Array(total).fill(1);
  const frames = [null], index = new Map();
  let at = 0;
  list.forEach((b, i) => {
    const n = counts[i];
    if (b) {
      const map = b.frames.map((name) => {
        if (name === null) return 0;
        let j = index.get(name);
        if (j === undefined) { j = frames.length; frames.push(name); index.set(name, j); }
        return j;
      });
      for (let c = 0; c < n; c++) {
        frameA[at + c] = map[b.frameA[c]]; frameB[at + c] = map[b.frameB[c]]; weight[at + c] = b.weight[c];
      }
    }
    at += n;
  });
  return { frameA, frameB, weight, frames };
}
