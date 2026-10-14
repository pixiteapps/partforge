// test/helpers/mesh-topology.js
// Closed-manifold checks for indexed triangle meshes.
export function edgeCheck(indices) {
  const half = new Map();
  for (let t = 0; t < indices.length; t += 3) for (let c = 0; c < 3; c++) {
    const a = indices[t + c], b = indices[t + ((c + 1) % 3)];
    const key = `${a},${b}`;
    half.set(key, (half.get(key) ?? 0) + 1);
  }
  let boundary = 0, nonManifold = 0, misoriented = 0;
  for (const [key, count] of half) {
    const [a, b] = key.split(",");
    const back = half.get(`${b},${a}`) ?? 0;
    if (count > 1) misoriented++;
    if (back === 0) boundary++;
    else if (back > 1) nonManifold++;
  }
  return { boundary, nonManifold, misoriented };
}

export function eulerChar(positions, indices) {
  const used = new Set(indices), edges = new Set();
  for (let t = 0; t < indices.length; t += 3) for (let c = 0; c < 3; c++) {
    const a = indices[t + c], b = indices[t + ((c + 1) % 3)];
    edges.add(a < b ? `${a},${b}` : `${b},${a}`);
  }
  return used.size - edges.size + indices.length / 3;
}

export function volume(positions, indices) {
  let v = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = 3 * indices[t], b = 3 * indices[t + 1], c = 3 * indices[t + 2];
    v += positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1])
      - positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c])
      + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  return v / 6;
}
