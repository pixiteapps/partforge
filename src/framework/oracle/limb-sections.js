// Bone lengths and body sizes for the measure report (`limbs`). For each posed limb a
// part's `derive` returns, each joint's posed position, the distance to the next joint
// (or the tip), and the size of the body's cross-section at the joint: the plane through
// the joint square to its bone cuts a sub-part's mesh, and the outline that goes round
// the joint is measured along the joint's frame X (its bend axis) and frame Z (across it).
// Pure: it reads meshes measure already built and the plain-data `bones` a posed limb
// carries (kinematics core.js bonesOf), so it needs no kernel and no second build.

const r1 = (v) => Math.round(v * 10) / 10 + 0;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v) => {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n > 0 ? [v[0] / n, v[1] / n, v[2] / n] : null;
};

// A mesh (`{ positions, indices? }`) with its vertices merged by exact position, so an edge is the same edge in both
// triangles that share it even where the mesher split a vertex (a normal or UV seam).
function prepare(mesh) {
  const pos = mesh.positions;
  const n = pos.length / 3;
  const index = new Map();
  const canon = new Int32Array(n);
  const merged = [];
  for (let i = 0; i < n; i++) {
    const key = `${pos[3 * i]},${pos[3 * i + 1]},${pos[3 * i + 2]}`;
    let c = index.get(key);
    if (c === undefined) {
      c = merged.length / 3;
      index.set(key, c);
      merged.push(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]);
    }
    canon[i] = c;
  }
  // Without `indices` the positions are a triangle soup, as a kernel mesh's are: merging
  // the vertices above is what joins its triangles into outlines.
  const idx = mesh.indices;
  const tris = new Int32Array(idx ? idx.length : n);
  for (let i = 0; i < tris.length; i++) tris[i] = canon[idx ? idx[i] : i];
  return { points: Float64Array.from(merged), tris, count: merged.length / 3 };
}

// The outlines of one prepared mesh's cut by the plane through `origin` square to `y`, in
// the plane's (x, z) coordinates, measured from `origin`. Each closed chain is one outline;
// an open chain (a mesh that is not closed there) is dropped.
function outlines(prep, { origin, x, y, z }) {
  const { points, tris, count } = prep;
  const s = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const d = (points[3 * i] - origin[0]) * y[0] + (points[3 * i + 1] - origin[1]) * y[1] + (points[3 * i + 2] - origin[2]) * y[2];
    // A vertex exactly on the plane goes to one side, so it never splits an outline.
    s[i] = d === 0 ? 1e-9 : d;
  }
  const crossing = new Map(); // edge key → [u, v] in the plane
  const links = new Map(); // edge key → the edge keys it is joined to
  const edge = (a, b) => {
    const lo = a < b ? a : b, hi = a < b ? b : a;
    const key = lo * count + hi;
    if (!crossing.has(key)) {
      const t = s[lo] / (s[lo] - s[hi]);
      const q = [0, 1, 2].map((k) => points[3 * lo + k] + (points[3 * hi + k] - points[3 * lo + k]) * t - origin[k]);
      crossing.set(key, [dot(q, x), dot(q, z)]);
    }
    return key;
  };
  const link = (a, b) => {
    if (!links.has(a)) links.set(a, []);
    if (!links.has(b)) links.set(b, []);
    links.get(a).push(b);
    links.get(b).push(a);
  };
  for (let t = 0; t < tris.length; t += 3) {
    const v = [tris[t], tris[t + 1], tris[t + 2]];
    const cut = [];
    for (let e = 0; e < 3; e++) {
      const a = v[e], b = v[(e + 1) % 3];
      if ((s[a] > 0) !== (s[b] > 0)) cut.push(edge(a, b));
    }
    if (cut.length === 2) link(cut[0], cut[1]);
  }
  const seen = new Set();
  const out = [];
  for (const start of links.keys()) {
    if (seen.has(start)) continue;
    const chain = [start];
    seen.add(start);
    let prev = -1, cur = start, closed = false, ok = true;
    for (;;) {
      const next = links.get(cur);
      if (next.length !== 2) { ok = false; break; }
      const step = next[0] !== prev ? next[0] : next[1];
      if (step === start) { closed = true; break; }
      if (seen.has(step)) { ok = false; break; }
      seen.add(step);
      chain.push(step);
      prev = cur;
      cur = step;
    }
    if (ok && closed && chain.length >= 3) out.push(chain.map((k) => crossing.get(k)));
  }
  return out;
}

// Whether the plane's origin is inside a closed outline: an odd count of crossings of the
// ray from the origin along +u.
function aroundOrigin(poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ui, vi] = poly[i], [uj, vj] = poly[j];
    if ((vi > 0) !== (vj > 0) && ui + ((0 - vi) * (uj - ui)) / (vj - vi) > 0) inside = !inside;
  }
  return inside;
}

const area = (poly) => {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return Math.abs(a) / 2;
};

function sectionOf(prep, frame) {
  const f = { origin: frame.origin, x: unit(frame.x), y: unit(frame.y), z: unit(frame.z) };
  if (!f.x || !f.y || !f.z) return null;
  let best = null, bestArea = Infinity;
  for (const poly of outlines(prep, f)) {
    if (!aroundOrigin(poly)) continue;
    // Outlines that nest round the origin: the innermost is the smallest.
    const a = area(poly);
    if (a < bestArea) { best = poly; bestArea = a; }
  }
  if (!best) return null;
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [u, v] of best) { u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
  return { width: u1 - u0, depth: v1 - v0 };
}

/**
 * The size of the mesh's cross-section at `frame`: the plane through `frame.origin` square to
 * `frame.y` cuts the mesh, and the outline that goes round the origin is measured along
 * `frame.x` (`width`) and `frame.z` (`depth`). Null when no outline goes round it.
 */
export function sectionAt(mesh, frame) {
  return sectionOf(prepare(mesh), frame);
}

// A column-major mat4 (geometry/pose.js composePose) applied to a point and to a direction.
const movePoint = (m, [x, y, z]) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];
const moveDir = (m, [x, y, z]) => [
  m[0] * x + m[4] * y + m[8] * z,
  m[1] * x + m[5] * y + m[9] * z,
  m[2] * x + m[6] * y + m[10] * z,
];

const isBones = (v) => v != null && typeof v === "object" && v.bones != null && typeof v.bones === "object"
  && Array.isArray(v.bones.joints) && v.bones.tip != null;

// Every posed limb in derive's result: a value that carries `bones`, one level deep or in an
// array there, in the order they appear. A limb with a parent is skipped.
function posedLimbs(d) {
  if (d == null || typeof d !== "object") return [];
  const found = [];
  for (const v of Object.values(d)) {
    for (const item of Array.isArray(v) ? v : [v]) {
      if (isBones(item) && item.bones.parent !== true) found.push(item.bones);
    }
  }
  return found;
}

/**
 * The `limbs` section of the measure report, or undefined when `d` holds no posed limb.
 * `subparts` are the view's built sub-parts in declaration order, each `{ name, mesh, matrix }`
 * where `mesh` is in display coordinates and `matrix` (column-major, or null for none) carries
 * part coordinates to display. Each joint's section is read from the first sub-part whose
 * outline goes round it. Numbers are rounded to 0.1. The same limb found twice is read once.
 * A second limb with a name already reported is left out and named through `warn(message)`,
 * so it is never dropped silently.
 */
export function limbFacts(d, subparts, { warn } = {}) {
  const limbs = posedLimbs(d);
  if (!limbs.length) return undefined;
  const prepared = new Map();
  const prepOf = (s) => {
    if (!prepared.has(s)) prepared.set(s, prepare(s.mesh));
    return prepared.get(s);
  };
  const out = {};
  // A limb derive returns twice (`{ f, all: [f] }`) is one limb: read it once, before the
  // name check, so it is never taken for two limbs that share a name.
  const seen = new Set();
  for (const bones of limbs) {
    if (seen.has(bones)) continue;
    seen.add(bones);
    const name = String(bones.name);
    if (Object.hasOwn(out, name)) {
      warn?.(`two posed limbs are named "${name}": only the first is reported. Give each limb its own name`);
      continue;
    }
    const pts = bones.joints.map((j) => j.posed.origin).concat([bones.tip.posed]);
    const joints = bones.joints.map((j, i) => {
      const f = j.posed;
      const [a, b] = [pts[i], pts[i + 1]];
      const row = { name: j.name, at: f.origin.map(r1), length: r1(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])) };
      for (const s of subparts) {
        if (!s.mesh?.positions?.length) continue;
        const m = s.matrix;
        const frame = m
          ? { origin: movePoint(m, f.origin), x: moveDir(m, f.x), y: moveDir(m, f.y), z: moveDir(m, f.z) }
          : f;
        const sec = sectionOf(prepOf(s), frame);
        if (sec) return { ...row, part: s.name, width: r1(sec.width), depth: r1(sec.depth) };
      }
      return row;
    });
    out[name] = { joints, tip: bones.tip.posed.map(r1) };
  }
  return out;
}
