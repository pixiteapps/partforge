// Run lineage: which primitive surface (Manifold originalID) each run of a mesh
// came from, and the affine that carries it there (runTransform), tracked
// STRUCTURALLY on the solid wrappers so nothing has to materialize a mesh to ask.
//
// Affines use Manifold's runTransform layout exactly (blend-surfaces.js affineAt):
// 12 floats, a 3x4 column-major matrix — columns 0-2 are the images of X, Y, Z,
// column 3 the translation — so p' = M[0..2]·x + M[3..5]·y + M[6..8]·z + M[9..11].
// A `null` mat is the identity (a fresh original's empty runTransform).
//
// Pure leaf: no imports, no DOM, no node:.

export const IDENTITY12 = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);

// outer ∘ inner: apply `inner` first, then `outer`. A null inner is the identity.
export function composeAffine(outer, inner) {
  if (!inner) return outer.slice();
  const o = outer, i = inner, r = new Array(12);
  for (let c = 0; c < 4; c++) {
    const x = i[3 * c], y = i[3 * c + 1], z = i[3 * c + 2];
    for (let row = 0; row < 3; row++) {
      r[3 * c + row] = o[row] * x + o[3 + row] * y + o[6 + row] * z + (c === 3 ? o[9 + row] : 0);
    }
  }
  return r;
}

export const translateAffine = ([x, y, z]) => [1, 0, 0, 0, 1, 0, 0, 0, 1, x, y, z];

// The linear part L about `center`: p' = L(p - c) + c.
const aboutCenter = (L, [cx, cy, cz]) => {
  const t = [0, 1, 2].map((row) => (row === 0 ? cx : row === 1 ? cy : cz)
    - (L[row] * cx + L[3 + row] * cy + L[6 + row] * cz));
  return [...L, ...t];
};

// Right-handed rotation of `deg` about `axis` (any length) through `center` — the
// same map the backend's rotate builds (euler for a basis axis, axis-angle otherwise).
export function rotateAffine(deg, center, axis) {
  const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const x = axis[0] / len, y = axis[1] / len, z = axis[2] / len;
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t), C = 1 - c;
  const L = [
    c + x * x * C, y * x * C + z * s, z * x * C - y * s,
    x * y * C - z * s, c + y * y * C, z * y * C + x * s,
    x * z * C + y * s, y * z * C - x * s, c + z * z * C,
  ];
  return aboutCenter(L, center);
}

// Reflection through the plane through the origin with normal `normal`.
export function mirrorAffine(normal) {
  const n2 = normal[0] ** 2 + normal[1] ** 2 + normal[2] ** 2 || 1;
  const L = [];
  for (let c = 0; c < 3; c++) for (let row = 0; row < 3; row++) L.push((row === c ? 1 : 0) - (2 * normal[row] * normal[c]) / n2);
  return [...L, 0, 0, 0];
}

export const scaleAffine = (factor, center) =>
  aboutCenter([factor, 0, 0, 0, factor, 0, 0, 0, factor], center);

// A run's identity: its id plus its 12 transform values rounded to 1e-4, so a
// structurally composed transform and the kernel's own float32 one key alike.
export function runKey(id, mat) {
  const m = mat ?? IDENTITY12;
  let key = String(id);
  for (let i = 0; i < 12; i++) key += `,${String(Math.round(m[i] * 1e4))}`;
  return key;
}

// First occurrence of each run key, in order.
export function dedupeRuns(runs) {
  const seen = new Set(), out = [];
  for (const r of runs) {
    const key = runKey(r.id, r.mat);
    if (!seen.has(key)) { seen.add(key); out.push(r); }
  }
  return out;
}
