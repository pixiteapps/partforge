// The pose-drag deformer (docs/superpowers/specs/2026-10-31-implicit-pose-drag-design.md):
// linear blend skinning of the last exact organic mesh. Pure and DOM-free; the main thread
// calls it per slider move and writes the result into the viewer in place.
import { resolveFrames, compose, invert } from "../geometry/xform.js";
import { implicitCallId } from "../geometry/implicit/call-id.js";

/** Each spec's call id, computed positionally the way the worker names bound frames. */
function idsOf(specs) {
  return specs.map((spec, i) => implicitCallId(spec, specs.slice(0, i)));
}

/**
 * The rigid motion of each bound frame from the base build to the live pose:
 * `compose(liveWorld, invert(baseWorld))`. Indexed like `frames` ([0] null). The whole
 * array is null when any call or frame name is missing on either side.
 */
export function frameMotions(baseSpecs, liveSpecs, frames) {
  const baseIds = idsOf(baseSpecs), liveIds = idsOf(liveSpecs);
  const baseWorlds = new Map(), liveWorlds = new Map();
  const worldOf = (cache, specs, k, name) => {
    if (!cache.has(k)) {
      try { cache.set(k, resolveFrames(specs[k].frames)); } catch { cache.set(k, null); }
    }
    return cache.get(k)?.get(name)?.world ?? null;
  };
  const out = new Array(frames.length).fill(null);
  for (let i = 1; i < frames.length; i++) {
    const f = frames[i];
    if (f == null) continue;
    let found = null;
    for (let k = 0; k < baseIds.length && !found; k++) {
      const prefix = `${baseIds[k]}:`;
      if (f.startsWith(prefix)) found = { k, name: f.slice(prefix.length), id: baseIds[k] };
    }
    if (!found) return null;
    const lk = liveIds.indexOf(found.id);
    if (lk < 0) return null;
    const bw = worldOf(baseWorlds, baseSpecs, found.k, found.name);
    const lw = worldOf(liveWorlds, liveSpecs, lk, found.name);
    if (!bw || !lw) return null;
    out[i] = compose(lw, invert(bw));
  }
  return out;
}

/**
 * Deform `base` ({ positions, normals, bindings }) by `motions` into `out`
 * ({ positions, normals }, same lengths), in place; returns `out`. An unbound corner, or
 * one whose frame has no motion, is copied. A corner with two frames blends the two
 * motions' results by `weight` (frame A's share); normals blend the same way, renormalised.
 */
export function skinVertices(base, motions, out) {
  const { positions: bp, normals: bn, bindings } = base;
  const { frameA, frameB, weight } = bindings;
  const op = out.positions, on = out.normals;
  const n = frameA.length;
  const m = new Float64Array(motions.length * 12);
  const has = new Uint8Array(motions.length);
  for (let i = 0; i < motions.length; i++) {
    if (motions[i]) { m.set(motions[i], i * 12); has[i] = 1; }
  }
  for (let c = 0; c < n; c++) {
    const i = c * 3;
    const x = bp[i], y = bp[i + 1], z = bp[i + 2];
    const nx = bn[i], ny = bn[i + 1], nz = bn[i + 2];
    const a = frameA[c];
    if (a === 0 || !has[a]) {
      op[i] = x; op[i + 1] = y; op[i + 2] = z;
      on[i] = nx; on[i + 1] = ny; on[i + 2] = nz;
      continue;
    }
    let o = a * 12;
    let px = m[o] * x + m[o + 1] * y + m[o + 2] * z + m[o + 9];
    let py = m[o + 3] * x + m[o + 4] * y + m[o + 5] * z + m[o + 10];
    let pz = m[o + 6] * x + m[o + 7] * y + m[o + 8] * z + m[o + 11];
    let qx = m[o] * nx + m[o + 1] * ny + m[o + 2] * nz;
    let qy = m[o + 3] * nx + m[o + 4] * ny + m[o + 5] * nz;
    let qz = m[o + 6] * nx + m[o + 7] * ny + m[o + 8] * nz;
    const b = frameB[c];
    if (b !== 0 && has[b]) {
      const w = weight[c], v = 1 - w;
      o = b * 12;
      px = w * px + v * (m[o] * x + m[o + 1] * y + m[o + 2] * z + m[o + 9]);
      py = w * py + v * (m[o + 3] * x + m[o + 4] * y + m[o + 5] * z + m[o + 10]);
      pz = w * pz + v * (m[o + 6] * x + m[o + 7] * y + m[o + 8] * z + m[o + 11]);
      qx = w * qx + v * (m[o] * nx + m[o + 1] * ny + m[o + 2] * nz);
      qy = w * qy + v * (m[o + 3] * nx + m[o + 4] * ny + m[o + 5] * nz);
      qz = w * qz + v * (m[o + 6] * nx + m[o + 7] * ny + m[o + 8] * nz);
      const l = Math.sqrt(qx * qx + qy * qy + qz * qz);
      if (l > 0) { qx /= l; qy /= l; qz /= l; }
    }
    op[i] = px; op[i + 1] = py; op[i + 2] = pz;
    on[i] = qx; on[i + 1] = qy; on[i + 2] = qz;
  }
  return out;
}
