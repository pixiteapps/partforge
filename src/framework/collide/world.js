// The collision world: how far apart are these pieces when placed by these matrices?
// Meshes stay in each sub-part's own frame; a placement is a column-major mat4 handed in
// per query, so a pose change never rebuilds a BVH. Pose mode and the sweep checker both
// read it. Pure (no DOM, three or node:), and loaded lazily by the worker.
//
// The mats contract, the same in every method: a `mats` Map with a name MISSING places
// it at the identity; a name mapped to `null` EXCLUDES it (an untrusted or non-rigid
// placement), so it is skipped by distances, inside and travel alike.
import { buildBVH, disposeBVHs } from "../oracle/bvh.js";
import { isAllowed } from "./declaration.js";
import { pairKey } from "./pairs.js";
import { placeMatrix } from "./place.js";
export { placeMatrix };
import { viewSubParts, resolveParams } from "../part-model.js";
import { mulMat4, invertRigid } from "../geometry/pose.js";

/**
 * placeMatrix for every in-view sub-part at an already-resolved (p, d); never derives.
 * `only` (an iterable of names): just those of them — a map that leaves the others out,
 * which the mats contract reads as identity, so it is for callers that read no other.
 */
export function poseMatrices(part, view, p, d, { deltas, only = null } = {}) {
  const out = new Map();
  const want = only ? new Set(only) : null;
  for (const name of viewSubParts(part, view, p)) {
    if (want && !want.has(name)) continue;
    const m = placeMatrix(part.parts[name], view, p, d);
    const delta = deltas?.get(name);
    out.set(name, m && delta ? mulMat4(delta, m) : m);
  }
  return out;
}

/**
 * For meshes built posed at (startP, startD): returns (p, d, only?) → Map of the matrices
 * that carry each mesh from its start pose to the pose at (p, d) (`only`: as poseMatrices').
 */
export function relativeMatsAt(part, view, startP, startD) {
  const inverses = new Map();
  for (const [name, m] of poseMatrices(part, view, startP, startD)) inverses.set(name, m ? invertRigid(m) : null);
  return (p, d, only = null) => {
    const out = new Map();
    for (const [name, m] of poseMatrices(part, view, p, d, { only })) {
      const inv = inverses.get(name);
      out.set(name, m && inv ? mulMat4(m, inv) : null);
    }
    return out;
  };
}

function boxOf(positions) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let j = 0; j < 3; j++) {
      const v = positions[i + j];
      if (v < b[j]) b[j] = v;
      if (v > b[j + 3]) b[j + 3] = v;
    }
  }
  return b;
}

const cornersOf = (b) => {
  const out = [];
  for (const x of [b[0], b[3]]) for (const y of [b[1], b[4]]) for (const z of [b[2], b[5]]) out.push([x, y, z]);
  return out;
};

const apply = (m, [x, y, z]) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];

function movedBox(box, m) {
  const out = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const c of cornersOf(box)) {
    const q = m ? apply(m, c) : c;
    for (let j = 0; j < 3; j++) {
      if (q[j] < out[j]) out[j] = q[j];
      if (q[j] > out[j + 3]) out[j + 3] = q[j];
    }
  }
  return out;
}

function boxGap(a, b) {
  let s = 0;
  for (let j = 0; j < 3; j++) {
    const g = Math.max(a[j] - b[j + 3], b[j] - a[j + 3], 0);
    s += g * g;
  }
  return Math.sqrt(s);
}

// Below this cutoff (mm) distances() asks the boolean query first: most pairs a small
// cutoff meets are clear, and withinDistancePosed proves that without the minimum.
const WITHIN_FIRST_MM = 0.5;

export function createCollisionWorld({ meshes, decl = null }) {
  const names = [...meshes.keys()];
  const bvhs = new Map();
  const boxes = new Map();
  for (const [name, mesh] of meshes) {
    bvhs.set(name, buildBVH(mesh));
    boxes.set(name, boxOf(mesh.positions));
  }
  const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const matOf = (mats, name) => mats.get(name); // undefined = identity, null = excluded

  return {
    names: () => [...names],
    boundsOf: (name) => boxes.get(name) ?? null,

    // `pairs` (a Set of pairKeys): only those pairs; `skip`: never those. Both filter
    // before any BVH query, so a caller that knows which pairs it wants pays for no other.
    // `upper` (a Map of pairKey → mm): a distance each pair is known to be within (the
    // gap between two of its surface points, say); it only tightens that pair's cutoff,
    // so a pair still reads exactly what it would without it. A value that is not a true
    // upper bound would lose the pair: only pass ones that are.
    // `limit` keeps the nearest `limit`; pairs are measured in order of box gap with the
    // cutoff shrunk to the limit-th nearest so far, which cannot change which pairs are
    // kept or what they read (a pair past the limit-th nearest is never among them).
    distances(mats, { names: only, within = Infinity, limit = Infinity, pairs = null, skip = null, upper = null } = {}) {
      const wanted = only ? new Set(only) : null;
      const live = names.filter((n) => matOf(mats, n) !== null);
      const moved = new Map(live.map((n) => [n, movedBox(boxes.get(n), matOf(mats, n))]));
      const cands = [];
      for (let i = 0; i < live.length; i++) {
        for (let j = i + 1; j < live.length; j++) {
          const a = live[i], b = live[j];
          if (wanted && !wanted.has(a) && !wanted.has(b)) continue;
          if (isAllowed(decl, a, b)) continue;
          let key = null;
          if (pairs || skip || upper) {
            key = pairKey(a, b);
            if ((pairs && !pairs.has(key)) || skip?.has(key)) continue;
          }
          const gap = boxGap(moved.get(a), moved.get(b));
          if (gap > within) continue;
          cands.push({ a, b, key, gap, order: cands.length });
        }
      }
      const bounded = limit < cands.length;
      if (bounded) cands.sort((x, y) => x.gap - y.gap || x.order - y.order);
      const found = [];
      let kth = Infinity; // the limit-th nearest distance so far (bounded only)
      for (const c of cands) {
        const { a, b } = c;
        let cut = within;
        const u = c.key !== null ? upper?.get(c.key) : undefined;
        if (u !== undefined && u < cut) cut = u * (1 + 1e-9) + 1e-9; // slack past rounding
        if (bounded && kth < cut) cut = kth;
        if (c.gap > cut) continue;
        const ma = matOf(mats, a) ?? IDENTITY, mb = matOf(mats, b) ?? IDENTITY;
        // a small cutoff is mostly a clear answer: the boolean query says so far sooner
        if (cut < WITHIN_FIRST_MM && !bvhs.get(a).withinDistancePosed(bvhs.get(b), ma, mb, cut)) continue;
        const r = bvhs.get(a).distanceToPosed(bvhs.get(b), ma, mb, cut);
        if (!(r.distance <= within)) continue;
        let normal = null;
        if (r.distance > 0) {
          const v = [0, 1, 2].map((k) => r.pointA[k] - r.pointB[k]);
          const len = Math.hypot(...v);
          if (len > 0) normal = v.map((x) => x / len);
        }
        found.push({ order: c.order, r: { a, b, distance: r.distance, at: r.at, pointA: r.pointA, pointB: r.pointB, normal } });
        if (bounded) {
          const ds = found.map((f) => f.r.distance).sort((x, y) => x - y);
          if (ds.length >= limit) kth = ds[limit - 1];
        }
      }
      // nearest first; ties keep pair order, as one stable sort over every pair would
      found.sort((x, y) => x.r.distance - y.r.distance || x.order - y.order);
      const out = found.map((f) => f.r);
      return out.length > limit ? out.slice(0, limit) : out;
    },

    inside(mats, a, b) {
      const ma = matOf(mats, a), mb = matOf(mats, b);
      if (ma === null || mb === null) return false;
      return bvhs.get(a).insideOf(bvhs.get(b), ma ?? IDENTITY, mb ?? IDENTITY) || bvhs.get(b).insideOf(bvhs.get(a), mb ?? IDENTITY, ma ?? IDENTITY);
    },

    travel(matsA, matsB, travelNames) {
      let worst = 0;
      for (const name of travelNames) {
        const box = boxes.get(name);
        if (!box) continue;
        const ma = matOf(matsA, name), mb = matOf(matsB, name);
        if (ma === null || mb === null) continue;
        for (const c of cornersOf(box)) {
          const p = ma ? apply(ma, c) : c, q = mb ? apply(mb, c) : c; // undefined = identity
          worst = Math.max(worst, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
        }
      }
      return worst;
    },

    dispose() { disposeBVHs(bvhs.values()); bvhs.clear(); },
  };
}
