// The drag guard: what keeps a dragged piece from passing through another in Pose mode.
// Two halves (spec "Pose mode: collision in the solver"):
// - Solver rows. beginFrame picks this frame's blocked pairs (at most MAX_ROWS, nearest
//   first); linearise, once per solver iteration, stores each pair's closest points in
//   their own mesh frames and the separating normal; rows then evaluates every row from
//   placement matrices alone, so the solver's finite differences never touch a BVH.
// - The hard guarantee. settle walks from the last clear params to the solved ones in
//   sub-steps no longer than BAND / 2 of travel, and bisects back to contact at the first
//   step that is not clear.
// Part-agnostic: the caller hands in matsAt(params) → Map (world.js's mats contract) and
// the names that can move. Pure, like the world it reads.
import { pairKey, CONTACT_EPS } from "./pairs.js";
import { invertRigid } from "../geometry/pose.js";

export const COLLIDE_BAND_MM = 2;     // rows start this far out, so the solver turns away early
export const COLLIDE_WEIGHT = 100;    // a row's weight: param-solve.js's HOLD_WEIGHTS scale
export const MAX_ROWS = 8;            // rows per frame, nearest first
export const MAX_SUBSTEPS = 32;       // settle's sub-steps per frame; a flick past it lags
export const SETTLE_BISECTIONS = 12;  // 1 mm step → ~0.25 µm of contact
export const COLLIDE_IN_SOLVE = true; // false: settle alone, no solver rows (the fallback)

const apply = (m, [x, y, z]) => (m ? [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
] : [x, y, z]); // undefined = identity (the mats contract)

function boxUnder(box, m) {
  const out = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const x of [box[0], box[3]]) for (const y of [box[1], box[4]]) for (const z of [box[2], box[5]]) {
    const q = apply(m, [x, y, z]);
    for (let j = 0; j < 3; j++) { out[j] = Math.min(out[j], q[j]); out[j + 3] = Math.max(out[j + 3], q[j]); }
  }
  return out;
}

const boxesOverlap = (a, b) => [0, 1, 2].every((j) => a[j] <= b[j + 3] && b[j] <= a[j + 3]);

/** Linear blend of every numeric param `from` and `to` share; others take `to`'s value. */
function linearBlend(from, to) {
  return (t) => {
    const out = { ...to };
    for (const k of Object.keys(to)) {
      if (typeof from[k] === "number" && typeof to[k] === "number") out[k] = t === 1 ? to[k] : from[k] + t * (to[k] - from[k]);
    }
    return out;
  };
}

export function createDragGuard({ world, matsAt, start, moving, clearance = CONTACT_EPS }) {
  const margin = clearance + COLLIDE_BAND_MM;
  const half = COLLIDE_BAND_MM / 2;
  // pairKey → "near" (inside clearance: exempt until it opens past clearance once) or
  // "inside" (wholly inside, where distance reads clear: exempt until it reaches the
  // surface, then "near"). guardOnly: pairs below the band at start, never rows.
  // A "near" pair is free to move, deeper in included, until it opens past clearance
  // once: "never further in" would need penetration depth, which distance alone does not
  // give. An "inside" pair relies on sub-stepping to see it reach the surface, which
  // assumes pieces thicker than BAND / 2.
  const exempt = new Map();
  const guardOnly = new Set();

  const startMats = matsAt(start);
  for (const r of world.distances(startMats, { names: moving, within: COLLIDE_BAND_MM })) {
    const key = pairKey(r.a, r.b);
    if (r.distance < COLLIDE_BAND_MM) guardOnly.add(key);
    if (r.distance <= clearance) exempt.set(key, "near");
  }
  // Wholly inside at begin: one parity test per pair whose boxes overlap, once per drag.
  const names = world.names().filter((n) => startMats.get(n) !== null);
  const movingSet = new Set(moving);
  const boxes = new Map(names.map((n) => [n, boxUnder(world.boundsOf(n), startMats.get(n))]));
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i], b = names[j], key = pairKey(a, b);
      if (!movingSet.has(a) && !movingSet.has(b)) continue;
      if (exempt.has(key) || !boxesOverlap(boxes.get(a), boxes.get(b))) continue;
      if (world.inside(startMats, a, b)) { exempt.set(key, "inside"); guardOnly.add(key); }
    }
  }

  // One clearance query at mats: clear unless a non-exempt pair is inside clearance;
  // `next` is the exemption map as it stands once this pose is accepted.
  function check(mats) {
    const hits = world.distances(mats, { names: moving, within: clearance });
    const next = new Map(exempt);
    const touching = new Set();
    let blocked = null;
    for (const r of hits) {
      const key = pairKey(r.a, r.b);
      touching.add(key);
      if (exempt.has(key)) next.set(key, "near");
      else if (!blocked) blocked = { a: r.a, b: r.b };
    }
    for (const [key, kind] of exempt) if (kind === "near" && !touching.has(key)) next.delete(key);
    return { clear: !blocked, blocked, next };
  }
  const accept = ({ next }) => { exempt.clear(); for (const [k, v] of next) exempt.set(k, v); };

  let rows = [];
  let lastParams = null;
  let lastTravel = 0;
  const windowMm = () => margin + lastTravel;

  // Store a distances() result on its row, mapped into each mesh's own frame.
  function store(row, r, mats) {
    const ma = mats.get(row.a), mb = mats.get(row.b);
    if (!r || ma === null || mb === null) { row.active = false; return; }
    row.active = true;
    row.pa = apply(ma ? invertRigid(ma) : undefined, row.a === r.a ? r.pointA : r.pointB);
    row.pb = apply(mb ? invertRigid(mb) : undefined, row.a === r.a ? r.pointB : r.pointA);
    row.normal = r.normal && (row.a === r.a ? r.normal : r.normal.map((x) => -x));
  }

  return {
    get rowCount() { return rows.length; },

    beginFrame(params) {
      const mats = matsAt(params);
      lastTravel = lastParams ? world.travel(matsAt(lastParams), mats, moving) : 0;
      lastParams = params;
      rows = [];
      const skip = new Set([...exempt.keys(), ...guardOnly]); // never rows: not worth a query
      for (const r of world.distances(mats, { names: moving, within: windowMm(), skip })) {
        const key = pairKey(r.a, r.b);
        if (exempt.has(key) || guardOnly.has(key)) continue;
        const row = { a: r.a, b: r.b, key };
        store(row, r, mats);
        rows.push(row);
        if (rows.length === MAX_ROWS) break;
      }
    },

    linearise(params) {
      if (!rows.length) return;
      const mats = matsAt(params);
      const names = [...new Set(rows.flatMap((r) => [r.a, r.b]))];
      const pairs = new Set(rows.map((r) => r.key)); // the rows' own pairs, never a neighbour's
      const byKey = new Map(world.distances(mats, { names, within: windowMm(), pairs }).map((r) => [pairKey(r.a, r.b), r]));
      for (const row of rows) store(row, byKey.get(row.key), mats);
    },

    rows(params) {
      const out = new Float64Array(rows.length);
      if (!rows.length) return out;
      const mats = matsAt(params);
      rows.forEach((row, i) => {
        if (!row.active) return;
        if (!row.normal) { out[i] = COLLIDE_WEIGHT * margin; return; } // at contact: saturated
        const wa = apply(mats.get(row.a), row.pa), wb = apply(mats.get(row.b), row.pb);
        const n = row.normal;
        const gap = n[0] * (wa[0] - wb[0]) + n[1] * (wa[1] - wb[1]) + n[2] * (wa[2] - wb[2]);
        out[i] = COLLIDE_WEIGHT * Math.max(0, margin - gap);
      });
      return out;
    },

    isClear: (params) => check(matsAt(params)).clear,

    settle(from, to, { blend = linearBlend(from, to) } = {}) {
      let t0 = 0, p0 = from, m0 = matsAt(from);
      const total = world.travel(m0, matsAt(blend(1)), moving);
      let dt = total > 0 ? Math.min(1, (0.9 * half) / total) : 1;
      for (let steps = 0; t0 < 1 && steps < MAX_SUBSTEPS; steps++) {
        // A step no longer than BAND / 2 of travel: shrink by the secant until it fits
        // (a chord underestimates an arc, so the first guess can be long).
        // A blend that jumps (a goal blend re-solves) may never fit: then lag at the last
        // clear step rather than check a step long enough to tunnel.
        let t1, p1, m1, trv;
        for (let tries = 0; ; tries++) {
          t1 = Math.min(1, t0 + dt); p1 = blend(t1); m1 = matsAt(p1);
          trv = world.travel(m0, m1, moving);
          if (trv <= half) break;
          if (tries === 8) return { params: p0, blocked: null };
          dt = (t1 - t0) * Math.max(0.1, (0.9 * half) / trv);
        }
        const c = check(m1);
        if (!c.clear) {
          let lo = t0, loP = p0, hi = t1, blocked = c.blocked;
          for (let i = 0; i < SETTLE_BISECTIONS; i++) {
            const mid = (lo + hi) / 2, pm = blend(mid), cm = check(matsAt(pm));
            if (cm.clear) { accept(cm); lo = mid; loP = pm; } else { hi = mid; blocked = cm.blocked; }
          }
          return { params: loP, blocked };
        }
        accept(c);
        const took = t1 - t0;
        t0 = t1; p0 = p1; m0 = m1;
        dt = trv > 0 ? took * Math.min(2, (0.9 * half) / trv) : Math.min(1, took * 2);
      }
      return { params: p0, blocked: null };
    },
  };
}
