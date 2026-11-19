// The provisional stage of a two-stage delivery (docs/superpowers/specs/2026-10-31-implicit-pose-drag-design.md
// §5): the pieces of a union of k.implicit bodies, meshed one by one and laid end to end with
// no boolean — overlapping shells, each piece exact. Shown only until the real union lands;
// nothing that reads geometry as exact ever receives it.
//
// Pure, DOM-free and three-free: the worker loads it.
import { mergeBindings } from "./mesh-bindings.js";

const concatF32 = (arrays) => {
  const out = new Float32Array(arrays.reduce((s, a) => s + (a?.length ?? 0), 0));
  let at = 0;
  for (const a of arrays) if (a) { out.set(a, at); at += a.length; }
  return out;
};

/**
 * Non-indexed toMesh payloads → one payload `{ positions, normals, triangles, edges, bindings? }`.
 * Feature attribution (`featureIds`/`features`) is dropped: the provisional stage is never
 * picked against. Bindings (per corner) merge by frame name; none when no piece has any.
 */
export function concatMeshPayloads(list) {
  for (const m of list) {
    if (m.indices) throw new Error("concatMeshPayloads: an indexed payload cannot be concatenated");
  }
  const triangles = list.reduce((s, m) => s + (m.triangles ?? m.positions.length / 9), 0);
  const out = {
    positions: concatF32(list.map((m) => m.positions)),
    normals: concatF32(list.map((m) => m.normals)),
    triangles,
    edges: concatF32(list.map((m) => m.edges)),
  };
  const bindings = mergeBindings(list.map((m) => m.bindings ?? null), list.map((m) => m.positions.length / 3));
  if (bindings) out.bindings = bindings;
  return out;
}
