// Rigid-pose math for the OCCT backend's lazy transforms. A pose is a list of
// {t:"translate", v} / {t:"rotate", deg, center, axis} steps not yet applied to
// the underlying B-rep shape; composePose folds them (in application order) into
// one column-major mat4, and transformPositions re-poses a cached tessellation's
// vertices with it. Pure JS — unit-testable without booting a kernel.
//
// The same math backs the viewer's pose fast path: when a param change only
// moves a sub-part, `poseDelta` (via `invertRigid`) gives the matrix carrying an
// already-delivered mesh from the pose it was built at to the new one, so the
// viewer re-poses instead of rebuilding.

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// column-major 4x4 product: (A·B)[c][r] = Σk A[k][r]·B[c][k]. Exported for the
// pose fast path, which composes a place pose over a build delta.
export function mulMat4(A, B) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      o[c * 4 + r] = A[r] * B[c * 4] + A[4 + r] * B[c * 4 + 1] + A[8 + r] * B[c * 4 + 2] + A[12 + r] * B[c * 4 + 3];
  return o;
}

const translation = (v) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, v[0], v[1], v[2], 1];

// axis-angle rotation about an axis THROUGH `center`: T(center) · R(axis, deg) · T(−center)
function rotationAbout(deg, center, axis) {
  const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const x = axis[0] / len, y = axis[1] / len, z = axis[2] / len;
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t), C = 1 - c;
  const R = [
    c + x * x * C, y * x * C + z * s, z * x * C - y * s, 0,
    x * y * C - z * s, c + y * y * C, z * y * C + x * s, 0,
    x * z * C + y * s, y * z * C - x * s, c + z * z * C, 0,
    0, 0, 0, 1,
  ];
  return mulMat4(translation(center), mulMat4(R, translation([-center[0], -center[1], -center[2]])));
}

const stepMatrix = (s) => (s.t === "translate" ? translation(s.v) : rotationAbout(s.deg, s.center, s.axis));

// Fold steps so the EARLIEST step applies first: p' = Mn · … · M1 · p.
export const composePose = (steps) => steps.reduce((m, s) => mulMat4(stepMatrix(s), m), IDENTITY);

// Apply a mat4 to an interleaved xyz Float32Array in place.
export function transformPositions(positions, m) {
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    positions[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    positions[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    positions[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
}

// Invert a rigid mat4 (rotation + translation only): Rᵀ, t' = −Rᵀ·t. Valid only
// for matrices produced by composePose — transposing the 3x3 block inverts a
// rotation, so any scale or shear in it yields garbage rather than an inverse.
export function invertRigid(m) {
  const r0 = m[0], r1 = m[1], r2 = m[2],
        r4 = m[4], r5 = m[5], r6 = m[6],
        r8 = m[8], r9 = m[9], r10 = m[10],
        tx = m[12], ty = m[13], tz = m[14];
  return [
    r0, r4, r8, 0,
    r1, r5, r9, 0,
    r2, r6, r10, 0,
    -(r0 * tx + r1 * ty + r2 * tz),
    -(r4 * tx + r5 * ty + r6 * tz),
    -(r8 * tx + r9 * ty + r10 * tz),
    1,
  ];
}

// The matrix that carries a mesh delivered at `oldSteps` to the pose `newSteps`:
// compose(new) · compose(old)⁻¹. Both step lists come from the pose probe.
export const poseDelta = (newSteps, oldSteps) => {
  const target = composePose(newSteps);
  const inv = invertRigid(composePose(oldSteps));
  return mulMat4(target, inv);
};

// Apply ONLY the rotation block of a rigid mat4 to interleaved xyz normals, in
// place. composePose matrices are rigid (orthonormal 3x3 block), so normals
// transform by the same block — no inverse-transpose — and stay unit length.
// Translation columns are deliberately ignored: normals are directions.
export function rotateNormals(normals, m) {
  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i], y = normals[i + 1], z = normals[i + 2];
    normals[i] = m[0] * x + m[4] * y + m[8] * z;
    normals[i + 1] = m[1] * x + m[5] * y + m[9] * z;
    normals[i + 2] = m[2] * x + m[6] * y + m[10] * z;
  }
}
