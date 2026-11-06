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

// The check: a NON-LINEAR mix of both codes (an integer bit-mix, mod a prime below 2^16 so
// it stays exact in a float32 property). A boolean interpolates all four properties alike,
// so an affine check (a·31 + b mod 97) let an interpolated triple stay consistent — codes 1
// and 3 at t = ½ read as a valid code 2 — whereas the mix of an interpolated pair matches
// the interpolated check only by chance (≈ 1 in 65521). Called only on integer codes.
const CHECK_MOD = 65521;
/** The check property of an integer code pair (exported for tests). */
export function bindingCheck(a, b) {
  let x = Math.imul(a, 0x9e3779b1) ^ Math.imul(b + 0x7f4a7c15, 0x85ebca77);
  x ^= x >>> 15; x = Math.imul(x, 0x2c1b3c6d); x ^= x >>> 13;
  return (x >>> 0) % CHECK_MOD;
}
const checkOf = bindingCheck;

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

// The merged frame table: "<call id>:<frame>" strings in order of first sight, memoized per
// (slot, local frame) so the string work happens once per distinct frame, not per vertex.
function frameTable(calls) {
  const frames = [null], index = new Map(), memo = calls.map((c) => new Int32Array(c.frames.length + 1).fill(-1));
  // A (slot, local frame)'s table index; 0 when it names no frame of a known call.
  const at = (slot, local) => {
    if (!(slot >= 0 && slot < calls.length) || !(local >= 1 && local <= calls[slot].frames.length)) return 0;
    let i = memo[slot][local];
    if (i < 0) {
      const name = calls[slot].id + ":" + calls[slot].frames[local - 1];
      i = index.get(name);
      if (i === undefined) { i = frames.length; frames.push(name); index.set(name, i); }
      memo[slot][local] = i;
    }
    return i;
  };
  // A code's table index (0: not a positive integer, or no known frame).
  const code = (c) => (Number.isInteger(c) && c > 0 ? at(Math.floor(c / BIND_CALL_STRIDE), c % BIND_CALL_STRIDE) : 0);
  return { frames, at, code };
}

/**
 * A MeshGL's bindings per corner (triVerts order — the order creasedNormals emits its
 * non-indexed output in), or null when it carries none (numProp < 7) or no call was made.
 * `calls[slot] = { id, frames }`. `frames[0]` is null (unbound); the rest are
 * "<call id>:<frame name>" in order of first sight.
 *
 * Repair (optional, both hooks): a boolean seam leaves its cut vertices with interpolated
 * codes, which decode unbound — on the hand, the rim of every nail. `runSlot(run)` names the
 * call slot whose solid a triangle run came from (by its originalID), or -1; every unbound
 * corner in such a run is bound afresh by `rebind(slot, run, xyz)` — xyz a Float64Array of
 * the run's unbound vertices, in the mesh frame — which returns that call's
 * `{ frameA, frameB, weight }` (frame = 1 + its index in calls[slot].frames; 0 unbound).
 * A corner in any other run (a plain solid's) stays unbound.
 */
export function decodeBindings(g, calls, { runSlot = null, rebind = null } = {}) {
  if (!g || !(g.numProp >= 3 + BIND_PROPS) || !calls?.length) return null;
  const np = g.numProp, vp = g.vertProperties, tris = g.triVerts, nC = tris.length;
  const frameA = new Uint16Array(nC), frameB = new Uint16Array(nC), weight = new Float32Array(nC).fill(1);
  const table = frameTable(calls);
  // Decoded per vertex once (a vertex is shared by ~6 corners); -1 = not yet decoded.
  const nV = (vp.length / np) | 0;
  const vA = new Int32Array(nV).fill(-1), vB = new Uint16Array(nV), vW = new Float32Array(nV);
  for (let c = 0; c < nC; c++) {
    const v = tris[c];
    if (vA[v] < 0) {
      const o = v * np + 3, a = vp[o], b = vp[o + 1], w = vp[o + 2], chk = vp[o + 3];
      const ia = w >= 0 && w <= 1 && Number.isInteger(a) && Number.isInteger(b) && chk === checkOf(a, b) ? table.code(a) : 0;
      if (ia === 0) { vA[v] = 0; vB[v] = 0; vW[v] = 1; }
      else {
        const ib = table.code(b);
        vA[v] = ia;
        if (ib === 0) { vB[v] = 0; vW[v] = 1; } else { vB[v] = ib; vW[v] = w; }
      }
    }
    frameA[c] = vA[v]; frameB[c] = vB[v]; weight[c] = vW[v];
  }
  if (runSlot && rebind) repair(g, frameA, frameB, weight, table, runSlot, rebind);
  return { frameA, frameB, weight, frames: table.frames };
}

// decodeBindings' repair pass: per run of a call, its unbound corners, bound per vertex.
function repair(g, frameA, frameB, weight, table, runSlot, rebind) {
  const ri = g.runIndex, tris = g.triVerts, vp = g.vertProperties, np = g.numProp;
  if (!ri) return;
  for (let r = 0; r + 1 < ri.length; r++) {
    const slot = runSlot(r);
    if (!(slot >= 0)) continue;
    const local = new Map();   // vertex -> its index in this run's batch
    const corners = [];        // corner, batch index, …
    for (let c = ri[r]; c < ri[r + 1]; c++) {
      if (frameA[c] !== 0) continue;
      const v = tris[c];
      let i = local.get(v);
      if (i === undefined) { i = local.size; local.set(v, i); }
      corners.push(c, i);
    }
    if (corners.length === 0) continue;
    const xyz = new Float64Array(local.size * 3);
    for (const [v, i] of local) { xyz[i * 3] = vp[v * np]; xyz[i * 3 + 1] = vp[v * np + 1]; xyz[i * 3 + 2] = vp[v * np + 2]; }
    const b = rebind(slot, r, xyz);
    if (!b) continue;
    for (let j = 0; j < corners.length; j += 2) {
      const c = corners[j], i = corners[j + 1];
      const ia = b.frameA[i] ? table.at(slot, b.frameA[i]) : 0;
      if (ia === 0) continue;
      const ib = b.frameB[i] ? table.at(slot, b.frameB[i]) : 0;
      frameA[c] = ia; frameB[c] = ib; weight[c] = ib ? b.weight[i] : 1;
    }
  }
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
