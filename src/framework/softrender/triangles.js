// Manifold meshes are a non-indexed soup (3 consecutive vertices per
// triangle); OCCT meshes are indexed. Offsets returned are into the flat
// positions/normals arrays (vertex index × 3).
export const triangleCount = (m) => (m.indices?.length ? m.indices.length / 3 : (m.positions?.length ?? 0) / 9) | 0;

export function triangleOffsets(m, t) {
  if (m.indices?.length) return [m.indices[t * 3] * 3, m.indices[t * 3 + 1] * 3, m.indices[t * 3 + 2] * 3];
  return [t * 9, t * 9 + 3, t * 9 + 6];
}
