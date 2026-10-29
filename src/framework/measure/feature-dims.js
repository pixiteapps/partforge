// PURE dimension engine for measurement mode: a feature's triangle subset ->
// a MeasureSpec (plane / cylinder / bbox). No three.js, no DOM, no kernel —
// plain typed arrays, same discipline as oracle/mesh.js. Handles both indexed
// (OCCT) and non-indexed (Manifold) payloads.
//
// Spec shapes (anchors are 3D points in the delivered geometry's own frame —
// the orchestrator projects them through mesh.matrixWorld, which is what makes
// dims ride the pose fast path and animations):
//   plane    { kind, values: {width, height},            anchors: {width:{a,b}, height:{a,b}, normal} }
//   cylinder { kind, values: {diameter, depth, partial}, anchors: {center, axis, top, bottom, rimDir} }
//   bbox     { kind, values: {w, d, h},                  anchors: {min, max} }

export const COS_3DEG = 0.99863;      // same axis-snap threshold as selection/resolve.js
const PLANAR_COS = 0.999999;   // ~1.4e-3 rad: all normals agree -> planar
const AXIS_DOT_MAX = 0.05;     // wall normals ⊥ axis within ~3°
const RADIUS_TOL = 0.02;       // radial residual: 2% of radius
const FULL_ARC_DEG = 300;      // coverage below this reads R, not ⌀

export const q2 = (x) => { const r = Math.round(x * 100) / 100; return r === 0 ? 0 : r; };
export const fmtMm = (v) => v.toFixed(2);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

// Iterate the triangles of one feature: yields [a, b, c] vertex triples.
function* featureTris({ positions, indices, featureIds }, featureId) {
  const vert = indices
    ? (t, v) => { const i = indices[t * 3 + v] * 3; return [positions[i], positions[i + 1], positions[i + 2]]; }
    : (t, v) => { const i = (t * 3 + v) * 3; return [positions[i], positions[i + 1], positions[i + 2]]; };
  for (let t = 0; t < featureIds.length; t++) {
    if (featureIds[t] !== featureId) continue;
    yield [vert(t, 0), vert(t, 1), vert(t, 2)];
  }
}

export function unionBounds(list) {
  return list.reduce(
    (acc, b) => ({
      min: acc.min.map((v, i) => Math.min(v, b.min[i])),
      max: acc.max.map((v, i) => Math.max(v, b.max[i])),
    }),
    { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
  );
}

export function bboxSpec(min, max) {
  return {
    kind: "bbox",
    values: { w: q2(max[0] - min[0]), d: q2(max[1] - min[1]), h: q2(max[2] - min[2]) },
    anchors: { min: [...min], max: [...max] },
  };
}

function vertexBounds(tris) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const tri of tris) for (const p of tri) for (let i = 0; i < 3; i++) {
    if (p[i] < min[i]) min[i] = p[i];
    if (p[i] > max[i]) max[i] = p[i];
  }
  return { min, max };
}

// Axis-snap a unit normal (COS_3DEG idiom from selection/resolve.js).
function snapAxis(n) {
  let ai = 0;
  if (Math.abs(n[1]) > Math.abs(n[ai])) ai = 1;
  if (Math.abs(n[2]) > Math.abs(n[ai])) ai = 2;
  if (Math.abs(n[ai]) < COS_3DEG) return null;
  const axis = [0, 0, 0];
  axis[ai] = n[ai] > 0 ? 1 : -1;
  return axis;
}

function planeSpec(tris, normals) {
  // area-weighted mean normal
  let acc = [0, 0, 0];
  for (const { n, area } of normals) acc = add(acc, scale(n, area));
  const mean = norm(acc);
  for (const { n } of normals) if (dot(n, mean) < PLANAR_COS) return null;

  // Basis: axis-snapped normal -> the other two GLOBAL axes (a box face reads
  // W×H, not a PCA-tilted pair). Otherwise: dominant in-plane edge direction.
  const snapped = snapAxis(mean);
  let u, v;
  if (snapped) {
    const ai = snapped.findIndex((c) => c !== 0);
    u = [0, 0, 0]; u[(ai + 1) % 3] = 1;
    v = [0, 0, 0]; v[(ai + 2) % 3] = 1;
  } else {
    let best = null, bestLen = -1;
    for (const [a, b, c] of tris) {
      for (const e of [sub(b, a), sub(c, b), sub(a, c)]) {
        const l = Math.hypot(e[0], e[1], e[2]);
        if (l > bestLen) { bestLen = l; best = e; }
      }
    }
    u = norm(sub(best, scale(mean, dot(best, mean)))); // project into plane
    v = norm(cross(mean, u));
  }

  const c0 = tris[0][0];
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const tri of tris) for (const p of tri) {
    const d = sub(p, c0);
    const uu = dot(d, u), vv = dot(d, v);
    if (uu < uMin) uMin = uu; if (uu > uMax) uMax = uu;
    if (vv < vMin) vMin = vv; if (vv > vMax) vMax = vv;
  }
  const corner = (uu, vv) => add(c0, add(scale(u, uu), scale(v, vv)));
  return {
    kind: "plane",
    values: { width: q2(uMax - uMin), height: q2(vMax - vMin) },
    anchors: {
      width: { a: corner(uMin, vMin), b: corner(uMax, vMin) },
      height: { a: corner(uMax, vMin), b: corner(uMax, vMax) },
      normal: snapped ?? mean.map(q2),
    },
  };
}

function cylinderSpec(tris, normals) {
  // Candidate axes from cross products of well-separated normal pairs, scored
  // by how much triangle area agrees the candidate is ⊥ to it. A single seeded
  // pair is not robust: when a feature carries wall AND cap triangles, a
  // wall×cap pair yields a tangent to the cylinder, not its axis.
  const stride = Math.max(1, Math.floor(normals.length / 16));
  const sample = [];
  for (let i = 0; i < normals.length; i += stride) sample.push(normals[i].n);
  let axis = null, bestScore = 0;
  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 1; j < sample.length; j++) {
      if (Math.abs(dot(sample[i], sample[j])) > 0.95) continue;
      const cand = norm(cross(sample[i], sample[j]));
      if (cand[0] === 0 && cand[1] === 0 && cand[2] === 0) continue;
      let score = 0;
      for (const { n: tn, area } of normals) {
        if (Math.abs(dot(tn, cand)) <= AXIS_DOT_MAX) score += area;
      }
      if (score > bestScore) { bestScore = score; axis = cand; }
    }
  }
  if (!axis) return null;

  // Wall triangles only (a labeled boss's end caps attribute to the same
  // feature — their normals are along the axis; exclude them from the fit).
  const wallVerts = [];
  for (let t = 0; t < tris.length; t++) {
    if (Math.abs(dot(normals[t].n, axis)) > AXIS_DOT_MAX) continue;
    wallVerts.push(...tris[t]);
  }
  if (wallVerts.length < 9) return null; // fewer than 3 wall triangles: not a cylinder

  // Circle fit (Kåsa least-squares) in the plane ⊥ axis: for a partial arc
  // the vertex centroid is NOT on the axis, so a centroid-based radius check
  // wrongly rejects arcs. Solve x²+y² = Ax + By + C over the projected wall
  // vertices; center (A/2, B/2), r = sqrt(C + |center|²).
  const e = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const uBasis = norm(cross(axis, e));
  const vBasis = cross(axis, uBasis);
  const p0 = wallVerts[0];
  const pts = wallVerts.map((p) => {
    const d = sub(p, p0);
    return [dot(d, uBasis), dot(d, vBasis)];
  });
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sxz = 0, syz = 0, sz = 0;
  for (const [x, y] of pts) {
    const z = x * x + y * y;
    sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y;
    sxz += x * z; syz += y * z; sz += z;
  }
  const n = pts.length;
  // Cramer's rule on the 3x3 normal equations [[sxx,sxy,sx],[sxy,syy,sy],[sx,sy,n]] · [A,B,C]ᵀ = [sxz,syz,sz]ᵀ
  const det = sxx * (syy * n - sy * sy) - sxy * (sxy * n - sy * sx) + sx * (sxy * sy - syy * sx);
  if (Math.abs(det) < 1e-12) return null;
  const A = (sxz * (syy * n - sy * sy) - sxy * (syz * n - sy * sz) + sx * (syz * sy - syy * sz)) / det;
  const B = (sxx * (syz * n - sy * sz) - sxz * (sxy * n - sy * sx) + sx * (sxy * sz - syz * sx)) / det;
  const Cc = (sxx * (syy * sz - syz * sy) - sxy * (sxy * sz - syz * sx) + sxz * (sxy * sy - syy * sx)) / det;
  const cx = A / 2, cy = B / 2;
  const rSquared = Cc + cx * cx + cy * cy;
  if (rSquared <= 0) return null;
  const r = Math.sqrt(rSquared);
  // Axis point in 3D: the fitted center lifted back out of the projection plane.
  const c = add(p0, add(scale(uBasis, cx), scale(vBasis, cy)));
  const radial = (p) => { const d = sub(p, c); return sub(d, scale(axis, dot(d, axis))); };
  for (const p of wallVerts) {
    const ri = Math.hypot(...radial(p));
    if (Math.abs(ri - r) > Math.max(RADIUS_TOL * r, 1e-6)) return null;
  }

  // Depth from ALL feature vertices (caps included) along the axis.
  let tMin = Infinity, tMax = -Infinity;
  for (const tri of tris) for (const p of tri) {
    const t = dot(sub(p, c), axis);
    if (t < tMin) tMin = t; if (t > tMax) tMax = t;
  }

  // Angular coverage of wall vertices -> ⌀ vs R notation.
  const u = norm(radial(wallVerts[0]));
  const v = cross(axis, u);
  const angles = wallVerts
    .map((p) => { const rd = radial(p); return Math.atan2(dot(rd, v), dot(rd, u)); })
    .sort((a, b) => a - b);
  let maxGap = 2 * Math.PI + angles[0] - angles[angles.length - 1];
  let gapEnd = angles[0]; // angle where the covered span begins (after the largest gap)
  for (let i = 1; i < angles.length; i++) {
    const g = angles[i] - angles[i - 1];
    if (g > maxGap) { maxGap = g; gapEnd = angles[i]; }
  }
  const coverageDeg = 360 - (maxGap * 180) / Math.PI;
  // Radial direction at the angular midpoint of the covered span — where the
  // wall actually is; the placer hangs R-leaders (and degenerate-view ⌀ dims)
  // off it so they always spring from real surface. For a full circle
  // (maxGap ~ the seam between last and first sample) this still yields a
  // stable default direction.
  const midAngle = gapEnd + (2 * Math.PI - maxGap) / 2;
  const rimDir = norm(add(scale(u, Math.cos(midAngle)), scale(v, Math.sin(midAngle))));

  const snapped = snapAxis(axis);
  const ax = snapped ?? axis.map(q2);
  return {
    kind: "cylinder",
    values: { diameter: q2(2 * r), depth: q2(tMax - tMin), partial: coverageDeg < FULL_ARC_DEG },
    anchors: {
      center: add(c, scale(axis, (tMin + tMax) / 2)).map(q2),
      axis: ax,
      bottom: add(c, scale(axis, tMin)).map(q2),
      top: add(c, scale(axis, tMax)).map(q2),
      rimDir: rimDir.map(q2),
    },
  };
}

export function classifyFeature(mesh, featureId) {
  const tris = [...featureTris(mesh, featureId)];
  if (tris.length === 0) return null;
  const normals = tris.map(([a, b, c]) => {
    const n = cross(sub(b, a), sub(c, a));
    const area = Math.hypot(n[0], n[1], n[2]) / 2;
    return { n: norm(n), area };
  });
  const plane = planeSpec(tris, normals);
  if (plane) return plane;
  const cyl = cylinderSpec(tris, normals);
  if (cyl) return cyl;
  const { min, max } = vertexBounds(tris);
  return bboxSpec(min, max);
}
