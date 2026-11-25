// cage.skin's two halves, pure and kernel-free: the weights (which limbs pull a cage
// point, and how much of each joint's turn it takes) and the posing (turning each point
// by its share of each joint's angle). Spec: docs/superpowers/specs/2026-11-23-cage-skin-design.md.
//
// The weights depend only on the rest cage, the limbs at rest, `blend` and `set`, never
// on the pose, so they are kept by content and a new pose costs only the turns.
//
// Limbs arrive as their `bones` field: plain data, because the limb and the cage can
// come from two copies of this module. Errors name a limb, a joint or a face, never a
// point index: a model writing the part cannot see one.
import { compose, invert } from "../xform.js";
import { axisAngle } from "../rotations.js";

const fail = (msg) => { throw new Error(`skin: ${msg}`); };
const OPTION_KEYS = new Set(["blend", "set"]);
const ENTRY_KEYS = new Set(["faces", "follow", "turn"]);
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const r3 = (v) => { const x = Math.round(v * 1000) / 1000; return x === 0 ? 0 : x; };
const smoothstep = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
// A pull this close to 1 counts as full, and a follow sum this far past 1 is still 1.
const FULL_EPS = 1e-9;
// A crossing this close to either end of the point → limb segment is the point's own
// surface or the limb line itself, not a face between them.
const END_EPS = 1e-6;
// The pull fades to nothing at this many radii from the limb's rest line.
const FADE_OUT = 1.5;

/**
 * Check skin's arguments and return `{ bones, blend, set }`, the limbs as their bones.
 * `set` entries keep their face ids; the cage resolves those itself, so a face that was
 * extruded away gets the cage's own error.
 */
export function readSkinArgs(limbs, options = {}) {
  const list = Array.isArray(limbs) ? limbs : [limbs];
  if (list.length === 0) fail("needs at least one posed limb");
  const bones = list.map((l, i) => {
    const b = isObj(l) ? l.bones : undefined;
    if (!isObj(b) || b.kind !== "partforge.bones")
      fail(`${Array.isArray(limbs) ? `limbs[${i}]` : "limbs"} is not a posed limb — pass limb(…).pose(…), usually from derive`);
    return b;
  });
  const seen = new Set();
  for (const b of bones) {
    if (seen.has(b.name)) fail(`limb "${b.name}" is given twice`);
    seen.add(b.name);
    if (b.parent) fail(`limb "${b.name}" has a parent — skin takes limbs in part coordinates for now`);
    if (b.r == null) fail(`limb "${b.name}" has no r — give the limb its radii`);
  }
  if (!isObj(options)) fail("options must be { blend?, set? }");
  for (const k of Object.keys(options))
    if (!OPTION_KEYS.has(k)) fail(`unknown option "${k}" — skin takes blend and set`);
  const jointNames = bones.flatMap((b) => b.joints.map((j) => j.name));
  const { blend, set = [] } = options;
  if (blend !== undefined) {
    if (isNum(blend)) { if (blend < 0) fail(`blend must be ≥ 0 mm, not ${blend}`); }
    else if (isObj(blend)) {
      for (const [k, v] of Object.entries(blend)) {
        if (!jointNames.includes(k)) fail(`blend names "${k}", which is not a joint of these limbs: ${jointNames.join(", ")}`);
        if (!isNum(v) || v < 0) fail(`blend["${k}"] must be a number of mm ≥ 0`);
      }
    } else fail('blend must be a number of mm, or { "<limb>.<joint>": mm }');
  }
  if (!Array.isArray(set)) fail("set must be a list of { faces, follow?, turn? }");
  const limbNames = bones.map((b) => b.name);
  set.forEach((e, i) => {
    if (!isObj(e)) fail(`set[${i}] must be { faces, follow?, turn? }`);
    for (const k of Object.keys(e)) if (!ENTRY_KEYS.has(k)) fail(`set[${i}] has unknown key "${k}" — an entry takes faces, follow and turn`);
    const faces = Array.isArray(e.faces) ? e.faces : [e.faces];
    if (e.faces === undefined || faces.length === 0 || !faces.every((f) => typeof f === "string"))
      fail(`set[${i}].faces must be a face id or a list of them`);
    if (e.follow === undefined && e.turn === undefined) fail(`set[${i}] needs follow or turn`);
    if (e.follow !== undefined) {
      if (!isObj(e.follow)) fail(`set[${i}].follow must be { <limb>: pull from 0 to 1 }`);
      for (const [k, v] of Object.entries(e.follow)) {
        if (!limbNames.includes(k)) fail(`set[${i}].follow names "${k}", which is not one of these limbs: ${limbNames.join(", ")}`);
        if (!isNum(v) || v < 0 || v > 1) fail(`set[${i}].follow.${k} must be a number from 0 to 1`);
      }
    }
    if (e.turn !== undefined) {
      if (!isObj(e.turn)) fail(`set[${i}].turn must be { "<limb>.<joint>": share from 0 to 1 }`);
      for (const [k, v] of Object.entries(e.turn)) {
        if (!jointNames.includes(k)) fail(`set[${i}].turn names "${k}", which is not a joint of these limbs: ${jointNames.join(", ")}`);
        if (!isNum(v) || v < 0 || v > 1) fail(`set[${i}].turn["${k}"] must be a number from 0 to 1`);
      }
    }
  });
  return { bones, blend, set: set.map((e) => ({ ...e, faces: Array.isArray(e.faces) ? e.faces : [e.faces] })) };
}

// Weights by content: the rest cage, the limbs at rest, blend and set. A part re-runs its
// cage code on every drag move, so the same cage is skinned many times at new poses.
const CACHE = new Map();
const CACHE_MAX = 8;
const STATS = { hits: 0, misses: 0 };
/** How often skinWeights found its weights kept, and how often it worked them out. For tests. */
export const skinCacheStats = () => ({ ...STATS });

/**
 * Per-point weights for a rest cage `snapshot` ({ points, faces, ids }) and limbs' bones:
 * `{ points: [[{ limb, w, shares }]], report }`, one list per snapshot point of the limbs
 * that pull it (`w`, 0 to 1) and its share of each of that limb's joints.
 */
export function skinWeights(snapshot, bones, { blend, set = [] } = {}) {
  // The ids are part of the key: the report names faces by them, and set entries find
  // their faces by them, so two cages of one shape but other ids must not share an entry.
  const key = JSON.stringify([snapshot.points, snapshot.faces, snapshot.ids,
    bones.map((b) => [b.name, b.r, b.joints.map((j) => [j.name, j.rest]), b.tip.rest]), blend ?? null, set]);
  const hit = CACHE.get(key);
  if (hit) { STATS.hits++; return hit; }
  STATS.misses++;
  const weights = computeWeights(snapshot, bones, blend, set);
  CACHE.set(key, weights);
  if (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  return weights;
}

function computeWeights(snapshot, bones, blend, set) {
  const { points, faces, ids } = snapshot;
  const limbs = bones.map((b) => restLimb(b, blend));
  const vis = visibility(points, faces);

  // Automatic pulls: close to the rest line, and nothing of the cage between.
  const pulls = points.map(() => new Map());
  limbs.forEach((L, li) => {
    let nearest = Infinity;
    points.forEach((p, pi) => {
      const { d, q, rho } = nearestOnLine(L, p);
      nearest = Math.min(nearest, d);
      const w = pullAt(d, rho);
      if (w > 0 && (d === 0 || vis.clear(pi, q))) pulls[pi].set(li, w);
    });
    L.nearest = nearest;
  });
  // Over 1 is shared in proportion; under 1 the rest stays on the body.
  for (const m of pulls) {
    let sum = 0;
    for (const w of m.values()) sum += w;
    if (sum > 1) for (const [li, w] of m) m.set(li, w / sum);
  }

  // Explicit weights, in order. follow replaces every automatic pull of its points, and
  // later entries replace earlier ones key by key; turn does the same for shares.
  const limbIndex = new Map(bones.map((b, i) => [b.name, i]));
  const jointIndex = new Map(bones.flatMap((b, li) => b.joints.map((j, ji) => [j.name, [li, ji]])));
  const faceIndex = new Map(ids.map((id, i) => [id, i]));
  const facePoints = (id) => faces[faceIndex.get(id)];
  const followed = new Set();
  set.forEach((e, i) => {
    if (!e.follow) return;
    for (const id of e.faces) for (const pi of facePoints(id)) {
      if (!followed.has(pi)) { pulls[pi].clear(); followed.add(pi); }
      for (const [name, w] of Object.entries(e.follow)) {
        if (w > 0) pulls[pi].set(limbIndex.get(name), w); else pulls[pi].delete(limbIndex.get(name));
      }
      let sum = 0;
      for (const w of pulls[pi].values()) sum += w;
      if (sum > 1 + FULL_EPS) fail(`set[${i}].follow adds up to ${r3(sum)} for face "${id}" — at most 1`);
    }
  });
  const turns = points.map(() => null);
  set.forEach((e, i) => {
    if (!e.turn) return;
    for (const [joint, s] of Object.entries(e.turn)) {
      const [li, ji] = jointIndex.get(joint);
      for (const id of e.faces) {
        const pts = facePoints(id);
        if (!pts.some((pi) => pulls[pi].has(li)))
          fail(`set[${i}].turn names "${joint}" for face "${id}", whose points limb "${bones[li].name}" does not pull — give the entry a follow, or name a face the limb pulls`);
        for (const pi of pts) (turns[pi] ??= new Map()).set(`${li}:${ji}`, s);
      }
    }
  });

  limbs.forEach((L, li) => {
    if (!pulls.some((m) => m.has(li)))
      fail(`limb "${L.name}" pulls no point of the cage: its rest line is ${Math.round(L.nearest * 10) / 10} mm from the nearest point. Check its at and toward, or its r`);
  });

  const out = points.map((p, pi) => [...pulls[pi]].sort((a, b) => a[0] - b[0]).map(([li, w]) => {
    const L = limbs[li];
    const shares = L.joints.map((J, ji) => turns[pi]?.get(`${li}:${ji}`) ?? shareAt(J, p));
    return { limb: li, w, shares };
  }));
  return { points: out, report: buildReport(bones, ids, faces, pulls) };
}

// A limb at rest as the weights read it: the rest line (joint origins, then the tip),
// its radii, and per joint the origin, the direction down the limb and the blend length.
function restLimb(b, blend) {
  const line = [...b.joints.map((j) => j.rest.origin), b.tip.rest];
  const joints = b.joints.map((j, ji) => {
    // The direction to the next rest origin that is not at this one; a joint with no
    // length after it falls back to its own frame's y, which points down the bone.
    let u = null;
    for (let k = ji + 1; k < line.length && !u; k++) {
      const v = sub(line[k], line[ji]);
      const l = len(v);
      if (l > 0) u = v.map((x) => x / l);
    }
    u ??= j.rest.y;
    const bj = isNum(blend) ? blend : isObj(blend) && isNum(blend[j.name]) ? blend[j.name] : b.r[ji];
    return { origin: j.rest.origin, u, blend: bj };
  });
  return { name: b.name, line, r: b.r, joints };
}

// The nearest spot on the rest line, its distance, and the radius there (held at the
// end's past either end).
function nearestOnLine(L, p) {
  const { line, r } = L;
  let best = { d: len(sub(p, line[0])), q: line[0], rho: r[0] };
  for (let k = 0; k + 1 < line.length; k++) {
    const a = line[k], ab = sub(line[k + 1], a);
    const l2 = dot(ab, ab);
    if (l2 === 0) continue;
    const t = Math.min(1, Math.max(0, dot(sub(p, a), ab) / l2));
    const q = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
    const d = len(sub(p, q));
    if (d < best.d) best = { d, q, rho: r[k] + (r[k + 1] - r[k]) * t };
  }
  return best;
}

// 1 within the radius, falling smoothly to 0 at FADE_OUT radii.
function pullAt(d, rho) {
  if (d <= rho) return 1;
  if (!(rho > 0)) return 0;
  const t = (d - rho) / ((FADE_OUT - 1) * rho);
  return 1 - smoothstep(t);
}

// The share of a joint's turn: 0 before the joint, 1 after, rising smoothly across
// `blend` mm centred on it, measured down the limb. A zero blend is a step at the joint.
function shareAt(J, p) {
  const along = dot(sub(p, J.origin), J.u);
  if (!(J.blend > 0)) return along >= 0 ? 1 : 0;
  return smoothstep((along + J.blend / 2) / J.blend);
}

// The visibility test: does the segment from point pi to q cross a face that does not
// touch pi? Each quad is two triangles; crossings at the two ends are not counted.
function visibility(points, faces) {
  const tris = [];
  faces.forEach((f, fi) => {
    for (const [a, b, c] of [[f[0], f[1], f[2]], [f[0], f[2], f[3]]]) {
      const A = points[a], B = points[b], C = points[c];
      tris.push({ fi, A, e1: sub(B, A), e2: sub(C, A),
        min: [0, 1, 2].map((k) => Math.min(A[k], B[k], C[k])), max: [0, 1, 2].map((k) => Math.max(A[k], B[k], C[k])) });
    }
  });
  const touching = points.map(() => new Set());
  faces.forEach((f, fi) => f.forEach((pi) => touching[pi].add(fi)));
  return {
    clear(pi, q) {
      const p = points[pi], dir = sub(q, p);
      const lo = [0, 1, 2].map((k) => Math.min(p[k], q[k])), hi = [0, 1, 2].map((k) => Math.max(p[k], q[k]));
      for (const T of tris) {
        if (touching[pi].has(T.fi)) continue;
        if (T.max[0] < lo[0] || T.min[0] > hi[0] || T.max[1] < lo[1] || T.min[1] > hi[1] || T.max[2] < lo[2] || T.min[2] > hi[2]) continue;
        if (crosses(p, dir, T)) return false;
      }
      return true;
    },
  };
}

// Möller–Trumbore on the segment p + t·dir, t in (END_EPS, 1 − END_EPS).
function crosses(p, dir, { A, e1, e2 }) {
  const h = cross(dir, e2);
  const det = dot(e1, h);
  const scale = len(e1) * len(e2) * len(dir);
  if (!(Math.abs(det) > 1e-12 * scale)) return false;   // parallel: a grazing touch, not a crossing
  const inv = 1 / det;
  const s = sub(p, A);
  const u = dot(s, h) * inv;
  if (u < 0 || u > 1) return false;
  const qv = cross(s, e1);
  const v = dot(dir, qv) * inv;
  if (v < 0 || u + v > 1) return false;
  const t = dot(e2, qv) * inv;
  return t > END_EPS && t < 1 - END_EPS;
}

function buildReport(bones, ids, faces, pulls) {
  const limbs = Object.fromEntries(bones.map((b) => [b.name, { points: 0, full: 0 }]));
  let shared = 0, still = 0;
  for (const m of pulls) {
    if (m.size === 0) still++;
    if (m.size > 1) shared++;
    for (const [li, w] of m) {
      const entry = limbs[bones[li].name];
      entry.points++;
      if (w >= 1 - FULL_EPS) entry.full++;
    }
  }
  const byFace = {};
  faces.forEach((f, fi) => {
    if (f.every((pi) => pulls[pi].size === 0)) return;
    const follow = {};
    bones.forEach((b, li) => {
      const m = f.reduce((s, pi) => s + (pulls[pi].get(li) ?? 0), 0) / f.length;
      if (m > 0) follow[b.name] = r3(m);
    });
    byFace[ids[fi]] = { follow };
  });
  return { limbs, shared, still, faces: byFace };
}

// A frame { origin, x, y, z } as a rigid 3×4 (xform.js's layout: x, y, z are columns).
const matrixOf = ({ origin: o, x, y, z }) => Float64Array.of(
  x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2], o[0], o[1], o[2]);

/**
 * Each joint's own motion as { origin, axis, rad } (or null for none): C_j = D_{j−1}⁻¹ · D_j
 * with D_j = posed_j · rest_j⁻¹. C_j fixes the joint's rest origin, so it is a turn about it.
 */
function jointMotions(b) {
  let prevInv = null;
  return b.joints.map((j) => {
    const D = compose(matrixOf(j.posed), invert(matrixOf(j.rest)));
    const C = prevInv ? compose(prevInv, D) : D;
    prevInv = invert(D);
    const a = axisAngle(C);
    return a ? { origin: j.rest.origin, axis: a.axis, rad: (a.deg * Math.PI) / 180 } : null;
  });
}

// Turn q by `rad` about the line through `o` along the unit `u` (Rodrigues).
function turn(q, o, u, rad) {
  const v = sub(q, o), c = Math.cos(rad), s = Math.sin(rad);
  const k = dot(u, v) * (1 - c), w = cross(u, v);
  return [0, 1, 2].map((i) => o[i] + v[i] * c + w[i] * s + u[i] * k);
}

/**
 * The posed points: each point turned about each joint by its share of the joint's
 * angle, last joint first, then mixed with its rest place by how hard each limb pulls.
 * Turning, not mixing positions, is what keeps a knuckle's thickness at a bend. A point
 * no limb moves keeps its rest position bit for bit.
 */
export function applySkin(points, weights, bones) {
  const motions = bones.map(jointMotions);
  return points.map((p, pi) => {
    const list = weights.points[pi];
    if (!list.length) return p.slice();
    const delta = [0, 0, 0];
    let moved = false;
    for (const { limb, w, shares } of list) {
      const m = motions[limb];
      let q = p;
      for (let j = m.length - 1; j >= 0; j--) {
        if (!m[j] || shares[j] === 0) continue;
        q = turn(q, m[j].origin, m[j].axis, shares[j] * m[j].rad);
      }
      if (q === p) continue;
      moved = true;
      for (let k = 0; k < 3; k++) delta[k] += w * (q[k] - p[k]);
    }
    return moved ? [p[0] + delta[0], p[1] + delta[1], p[2] + delta[2]] : p.slice();
  });
}
