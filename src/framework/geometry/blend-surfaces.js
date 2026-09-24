// Analytic blend-surface descriptors — the exact normal field of a mesh fillet band.
//
// A mesh fillet (mesh-fillet.js) is a boolean against tool solids whose curved wall
// IS the rolling-ball surface. Facet-averaged vertex normals on that wall are only
// approximately right: one-sided at the band's tangent boundary (half a facet off
// the face it is tangent to — ~1-2° at preview density), biased by the boolean's
// uneven fans, and on a coarse corner sphere several degrees off the edge cylinders
// it meets. Every blend surface is a canal surface — the envelope of a ball rolling
// along a SPINE — so its exact normal at any point is the direction from the nearest
// spine point, and the spine is known when the tool is built. A descriptor records
// that spine:
//
//   { kind: "line",   p, d }        straight edge → cylinder (prism tools)
//   { kind: "circle", c, a, R }     arc edge → torus (revolve / pivot tools); R may
//                                   be 0 (a sphere about c)
//   { kind: "point",  c }           sphere (corner patches)
//   { kind: "path", pts, closed, dirs, f, kf, kd }
//                                   planar polyline edge (planar sweep tools): pts is
//                                   the swept path, f its face normal, dirs[i] the
//                                   in-plane wall-side direction at vertex i, and the
//                                   ball centre sits at kf·f + kd·dir off the edge
//
// A path's polyline usually STANDS FOR a smooth curve (a circle's rim, an outline's
// rounded corner): its per-segment cylinders would shade faceted around the curve,
// while the facet average this replaces blurred those joints smooth. So the path
// normal is Phong-style: the in-plane direction is interpolated between the vertex
// directions (each the bisector of its two segments), giving the normal of the
// smooth canal surface the polyline samples — exact on a straight stretch, and on
// a sampled curve exact at the samples and continuous between them.
//
// The normal is sign-free here (a spine direction); the caller orients it against
// the facet, which also makes one descriptor serve cutters and fillers alike.
//
// Descriptors are registered per Manifold originalID in the tool's ORIGINAL frame
// (the inverse of the run's runTransform at registration), and evaluated per output
// run through that run's transform — so they follow every later translate, rotate,
// boolean and re-stamp that carries runTransform along (Manifold does, verified).
// Pure module: no DOM, no node:, no three.

const EPS = 1e-12;

// --- 3x4 column-major affine helpers (Manifold's runTransform layout) -------------
export function affineAt(rt, run) {
  const o = run * 12;
  return [rt[o], rt[o + 1], rt[o + 2], rt[o + 3], rt[o + 4], rt[o + 5],
    rt[o + 6], rt[o + 7], rt[o + 8], rt[o + 9], rt[o + 10], rt[o + 11]];
}
export const IDENTITY = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
const applyPt = (M, p) => [
  M[0] * p[0] + M[3] * p[1] + M[6] * p[2] + M[9],
  M[1] * p[0] + M[4] * p[1] + M[7] * p[2] + M[10],
  M[2] * p[0] + M[5] * p[1] + M[8] * p[2] + M[11],
];
const applyDir = (M, d) => [
  M[0] * d[0] + M[3] * d[1] + M[6] * d[2],
  M[1] * d[0] + M[4] * d[1] + M[7] * d[2],
  M[2] * d[0] + M[5] * d[1] + M[8] * d[2],
];
// Inverse of an affine; null when singular.
export function invertAffine(M) {
  const [a, b, c, d, e, f, g, h, i] = M; // columns (a,b,c) (d,e,f) (g,h,i)
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > EPS)) return null;
  const s = 1 / det;
  // rows of the inverse = cofactor columns; stored column-major
  const L = [
    A * s, (c * h - b * i) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, (c * d - a * f) * s,
    C * s, (b * g - a * h) * s, (a * e - b * d) * s,
  ];
  const t = applyDir([...L, 0, 0, 0], [M[9], M[10], M[11]]);
  return [...L, -t[0], -t[1], -t[2]];
}

const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > EPS ? [v[0] / l, v[1] / l, v[2] / l] : null;
};

// Map a descriptor through an affine (used with the INVERSE run transform at
// registration: world → original frame). Exact for rigid maps, which is what the
// tools are posed with; radii scale by the map's mean axis stretch.
export function mapSurface(desc, M) {
  switch (desc.kind) {
    case "line": return { kind: "line", p: applyPt(M, desc.p), d: norm(applyDir(M, desc.d)) ?? desc.d };
    case "point": return { kind: "point", c: applyPt(M, desc.c) };
    case "circle": {
      const s = Math.cbrt(Math.abs(
        M[0] * (M[4] * M[8] - M[5] * M[7]) - M[3] * (M[1] * M[8] - M[2] * M[7]) + M[6] * (M[1] * M[5] - M[2] * M[4])));
      return { kind: "circle", c: applyPt(M, desc.c), a: norm(applyDir(M, desc.a)) ?? desc.a, R: desc.R * s };
    }
    case "path": {
      const s = Math.cbrt(Math.abs(
        M[0] * (M[4] * M[8] - M[5] * M[7]) - M[3] * (M[1] * M[8] - M[2] * M[7]) + M[6] * (M[1] * M[5] - M[2] * M[4])));
      return { kind: "path", closed: desc.closed, pts: desc.pts.map((p) => applyPt(M, p)),
        dirs: desc.dirs.map((d) => norm(applyDir(M, d)) ?? d), f: norm(applyDir(M, desc.f)) ?? desc.f,
        kf: desc.kf * s, kd: desc.kd * s };
    }
    default: throw new Error(`blend surface: unknown kind ${desc.kind}`);
  }
}

// Nearest spine point to x, in the descriptor's own frame.
function spinePoint(desc, x) {
  switch (desc.kind) {
    case "point": return desc.c;
    case "line": {
      const { p, d } = desc;
      const t = (x[0] - p[0]) * d[0] + (x[1] - p[1]) * d[1] + (x[2] - p[2]) * d[2];
      return [p[0] + t * d[0], p[1] + t * d[1], p[2] + t * d[2]];
    }
    case "circle": {
      const { c, a, R } = desc;
      const q = [x[0] - c[0], x[1] - c[1], x[2] - c[2]];
      const t = q[0] * a[0] + q[1] * a[1] + q[2] * a[2];
      const rad = norm([q[0] - t * a[0], q[1] - t * a[1], q[2] - t * a[2]]);
      if (!rad) return R > 0 ? null : c; // on the axis: the normal is undefined unless the spine is a point
      return [c[0] + R * rad[0], c[1] + R * rad[1], c[2] + R * rad[2]];
    }
    default: return null;
  }
}

// Path normal (see the header): nearest edge segment i at parameter t, the in-plane
// direction lerped between its vertex directions, the ball centre offset along it,
// and the normal rebuilt from x's height above the centre (along f) and its signed
// in-plane distance across the segment.
function pathNormal(desc, x) {
  const { pts, dirs, f, kf, kd } = desc;
  const n = pts.length;
  const { bi, bt } = nearestSegment(desc, x);
  if (bi < 0) return null;
  const p = pts[bi], q = pts[(bi + 1) % n], d0 = dirs[bi], d1 = dirs[(bi + 1) % n];
  const dir = norm([d0[0] + (d1[0] - d0[0]) * bt, d0[1] + (d1[1] - d0[1]) * bt, d0[2] + (d1[2] - d0[2]) * bt]);
  if (!dir) return null;
  const e = [p[0] + (q[0] - p[0]) * bt, p[1] + (q[1] - p[1]) * bt, p[2] + (q[2] - p[2]) * bt];
  const c = [e[0] + kf * f[0] + kd * dir[0], e[1] + kf * f[1] + kd * dir[1], e[2] + kf * f[2] + kd * dir[2]];
  const v = [x[0] - c[0], x[1] - c[1], x[2] - c[2]];
  const h = v[0] * f[0] + v[1] * f[1] + v[2] * f[2];
  // signed in-plane distance across the SEGMENT (the local surface's own measure)
  const segN = norm([q[0] - p[0], q[1] - p[1], q[2] - p[2]]);
  const perp = segN ? norm([f[1] * segN[2] - f[2] * segN[1], f[2] * segN[0] - f[0] * segN[2], f[0] * segN[1] - f[1] * segN[0]]) : null;
  if (!perp) return null;
  const sgn = perp[0] * dir[0] + perp[1] * dir[1] + perp[2] * dir[2] >= 0 ? 1 : -1;
  const w = sgn * (v[0] * perp[0] + v[1] * perp[1] + v[2] * perp[2]);
  return norm([h * f[0] + w * dir[0], h * f[1] + w * dir[1], h * f[2] + w * dir[2]]);
}

// Nearest path segment to x (index + clamped parameter). A text rim's path runs to
// hundreds of segments and every band vertex asks, so the segments are bucketed
// once per descriptor into a uniform grid (lazily, off the enumerable fields) and
// the query widens ring by ring only until no unvisited cell can hold a closer one.
// squared distance from x to segment pq; the clamped parameter lands in segT
let segT = 0;
function segDist2(p, q, x) {
  const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
  const dd = dx * dx + dy * dy + dz * dz;
  let t = dd > EPS ? ((x[0] - p[0]) * dx + (x[1] - p[1]) * dy + (x[2] - p[2]) * dz) / dd : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  segT = t;
  return (x[0] - p[0] - t * dx) ** 2 + (x[1] - p[1] - t * dy) ** 2 + (x[2] - p[2] - t * dz) ** 2;
}
const GRID_MIN_SEGS = 16;
function segmentGrid(desc) {
  let g = desc[GRID];
  if (g) return g;
  const { pts, closed } = desc, n = pts.length, nSeg = closed ? n : n - 1;
  let total = 0;
  for (let i = 0; i < nSeg; i++) { const p = pts[i], q = pts[(i + 1) % n]; total += Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]); }
  const h = Math.max(total / Math.max(1, nSeg), Math.abs(desc.kf) + Math.abs(desc.kd), 1e-6);
  const cells = new Map();
  // numeric hashed cell keys: a collision only adds candidates, each distance-checked
  const key = (a, b, c) => (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) | 0;
  for (let i = 0; i < nSeg; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    const lo = [0, 1, 2].map((a) => Math.floor(Math.min(p[a], q[a]) / h));
    const hi = [0, 1, 2].map((a) => Math.floor(Math.max(p[a], q[a]) / h));
    for (let a = lo[0]; a <= hi[0]; a++) for (let b = lo[1]; b <= hi[1]; b++) for (let c = lo[2]; c <= hi[2]; c++) {
      const k = key(a, b, c);
      const list = cells.get(k);
      if (list) list.push(i); else cells.set(k, [i]);
    }
  }
  g = { h, cells, key, nSeg, stamp: new Uint32Array(nSeg), epoch: 0 };
  Object.defineProperty(desc, GRID, { value: g, enumerable: false });
  return g;
}
const GRID = Symbol("segmentGrid");
function nearestSegment(desc, x) {
  const { pts, closed } = desc, n = pts.length, nSeg = closed ? n : n - 1;
  let bi = -1, bt = 0, bestD = Infinity;
  if (nSeg < GRID_MIN_SEGS) {
    for (let i = 0; i < nSeg; i++) {
      const D = segDist2(pts[i], pts[(i + 1) % n], x);
      if (D < bestD) { bestD = D; bi = i; bt = segT; }
    }
    return { bi, bt };
  }
  const g = segmentGrid(desc), { h, cells, key, stamp } = g;
  const epoch = ++g.epoch;
  const c0 = Math.floor(x[0] / h), c1 = Math.floor(x[1] / h), c2 = Math.floor(x[2] / h);
  for (let ring = 0; ; ring++) {
    // every cell at Chebyshev distance `ring`; its points lie ≥ (ring-1)·h away
    if (bi >= 0 && (ring - 1) * h > Math.sqrt(bestD)) break;
    let any = false;
    for (let a = -ring; a <= ring; a++) for (let b = -ring; b <= ring; b++) for (let c = -ring; c <= ring; c++) {
      if (Math.max(Math.abs(a), Math.abs(b), Math.abs(c)) !== ring) continue;
      const list = cells.get(key(c0 + a, c1 + b, c2 + c));
      if (!list) continue;
      any = true;
      for (const i of list) {
        if (stamp[i] === epoch) continue;
        stamp[i] = epoch;
        const D = segDist2(pts[i], pts[(i + 1) % n], x);
        if (D < bestD) { bestD = D; bi = i; bt = segT; }
      }
    }
    // h ≥ the ball-centre offset, so a band point finds its segment within a ring or
    // two; a point this far from the path is not on the band — scan and be done
    if (!any && bi < 0 && ring >= 3) {
      for (let i = 0; i < nSeg; i++) {
        const D = segDist2(pts[i], pts[(i + 1) % n], x);
        if (D < bestD) { bestD = D; bi = i; bt = segT; }
      }
      break;
    }
  }
  return { bi, bt };
}

// Unit spine→point direction at x in the descriptor's frame, or null where undefined.
export function surfaceNormal(desc, x) {
  if (desc.kind === "path") return pathNormal(desc, x);
  const s = spinePoint(desc, x);
  return s ? norm([x[0] - s[0], x[1] - s[1], x[2] - s[2]]) : null;
}

// Per-run evaluator for creased-normals: world-frame analytic normal at world point
// x for a run whose original-frame descriptor is `desc` and whose runTransform is M.
// Normals map by the inverse-transpose of M's linear part, so this stays exact under
// any affine a part applies after the fillet (mirrors, non-uniform scales).
export function runEvaluator(desc, M) {
  const inv = invertAffine(M);
  if (!inv) return null;
  return (x) => {
    const n0 = surfaceNormal(desc, applyPt(inv, x));
    if (!n0) return null;
    // (M^-1)^T n0: the inverse's COLUMNS dotted with n0
    return norm([
      inv[0] * n0[0] + inv[1] * n0[1] + inv[2] * n0[2],
      inv[3] * n0[0] + inv[4] * n0[1] + inv[5] * n0[2],
      inv[6] * n0[0] + inv[7] * n0[1] + inv[8] * n0[2],
    ]);
  };
}
