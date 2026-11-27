// A line's centreline as a tube mesh. Pure and worker-safe: numbers in, typed arrays out.
// Parallel-transport frames (not Frenet), so the rings never twist on a straight run or flip
// at an inflection.

/** The default colour a drawn line takes. */
export const LINE_COLOR = 0xe8e2d0;
/** Vertices per ring. */
export const LINE_TUBE_SIDES = 12;

const DUP_EPS = 1e-9;
const EMPTY = () => ({ positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0) });

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];

/** Rotate `v` about unit axis `k` by an angle with the given cos and sin (Rodrigues). */
function rotate(v, k, c, s) {
  const kv = cross(k, v), kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
}

/**
 * The tube around a polyline: `{ positions, normals, indices }` (Float32/Float32/Uint32,
 * Z-up part coordinates). One ring of `sides` vertices per kept point (points closer than
 * 1e-9 to the previous one are dropped); an open line gets flat caps with their own
 * vertices and axial normals; a `closed` line (last point equal to the first, as solveTaut
 * returns it) has no caps and closes the last ring onto the first. Fewer than two distinct
 * points gives empty arrays.
 */
export function tubeMesh(points, { radius, sides = LINE_TUBE_SIDES, closed = false } = {}) {
  const pts = [];
  for (const q of points ?? []) {
    if (!Array.isArray(q) || q.length < 3 || !q.every(Number.isFinite)) continue;
    if (!pts.length || len(sub(q, pts[pts.length - 1])) > DUP_EPS) pts.push([q[0], q[1], q[2]]);
  }
  if (closed && pts.length > 2 && len(sub(pts[0], pts[pts.length - 1])) <= DUP_EPS) pts.pop();
  const n = pts.length;
  if (n < 2 || !(radius > 0)) return EMPTY();
  const loop = closed && n >= 3;

  // tangent at each point: the segment's for an end of an open line, else the neighbours' mean
  const seg = [];
  for (let i = 0; i < (loop ? n : n - 1); i++) seg.push(unit(sub(pts[(i + 1) % n], pts[i])));
  const tan = pts.map((_, i) => {
    if (loop) return unit([0, 1, 2].map((c) => seg[(i + n - 1) % n][c] + seg[i][c]));
    if (i === 0) return seg[0];
    if (i === n - 1) return seg[n - 2];
    const t = unit([0, 1, 2].map((c) => seg[i - 1][c] + seg[i][c]));
    return len(t) > 0 ? t : seg[i];
  });
  for (let i = 0; i < n; i++) if (!(len(tan[i]) > 0)) tan[i] = seg[Math.min(i, seg.length - 1)];

  // parallel transport: carry a normal along, rotating it by each turn of the tangent
  const t0 = tan[0];
  const helper = Math.abs(t0[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const frames = [];
  let u = unit(cross(helper, t0));
  frames.push(u);
  for (let i = 1; i < n; i++) {
    const a = tan[i - 1], b = tan[i];
    const ax = cross(a, b), s = len(ax), c = dot(a, b);
    if (s > 1e-12) u = rotate(u, scale(ax, 1 / s), c, s);
    // re-orthogonalise against drift
    u = unit([0, 1, 2].map((k) => u[k] - b[k] * dot(u, b)));
    frames.push(u);
  }

  const ringCount = n;
  const capVerts = loop ? 0 : 2 * (sides + 1);
  const total = ringCount * sides + capVerts;
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const idx = [];
  for (let i = 0; i < n; i++) {
    const u1 = frames[i], v1 = cross(tan[i], u1);
    for (let j = 0; j < sides; j++) {
      const a = (2 * Math.PI * j) / sides;
      const nrm = [0, 1, 2].map((k) => u1[k] * Math.cos(a) + v1[k] * Math.sin(a));
      const o = 3 * (i * sides + j);
      for (let k = 0; k < 3; k++) { positions[o + k] = pts[i][k] + radius * nrm[k]; normals[o + k] = nrm[k]; }
    }
  }
  const rings = loop ? n : n - 1;
  for (let i = 0; i < rings; i++) {
    const r0 = i * sides, r1 = ((i + 1) % n) * sides;
    for (let j = 0; j < sides; j++) {
      const j1 = (j + 1) % sides;
      // counter-clockwise seen from outside (the ring turns u -> v = t x u)
      idx.push(r0 + j, r1 + j1, r1 + j, r0 + j, r0 + j1, r1 + j1);
    }
  }
  if (!loop) {
    let base = n * sides;
    for (const [end, dir] of [[0, -1], [n - 1, 1]]) {
      const t = tan[end], u1 = frames[end], v1 = cross(t, u1);
      const centre = base;
      const nrm = scale(t, dir);
      for (let k = 0; k < 3; k++) { positions[3 * centre + k] = pts[end][k]; normals[3 * centre + k] = nrm[k]; }
      for (let j = 0; j < sides; j++) {
        const a = (2 * Math.PI * j) / sides;
        const o = 3 * (centre + 1 + j);
        for (let k = 0; k < 3; k++) {
          positions[o + k] = pts[end][k] + radius * (u1[k] * Math.cos(a) + v1[k] * Math.sin(a));
          normals[o + k] = nrm[k];
        }
      }
      for (let j = 0; j < sides; j++) {
        const p = centre + 1 + j, q = centre + 1 + ((j + 1) % sides);
        // the end cap faces +t, the start cap faces -t
        if (dir > 0) idx.push(centre, p, q); else idx.push(centre, q, p);
      }
      base += sides + 1;
    }
  }
  return { positions, normals, indices: Uint32Array.from(idx) };
}
