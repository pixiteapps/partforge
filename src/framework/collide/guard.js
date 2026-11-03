// The drag guard: what keeps a dragged piece from passing through another in Pose mode.
// Two halves (spec "Pose mode: collision in the solver"):
// - Solver rows. beginFrame picks this frame's blocked pairs (at most MAX_ROWS, nearest
//   first); linearise, once per solver iteration, stores each pair's closest points in
//   their own mesh frames and the separating normal; rows then evaluates every row from
//   placement matrices alone, so the solver's finite differences never touch a BVH.
// - The hard guarantee. settle walks from the last clear params to the solved ones in
//   sub-steps no longer than BAND / 2 of travel, and bisects back to contact at the first
//   step that is not clear.
// Part-agnostic: the caller hands in matsAt(params, names?) → Map (world.js's mats
// contract; with `names`, a map that may hold only those — the guard then reads no other)
// and the names that can move. Pure, like the world it reads.
import { pairKey, CONTACT_EPS } from "./pairs.js";
import { invertRigid, mulMat4 } from "../geometry/pose.js";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

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

/** The farthest a corner of `box` moves placed by m1 instead of m0 (world.travel's rule). */
function cornerTravel(box, m0, m1) {
  if (!box) return Infinity; // no box, no bound
  let worst = 0;
  for (const x of [box[0], box[3]]) for (const y of [box[1], box[4]]) for (const z of [box[2], box[5]]) {
    const p = apply(m0, [x, y, z]), q = apply(m1, [x, y, z]);
    worst = Math.max(worst, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
  }
  return worst;
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
  const startReadings = world.distances(startMats, { names: moving, within: COLLIDE_BAND_MM });
  for (const r of startReadings) {
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
  // Lower bounds on pair gaps by relative placement, kept for the drag (world.distances'
  // `bounds`): most pairs a check meets have not moved relative to each other since the
  // last one, or by less than its pad.
  const clearBounds = new Map();
  function check(mats) {
    const hits = world.distances(mats, { names: moving, within: clearance, bounds: clearBounds });
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
  let names_ = null; // the rows' sub-parts, cached per beginFrame
  const rowNames = () => (names_ ??= [...new Set(rows.flatMap((r) => [r.a, r.b]))]);
  let active = false; // some row's exact gap, at the last linearisation, is inside margin
  let lastParams = null;
  let lastTravel = 0;
  const windowMm = () => margin + lastTravel;

  // What the drag has learned about each pair, kept across frames:
  // - `seen`: its last closest points, in each mesh's own frame — two points on its
  //   surfaces, so wherever the pair is placed their distance bounds its gap from above;
  // - `known`: a lower bound on its gap, by RELATIVE placement — R carries b's mesh into
  //   a's (a, b as distances() orders them), so the bound holds wherever the two are
  //   placed with that R, and at another R' it holds less the farthest b's box corners
  //   move from R to R' (a point's motion is affine, so a box's worst is at a corner).
  //   A whole hand turning on its wrist moves no pair relative to another.
  const seen = new Map(), known = new Map();
  const relOf = (ma, mb) => mulMat4(invertRigid(ma ?? IDENTITY), mb ?? IDENTITY);
  /** A lower bound on the a×b gap at (ma, mb) from `known`, or -Infinity. */
  function lowerBound(key, b, ma, mb) {
    const e = known.get(key);
    if (!e || ma === null || mb === null) return -Infinity;
    return e.d - cornerTravel(world.boundsOf(b), e.R, relOf(ma, mb));
  }
  /** The `seen` points' distance at mats, or Infinity. */
  function upperBound(key, mats) {
    const e = seen.get(key);
    if (!e || !mats.has(e.a) || !mats.has(e.b)) return Infinity; // a names-limited map: unknown
    const ma = mats.get(e.a), mb = mats.get(e.b);
    if (ma === null || mb === null) return Infinity;
    const wa = apply(ma, e.pa), wb = apply(mb, e.pb);
    return Math.hypot(wa[0] - wb[0], wa[1] - wb[1], wa[2] - wb[2]);
  }
  // `upper` for world.distances: the seen points bound each pair's gap, which lets the
  // exact query cut its search there and still read the exact answer.
  function upperBounds(mats, keys = seen.keys()) {
    const out = new Map();
    for (const key of keys) { const u = upperBound(key, mats); if (u < Infinity) out.set(key, u); }
    return out;
  }

  // Store a distances() result on its row, mapped into each mesh's own frame. `within` is
  // the cutoff the query ran under: a pair it did not return is at least that far apart.
  function store(row, r, mats, within) {
    const ma = mats.get(row.a), mb = mats.get(row.b);
    row.pend = null;
    if (ma === null || mb === null) { row.active = false; return; }
    known.set(row.key, { R: relOf(ma, mb), d: r ? r.distance : within - 1e-9 });
    if (!r) { row.active = false; return; }
    row.active = true;
    row.gap = r.distance;
    row.pa = apply(ma ? invertRigid(ma) : undefined, row.a === r.a ? r.pointA : r.pointB);
    row.pb = apply(mb ? invertRigid(mb) : undefined, row.a === r.a ? r.pointB : r.pointA);
    row.normal = r.normal && (row.a === r.a ? r.normal : r.normal.map((x) => -x));
    seen.set(row.key, { a: row.a, b: row.b, pa: row.pa, pb: row.pb });
  }

  // Lazy rows. A row's value is w·max(0, margin − gap), so a pair that cannot be inside
  // the margin reads exactly 0 whatever its closest points are. A row whose lower bound
  // (`known`) is past the margin is therefore not measured: it keeps the pose it would
  // have been measured at (`pend`: beginFrame's or a linearisation's) and that bound, and
  // reads 0 at every evaluation whose own relative drift keeps the bound past the margin.
  // Only when one does not is it measured — at the pend pose, exactly the query eager
  // linearisation would have run there — so every row reads bit for bit what it would.
  //
  // beginFrame goes lazy too when it can: the rows are the pairs within the window
  // (when there are at most MAX_ROWS of them, every one is a row), found from the bounds
  // and a boolean query where those cannot tell, with no exact query. The eager order
  // (nearest first at the frame's start) is only needed once a row can read non-zero:
  // until then every row reads 0 in either order, and a residual of zeros is the same
  // in any order. The first measurement in the frame therefore orders the rows first
  // (`order()`), from their exact readings at the frame's start pose.
  const LAZY_SLACK_MM = 1e-6; // past any rounding in a row's own arithmetic
  let frameMats = null; // the frame's start placements (a lazy beginFrame's), for order()
  let ordered = true;
  function order() {
    if (ordered) return;
    ordered = true;
    const within = windowMm(), byKey = new Map();
    const keyed = rows.filter((row) => !row.pend?.begin); // measured or pending since: read only
    if (keyed.length) {
      const pairs = new Set(keyed.map((r) => r.key));
      for (const r of world.distances(frameMats, { within, pairs, upper: upperBounds(frameMats, pairs) })) byKey.set(pairKey(r.a, r.b), r.distance);
    }
    for (const row of rows) {
      if (row.pend?.begin) { resolve(row); row.beginD = row.active ? row.gap : Infinity; }
      else row.beginD = byKey.get(row.key) ?? Infinity;
    }
    rows.sort((x, y) => x.beginD - y.beginD || x.order - y.order);
  }
  function resolve(row) {
    const { mats, within } = row.pend;
    const [r = null] = world.distances(mats, { names: [row.a, row.b], within, pairs: new Set([row.key]), upper: upperBounds(mats, [row.key]) });
    store(row, r, mats, within);
  }
  /** Keep `row` pending at mats (its a and b) if its bound is past the margin; else false. */
  function defer(row, mats, within, begin = false) {
    const ma = mats.get(row.a), mb = mats.get(row.b);
    const lb = lowerBound(row.key, row.b, ma, mb);
    if (!(lb > margin + LAZY_SLACK_MM)) return false;
    row.pend = { mats: new Map([[row.a, ma], [row.b, mb]]), within, lb, R: relOf(ma, mb), begin };
    return true;
  }

  // What the start's query already tells: each pair it read, and that every other pair
  // that can move is past the band.
  {
    const read = new Map(startReadings.map((r) => [pairKey(r.a, r.b), r]));
    for (const c of world.candidates(startMats, { names: moving })) {
      const ma = startMats.get(c.a), mb = startMats.get(c.b), r = read.get(c.key);
      known.set(c.key, { R: relOf(ma, mb), d: r ? r.distance : COLLIDE_BAND_MM - 1e-9 });
      if (r && r.distance > 0) {
        const flip = r.a !== c.a;
        seen.set(c.key, {
          a: c.a, b: c.b,
          pa: apply(ma ? invertRigid(ma) : undefined, flip ? r.pointB : r.pointA),
          pb: apply(mb ? invertRigid(mb) : undefined, flip ? r.pointA : r.pointB),
        });
      }
    }
  }

  // The eager beginFrame: the nearest MAX_ROWS pairs in the window, each measured.
  function beginEager(mats, skip) {
    // skip drops every pair the loop below would, so the nearest MAX_ROWS are its rows
    for (const r of world.distances(mats, { names: moving, within: windowMm(), skip, limit: MAX_ROWS, upper: upperBounds(mats) })) {
      const key = pairKey(r.a, r.b);
      if (exempt.has(key) || guardOnly.has(key)) continue;
      const row = { a: r.a, b: r.b, key };
      store(row, r, mats, windowMm());
      rows.push(row);
      if (rows.length === MAX_ROWS) break;
    }
  }
  /** The lazy beginFrame, or false (nothing changed) when it cannot tell the rows apart. */
  function beginLazy(mats, skip) {
    const within = windowMm();
    const inside = [];
    for (const c of world.candidates(mats, { names: moving, within, skip })) {
      const ma = mats.get(c.a), mb = mats.get(c.b);
      if (lowerBound(c.key, c.b, ma, mb) > within + LAZY_SLACK_MM) continue;   // provably out
      if (!(upperBound(c.key, mats) < within - LAZY_SLACK_MM) && !world.within(mats, c.a, c.b, within)) continue;
      inside.push(c);
      if (inside.length > MAX_ROWS) return false; // which are the nearest needs the readings
    }
    const lazy = inside.map((c) => ({ a: c.a, b: c.b, key: c.key, order: c.order }));
    for (const row of lazy) if (!defer(row, mats, within, true)) return false;
    rows = lazy;
    frameMats = mats;
    ordered = false;
    return true;
  }

  return {
    get rowCount() { return rows.length; },
    /**
     * Whether some row is in play: its exact gap at the last linearisation (beginFrame's,
     * or linearise's since) is below margin (clearance + band). rowCount alone also counts
     * pairs the travel slack pulled into the window, which may sit 10-20 mm apart.
     */
    get active() { return active; },

    beginFrame(params) {
      const mats = matsAt(params);
      lastTravel = lastParams ? world.travel(matsAt(lastParams, moving), mats, moving) : 0;
      lastParams = params;
      rows = [];
      names_ = null;
      ordered = true;
      frameMats = null;
      const skip = new Set([...exempt.keys(), ...guardOnly]); // never rows: not worth a query
      if (!beginLazy(mats, skip)) { rows = []; beginEager(mats, skip); }
      // a pending row's gap is past the margin: it is never the active one
      active = rows.some((row) => !row.pend && row.active && row.gap < margin);
    },

    linearise(params) {
      if (!rows.length) return;
      const names = rowNames();
      const mats = matsAt(params, names); // the pairs filter reads no other placement
      const within = windowMm();
      const now = rows.filter((row) => !defer(row, mats, within));
      if (now.length) {
        order();
        const pairs = new Set(now.map((r) => r.key)); // the rows' own pairs, never a neighbour's
        const byKey = new Map(world.distances(mats, { names, within, pairs, upper: upperBounds(mats, pairs) }).map((r) => [pairKey(r.a, r.b), r]));
        for (const row of now) store(row, byKey.get(row.key), mats, within);
      }
      active = rows.some((row) => !row.pend && row.active && row.gap < margin);
    },

    rows(params) {
      const out = new Float64Array(rows.length);
      if (!rows.length) return out;
      const mats = matsAt(params, rowNames());
      // a row that must be measured orders the rows first: then the layout is the eager one
      const due = (row) => row.pend.lb - cornerTravel(world.boundsOf(row.b), row.pend.R, relOf(mats.get(row.a), mats.get(row.b))) <= margin + LAZY_SLACK_MM;
      if (!ordered && rows.some((row) => row.pend && due(row))) order();
      rows.forEach((row, i) => {
        if (row.pend) {
          if (!due(row)) return; // reads 0
          resolve(row);
        }
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
      const total = world.travel(m0, matsAt(blend(1), moving), moving);
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
