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
import { placeMatrix, poseMatrices } from "./place.js";
export { placeMatrix, poseMatrices };
import { viewSubParts, resolveParams } from "../part-model.js";
import { mulMat4, invertRigid } from "../geometry/pose.js";
import { IDENTITY, cornerTravel } from "./motion.js";
export { IDENTITY, cornerTravel };

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

// null for an empty mesh: it has no box, and an Infinity box would turn to NaN when moved
function boxOf(positions) {
  if (!positions?.length) return null;
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
  if (!box) return null;
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
// The room a `bounds` refresh asks for past the cutoff (mm): the bound it keeps then
// covers relative motion up to about this much. Larger covers more and costs more.
const BOUND_PAD_MM = 0.05;
const BOUND_PAD_MIN_MM = 1e-6; // still past a still pair's rounding drift (~1e-12 mm)
// Past any rounding in a relative placement and its corner motion (mm).
const BOUND_SLACK_MM = 1e-9;

/**
 * One sub-part's index, built once in its own mesh frame: `{ bvh, box }`. What a caller
 * that builds indexes ahead of a world (Pose mode, in idle time) keeps, and hands to
 * createCollisionWorld as `indexes`. Free it with disposeIndexes.
 */
export function buildIndex(mesh) {
  return { bvh: buildBVH(mesh), box: boxOf(mesh.positions) };
}

/** Free indexes buildIndex made (an iterable of them). */
export function disposeIndexes(indexes) {
  disposeBVHs([...indexes].map((ix) => ix?.bvh));
}

/**
 * `meshes` (name → mesh) are indexed here, and freed by dispose. `indexes` (name →
 * buildIndex's `{ bvh, box }`) are borrowed: the world reads them and dispose leaves them
 * to their owner. A name in both takes the borrowed index.
 */
export function createCollisionWorld({ meshes = new Map(), indexes = null, decl = null }) {
  const bvhs = new Map();
  const boxes = new Map();
  const owned = [];
  for (const [name, ix] of indexes ?? []) { bvhs.set(name, ix.bvh); boxes.set(name, ix.box); }
  for (const [name, mesh] of meshes) {
    if (bvhs.has(name)) continue;
    const ix = buildIndex(mesh);
    owned.push(ix.bvh);
    bvhs.set(name, ix.bvh);
    boxes.set(name, ix.box);
  }
  const names = [...bvhs.keys()];
  const matOf = (mats, name) => mats.get(name); // undefined = identity, null = excluded

  // The pairs distances() would measure, in its order: every live pair (a before b in
  // `names` order) passing the filters whose placed boxes are within `within`, each
  // { a, b, key, gap, order } with `order` its place in that sequence.
  function candidates(mats, { names: only = null, within = Infinity, pairs = null, skip = null } = {}) {
    const wanted = only ? new Set(only) : null;
    const live = names.filter((n) => matOf(mats, n) !== null);
    const moved = new Map(live.map((n) => [n, movedBox(boxes.get(n), matOf(mats, n))]));
    const cands = [];
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i], b = live[j];
        if (wanted && !wanted.has(a) && !wanted.has(b)) continue;
        if (isAllowed(decl, a, b)) continue;
        const key = pairKey(a, b);
        if ((pairs && !pairs.has(key)) || skip?.has(key)) continue;
        if (!moved.get(a) || !moved.get(b)) continue; // an empty mesh is near nothing
        const gap = boxGap(moved.get(a), moved.get(b));
        if (gap > within) continue;
        cands.push({ a, b, key, gap, order: cands.length });
      }
    }
    return cands;
  }

  return {
    names: () => [...names],
    boundsOf: (name) => boxes.get(name) ?? null,
    candidates,
    /** Whether a and b, placed by mats, are within eps: exactly distances' `<= eps` for the pair. */
    within(mats, a, b, eps) {
      const ma = matOf(mats, a), mb = matOf(mats, b);
      if (ma === null || mb === null) return false;
      return bvhs.get(a).withinDistancePosed(bvhs.get(b), ma ?? IDENTITY, mb ?? IDENTITY, eps);
    },

    // `pairs` (a Set of pairKeys): only those pairs; `skip`: never those. Both filter
    // before any BVH query, so a caller that knows which pairs it wants pays for no other.
    // `upper` (a Map of pairKey → mm): a distance each pair is known to be within (the
    // gap between two of its surface points, say); it only tightens that pair's cutoff,
    // so a pair still reads exactly what it would without it. A value that is not a true
    // upper bound would lose the pair: only pass ones that are.
    // `limit` keeps the nearest `limit`; pairs are measured in order of box gap with the
    // cutoff shrunk to the limit-th nearest so far, which cannot change which pairs are
    // kept or what they read (a pair past the limit-th nearest is never among them).
    //
    // `bounds` (a Map the caller keeps across calls, pairKey → { R, lb }): lower bounds on
    // pair distances, in RELATIVE terms — R carries b's mesh into a's — so they hold
    // wherever the two are placed, as long as their relative placement is R. A pair whose
    // bound, less the farthest b's box corners have moved relative to a since (a point's
    // motion is affine, so a box's worst is at a corner), is still past the cutoff is
    // not queried: it cannot be within it. A small cutoff's boolean query is asked with
    // BOUND_PAD_MM of room and its bound kept, so a pair that has not moved relative to
    // its neighbour (a finger riding a turning wrist) or has moved less than the pad (a
    // bisection's late steps) costs no query at all. Exact: a pair is skipped only when it
    // is provably past the cutoff.
    distances(mats, { names: only, within = Infinity, limit = Infinity, pairs = null, skip = null, upper = null, bounds = null } = {}) {
      const cands = candidates(mats, { names: only, within, pairs, skip });
      const bounded = limit < cands.length;
      if (bounded) cands.sort((x, y) => x.gap - y.gap || x.order - y.order);
      const found = [];
      let kth = Infinity; // the limit-th nearest distance so far (bounded only)
      const nearest = [];
      for (const c of cands) {
        const { a, b } = c;
        let cut = within;
        const u = c.key !== null ? upper?.get(c.key) : undefined;
        if (u !== undefined && u < cut) cut = u * (1 + 1e-9) + 1e-9; // slack past rounding
        if (bounded && kth < cut) cut = kth;
        if (c.gap > cut) continue;
        const ma = matOf(mats, a) ?? IDENTITY, mb = matOf(mats, b) ?? IDENTITY;
        if (bounds) {
          const R = mulMat4(invertRigid(ma), mb);
          const e = bounds.get(c.key);
          const drift = e ? cornerTravel(boxes.get(b), e.R, R) : Infinity;
          if (e && e.lb - drift > cut + BOUND_SLACK_MM) continue;
          if (cut < WITHIN_FIRST_MM) {
            // a pair that outran the pad since its last bound (a joint turning) gets only
            // the room rounding needs: the pad would cost a wider search for nothing
            const pad = e && drift > BOUND_PAD_MM ? BOUND_PAD_MIN_MM : BOUND_PAD_MM;
            const o = {};
            if (!bvhs.get(a).withinDistancePosed(bvhs.get(b), ma, mb, cut + pad, o)) { bounds.set(c.key, { R, lb: o.bound }); continue; }
          }
        }
        // a small cutoff is mostly a clear answer: the boolean query says so far sooner
        if (cut < WITHIN_FIRST_MM && !bvhs.get(a).withinDistancePosed(bvhs.get(b), ma, mb, cut)) continue;
        const r = bvhs.get(a).distanceToPosed(bvhs.get(b), ma, mb, cut);
        // not found (Infinity, no points) reads as clear even when `within` is Infinity
        if (!(r.distance < Infinity) || !(r.distance <= within)) continue;
        let normal = null;
        if (r.distance > 0) {
          const v = [0, 1, 2].map((k) => r.pointA[k] - r.pointB[k]);
          const len = Math.hypot(...v);
          if (len > 0) normal = v.map((x) => x / len);
        }
        found.push({ order: c.order, r: { a, b, distance: r.distance, at: r.at, pointA: r.pointA, pointB: r.pointB, normal } });
        if (bounded) {
          // the `limit` nearest so far, kept sorted: their last is the cutoff
          let i = nearest.length;
          while (i > 0 && nearest[i - 1] > r.distance) i--;
          nearest.splice(i, 0, r.distance);
          if (nearest.length > limit) nearest.length = limit;
          if (nearest.length === limit) kth = nearest[limit - 1];
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

    dispose() { disposeBVHs(owned); owned.length = 0; bvhs.clear(); },
  };
}
