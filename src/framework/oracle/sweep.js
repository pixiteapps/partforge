// Sweeps: a declared motion stepped end to end, checked for contact all the way along it
// (spec 2026-11-02-collisions-design.md, "Sweeps"). A sweep is a parameter over its range,
// a handle (one parameter sweep per DOF), a path between presets or waypoints, or an
// animation's timeline. Every motion is read as one value v running from `lo` to `hi`:
// the parameter's own value, or t ∈ [0, 1] for a path or an animation.
//
// Two paths. RIGID (only place() changes along the motion): each in-view sub-part is built
// once, posed at the start, and moved by relative matrices (relativeMatsAt), with steps
// halved until no moving point travels more than clearance / 2 + SETTLE_STEP_MM between
// checks. Between two checks every pair is held by conservative advancement: with T a bound
// on how far b's points near a move relative to a over the step, a pair is proven clear
// all the way along it when d_k + d_{k+1} > 2·clearance + T; when that fails the pair's
// interval is sub-stepped until it is proven or a contact is found, so a graze between two
// clear checks is never missed. T comes from the step's endpoint poses (a chord), padded by
// the arc a screw motion through those two poses takes: (θ/2)/sin(θ/2) for the relative
// rotation θ (arcFactor), with a pair whose relative turn passes π/2 sub-stepped before it
// is bounded. The one assumption left: between two samples the relative motion of a and b
// is close to a screw motion. A single joint between them, any translation and a constant-
// axis spin are exactly that; a coupled chain, a derive or an IK solve can break it.
// REBUILD (some sub-part's build changes, or its placement is untrusted): those sub-parts
// are rebuilt per step, on SWEEP_REBUILD_STEPS evenly spaced steps, checked at the steps
// only (a rebuilt mesh has no placement to bound its motion by).
//
// A step SWEEP_MAX_STEPS forces past the travel bound marks the row `capped: true`; the
// advancement above still holds each pair across it, under the same screw-motion
// assumption (a longer step leans on it harder).
//
// A pair counts as in contact at distance <= the sweep's clearance. A pair inside it at the
// sweep's start is a contact from the start, never exempt: a sweep asks "never closer than
// this anywhere", unlike a drag, which only refuses to push further in.
//
// Clearance 0 and below (spec 2026-11-12-moving-fits-swept-design.md, B): 0 means "may
// touch, never press in", a negative clearance "may press in up to this depth" (a detent).
// Distances are unsigned and the advancement proof needs a positive threshold, so such a
// sweep RUNS at TOUCH_TOL_MM, and each contact interval it finds is then read for depth
// (world.depth) ALONG it: rigid, at steps over which no point of the pair moves more than
// DEPTH_STEP_MM relative to the other (pairTravel, the advancement's own bound). Depth
// cannot change faster than that travel, so a dig that enters and leaves between two
// readings both within the allowance is at most DEPTH_STEP_MM / 2 (0.1 mm) past it. Where
// two readings straddle the allowance (-clearance + TOUCH_TOL_MM) the crossing is bisected
// to BISECT_TOL. The interval is then split into stretches: one past the allowance is a
// contact (`allowed: false`), one within it `allowed: true`, which leaves the row clear and
// its freeRange open. So a lid that rests closed and then presses in reads its contact
// from where it presses in. A rebuild sweep reads depth at its rebuild steps only, as it
// checks contact (no placement bounds a rebuilt mesh's motion). When the deadline stops a
// contact before it is read end to end, the stretches read before it keep their verdicts (a
// stretch already past the allowance is a contact that counts) and the rest is one contact
// `depthUnread: true`, with the deepest reading in it, and the row is `skipped: "timeout"`;
// verify withholds sweepContacts for it unless some contact counts. A row carries at most
// SWEEP_MAX_CONTACTS contacts (capContacts).
//
// On a positive-clearance sweep `depth` is informational: read at up to DEPTH_SAMPLES
// evenly spaced values, left off a contact when the deadline would be passed, never
// changing the row. Depth is a lower bound, as depth.js says, never an exact figure.
//
// Shared runtime: DOM-free, three-free and node:-free, loaded lazily by the worker. The
// caller owns the kernel round: built solids stay live until its kernel.cleanup().
import { viewSubParts, resolveParams, buildPosed } from "../part-model.js";
import { createCollisionWorld, relativeMatsAt, buildIndex, disposeIndexes, IDENTITY } from "../collide/world.js";
import { normalizeCollisions } from "../collide/declaration.js";
import { SETTLE_STEP_MM } from "../collide/guard.js";
import { CONTACT_EPS, pairKey, sweepContactBlocks } from "../collide/pairs.js";
import { applyMat, cornerTravel } from "../collide/motion.js";
import { invertRigid, mulMat4 } from "../geometry/pose.js";
import { motionOf, sweepsInView } from "../collide/sweep-targets.js";
import { TOUCH_TOL_MM } from "../collide/depth.js";

export const SWEEP_REBUILD_STEPS = 24;
export const SWEEP_MAX_STEPS = 2000;
/**
 * The most contacts one row carries. A row with more keeps every blocking contact first (in
 * order), then the unread ones, then the allowed ones, and says how many it dropped in
 * `contactsOmitted`. `clear`, `freeRange` and the sweepContacts gate are read before the cap.
 */
export const SWEEP_MAX_CONTACTS = 32;

const BISECT_TOL = 1e-3; // a contact's ends, as a share of the range
// A pair whose relative placement moved no more than this (mm, at its box corners) since
// its last reading has not moved.
const STILL_MM = 1e-9;
// minClearance chases a nearer pair only when it is nearer by this much (mm): the reading is
// within it of the sampled minimum. Chasing every hundredth of a micron re-measured each pin
// pair's wobble exactly at every step, two thirds of a hand sweep's time.
const MIN_RES_MM = 0.01;
// A relative turn past this between two samples is sub-stepped before it is bounded.
const MAX_TURN = Math.PI / 2;

/** The arc over the chord of a screw motion turning by `theta`: (θ/2)/sin(θ/2), 1 at 0. */
function arcFactor(theta) {
  const h = theta / 2;
  return h < 1e-8 ? 1 : Math.max(1, h / Math.sin(h));
}

/** The rotation angle of a rigid mat4's 3×3 part: cos θ = (trace − 1)/2, clamped. */
function turnOf(m) {
  return Math.acos(Math.min(1, Math.max(-1, (m[0] + m[5] + m[10] - 1) / 2)));
}
// A pair advancement cannot prove clear by an interval this small (a share of BISECT_TOL)
// is reported as a contact over it: conservative, and at most T/2 inside clearance.
const ADVANCE_FLOOR = 1 / 8;
// A positive-clearance sweep's informational depth readings per contact, ends included.
const DEPTH_SAMPLES = 7;
/**
 * On a sweep that may touch (clearance <= 0), the most any point of a contact pair moves
 * relative to the other between two depth readings (mm). A dig between two readings within
 * the allowance is at most half of this past it.
 */
export const DEPTH_STEP_MM = 0.2;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const clockNow = () => globalThis.performance?.now?.() ?? Date.now();

/**
 * The sweeps `part.verify.sweeps` declares for `view`, at `params`. A handle expands to one
 * param sweep per DOF ("<name>.<param>"); a goal handle yields none. A sweep whose target
 * cannot be read (an unknown param, preset or animation; a handle whose point cannot be
 * located) keeps `skip: "unreadable"`, a zero-length animation `skip: "no-motion"`;
 * a sweep that moves nothing in this view, or whose `views` leave it out, is dropped.
 * The reading lives in collide/sweep-targets.js, which lint shares.
 */
export function normalizeSweeps(part, view, params = {}) {
  const decl = part?.verify?.sweeps;
  if (!decl || typeof decl !== "object" || Array.isArray(decl)) return [];
  const full = { ...part.defaults, ...params };
  const declClear = normalizeCollisions(part)?.clearance ?? CONTACT_EPS;
  // `why` (lint's wording) and `animViews` are the reader's; a sweep entry carries neither.
  return Object.entries(decl).flatMap(([name, spec]) => sweepsInView(part, view, name, spec, full, declClear)
    .map(({ why: _w, animViews: _v, ...s }) => s));
}

const emptyRow = (s, extra) => ({
  name: s.name, clear: null, clearance: s.clearance, steps: 0, rebuilds: !!s.rebuild?.length,
  minClearance: null, contacts: [], freeRange: null, ms: 0, ...extra,
});

/**
 * Run every sweep `normalizeSweeps` gives for `view` at `params`, with `kernel` (the
 * oracle's build kernel). `deadline` is an absolute `now()` reading: a sweep it stops is
 * `skipped: "timeout"`, with what it read so far. A sweep that throws is `skipped:
 * "unreadable"` with its `error` message; the others still run. A skipped row's `clear` is
 * null. `skipStill: false` measures every pair at every step (a check that the still-pair
 * skip changes nothing; slower). `maxSteps` (default SWEEP_MAX_STEPS) caps a rigid sweep's
 * steps, as SWEEP_MAX_STEPS does. `exclude` (a Set of row names) leaves those sweeps out:
 * verify runs, in another view, only the sweeps its own view did not.
 */
export function runSweeps(kernel, part, view, params = {}, { deadline = Infinity, now = clockNow, skipStill = true, maxSteps = SWEEP_MAX_STEPS, exclude = null } = {}) {
  const rows = [];
  const full = { ...part.defaults, ...params };
  const decl = normalizeCollisions(part);
  for (const s of normalizeSweeps(part, view, params)) {
    if (exclude?.has(s.name)) continue;
    if (s.skip) { rows.push(emptyRow(s, { skipped: s.skip })); continue; }
    if (now() > deadline) { rows.push(emptyRow(s, { skipped: "timeout" })); continue; }
    const t0 = now();
    let row;
    try {
      row = sweepOne(kernel, part, view, full, decl, s, { deadline, now, skipStill, maxSteps });
    } catch (e) {
      row = emptyRow(s, { skipped: "unreadable", error: String(e?.message ?? e) });
    }
    row.ms = now() - t0;
    rows.push(row);
  }
  return rows;
}

/** AABB of `box` placed by m. */
function movedBox(box, m) {
  const out = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const x of [box[0], box[3]]) for (const y of [box[1], box[4]]) for (const z of [box[2], box[5]]) {
    const q = applyMat(m, [x, y, z]);
    for (let j = 0; j < 3; j++) { if (q[j] < out[j]) out[j] = q[j]; if (q[j] > out[j + 3]) out[j + 3] = q[j]; }
  }
  return out;
}

/**
 * How far, at most, any point of b that could reach within `clearance` of a moves relative
 * to a between two placements, along a screw motion through them: `{ T, theta }`, T in mm
 * (chord × arcFactor(theta)), theta the relative turn. The points of b's box (placed in a's
 * frame at the first pose) farther than clearance + T_full from a's box cannot reach it in
 * the step, so only the rest — clipped to a's box grown by that much — needs bounding; the
 * displacement is affine in the point, so the clip's corners bound it.
 */
function pairTravel(world, a, b, matsL, matsR, clearance) {
  const R0 = mulMat4(invertRigid(matsL.get(a) ?? IDENTITY), matsL.get(b) ?? IDENTITY);
  const R1 = mulMat4(invertRigid(matsR.get(a) ?? IDENTITY), matsR.get(b) ?? IDENTITY);
  const boxB = world.boundsOf(b), boxA = world.boundsOf(a);
  if (!boxA || !boxB) return { T: 0, theta: 0 }; // an empty mesh (no box) reaches nothing
  const D = mulMat4(R1, invertRigid(R0)); // a-frame position of a b point at pose L → at pose R
  const theta = turnOf(D), f = arcFactor(theta);
  const full = cornerTravel(boxB, R0, R1) * f;
  if (full <= STILL_MM) return { T: 0, theta };
  const m = clearance + full + 1e-6;
  const placed = movedBox(boxB, R0);
  const clip = [0, 1, 2].map((j) => [Math.max(placed[j], boxA[j] - m), Math.min(placed[j + 3], boxA[j + 3] + m)]);
  if (clip.some(([lo, hi]) => lo > hi)) return { T: 0, theta }; // nothing of b within reach of a this step
  let worst = 0;
  for (const x of clip[0]) for (const y of clip[1]) for (const z of clip[2]) {
    const q = applyMat(D, [x, y, z]);
    worst = Math.max(worst, Math.hypot(q[0] - x, q[1] - y, q[2] - z));
  }
  return { T: Math.min(full, worst * f), theta };
}

function sweepOne(kernel, part, view, full, decl, s, { deadline, now, skipStill, maxSteps }) {
  const motion = motionOf(part, view, full, s);
  const { lo, hi } = motion;
  const tol = BISECT_TOL * (hi - lo);
  // A sweep that may touch (clearance <= 0) runs at the touching tolerance; its contacts
  // are classified by depth against `allowance` below. The row reports s.clearance.
  const touching = s.clearance <= 0;
  const clearance = touching ? TOUCH_TOL_MM : s.clearance;
  const allowance = -s.clearance + TOUCH_TOL_MM;
  const rebuildSet = new Set(s.rebuild);
  const rigid = rebuildSet.size === 0;
  const active = [...s.moving, ...s.rebuild];
  const owned = [];   // indexes this sweep built
  let shared = null;  // the rigid path's one world
  kernel.beginSubPart?.(`oracle:sweep:${view}`);
  try {
    const start = resolveParams(part, motion.at(lo));
    // the sub-parts built once, at the start; a rebuilt one is built per step instead
    const meshes = new Map();
    for (const name of viewSubParts(part, view, start.p)) {
      if (rebuildSet.has(name)) continue;
      const mesh = buildPosed(kernel, part, name, { purpose: "display", view, p: start.p, d: start.d }).toMesh();
      if (mesh?.positions?.length) meshes.set(name, mesh); // an empty sub-part touches nothing (as Pose mode skips it)
    }
    const relMats = relativeMatsAt(part, view, start.p, start.d);
    const matsOf = (q) => {
      const { p, d } = resolveParams(part, q);
      const mats = relMats(p, d);
      for (const n of rebuildSet) mats.set(n, undefined); // rebuilt posed: the identity
      return mats;
    };
    let poseAt;
    if (rigid) {
      shared = createCollisionWorld({ meshes, decl });
      const bounds = new Map();
      poseAt = (v) => ({ world: shared, mats: matsOf(motion.at(v)), bounds, release() {} });
    } else {
      const indexes = new Map();
      for (const [name, mesh] of meshes) { const ix = buildIndex(mesh); owned.push(ix); indexes.set(name, ix); }
      poseAt = (v) => {
        const q = motion.at(v);
        const { p, d } = resolveParams(part, q);
        const built = new Map();
        for (const n of rebuildSet) built.set(n, buildPosed(kernel, part, n, { purpose: "display", view, p, d }).toMesh());
        const world = createCollisionWorld({ meshes: built, indexes, decl });
        return { world, mats: matsOf(q), bounds: new Map(), release: () => world.dispose() };
      };
    }

    const row = emptyRow(s, { clear: true, rebuilds: !rigid });
    const contacts = [];
    const open = new Map(); // pairKey → its contact so far
    let best = null;
    let timedOut = false;
    // a reading becomes the minimum when it beats it by MIN_RES_MM, or is a contact nearer than it
    const offer = (r, v) => {
      if (!r || (best && r.distance > best.distance - MIN_RES_MM && !(r.distance <= clearance && r.distance < best.distance))) return;
      best = { distance: r.distance, a: r.a, b: r.b, at: r.at, value: v };
    };

    const pairAt = (pose, key, within) => pose.world.distances(pose.mats, { pairs: new Set([key]), within })[0] ?? null;
    const inContact = (v, a, b) => {
      const pose = poseAt(v);
      try { return pose.world.within(pose.mats, a, b, clearance); } finally { pose.release(); }
    };
    // Bisect between a clear value and a contact value of one pair → both sides, to tol.
    const bisect = (vClear, vContact, a, b) => {
      while (Math.abs(vContact - vClear) > tol) {
        const mid = (vClear + vContact) / 2;
        if (inContact(mid, a, b)) vContact = mid; else vClear = mid;
      }
      return { vClear, vContact };
    };
    const readAt = (v, key, within) => {
      const pose = poseAt(v);
      try { return pairAt(pose, key, within); } finally { pose.release(); }
    };
    const driverAt = (v, a, b) => (s.kind === "param" ? s.param : closingDriver(motion, matsOf, v, a, b, readAt(v, pairKey(a, b), Infinity), tol));
    // `unresolved`: advancement could not prove the pair clear over [from, to] at its floor
    // width; the contact is reported, and minClearance is capped at clearance there.
    const addContact = (a, b, from, to, before, after, atV = from, unresolved = false) => {
      const key = pairKey(a, b);
      const r = readAt(atV, key, Infinity);
      offer(r, atV);
      if (unresolved && (!best || best.distance > clearance)) best = { distance: clearance, a, b, at: r?.at ?? null, value: atV };
      const c = { from, to, a, b, at: r?.at ?? null, driver: driverAt(before ?? from, a, b), before, after, ...(unresolved ? { unresolved: true } : {}) };
      contacts.push(c);
      return c;
    };

    // Rigid path only: a pair whose relative placement has not changed since its last
    // reading reads what it read there, so it is skipped and its contact state carried.
    // Exact: its distance is unchanged, and it was already no nearer than the best so far.
    const lastR = new Map();
    const lastL = new Map(); // pairKey → a lower bound on its distance at the last step
    const stillPairs = (pose, cands) => {
      const still = new Set();
      if (!rigid || !skipStill) return still;
      for (const c of cands) {
        const R = mulMat4(invertRigid(pose.mats.get(c.a) ?? IDENTITY), pose.mats.get(c.b) ?? IDENTITY);
        const prev = lastR.get(c.key);
        if (prev && cornerTravel(pose.world.boundsOf(c.b), prev, R) <= STILL_MM) still.add(c.key);
        else lastR.set(c.key, R);
      }
      return still;
    };

    // One step's reading: one distances call at max(clearance, best − MIN_RES_MM), split
    // into the pairs in contact and the minimum; plus, per candidate pair, a lower bound on
    // its distance (exact when read, else past the cutoff or its box gap) for advancement.
    const measure = (v, pose) => {
      row.steps++;
      const cands = pose.world.candidates(pose.mats, { names: active });
      const skip = stillPairs(pose, cands);
      const w = Math.max(clearance, best ? best.distance - MIN_RES_MM : Infinity);
      const found = pose.world.distances(pose.mats, { names: active, within: w, bounds: pose.bounds, skip });
      offer(found[0], v);
      const exact = new Map(found.map((r) => [pairKey(r.a, r.b), r]));
      const L = new Map();
      for (const c of cands) {
        const r = exact.get(c.key);
        const lb = r ? r.distance : skip.has(c.key) ? (lastL.get(c.key) ?? Math.max(w, c.gap)) : Math.max(w, c.gap);
        L.set(c.key, lb);
        lastL.set(c.key, lb);
      }
      const touching = new Set(found.filter((r) => r.distance <= clearance).map((r) => pairKey(r.a, r.b)));
      return { v, pose, cands, L, touching, exact, skip, sides: new Map() };
    };

    // Tighten a side's lower bound to the pair's exact distance, when that is under `cut`
    // (else to just past it). A side already exact, or already past `cut`, is not re-read.
    const tighten = (side, key, cut) => {
      if (side.exact || side.lb > cut) return;
      const r = pairAt(side, key, cut);
      if (r) { offer(r, side.v); side.lb = r.distance; side.exact = true; } else side.lb = Math.max(side.lb, cut + 1e-9);
    };
    // Conservative advancement of one pair over [left, right], both clear: null when it is
    // proven clear across, else where it touches.
    const advance = (key, a, b, left, right) => {
      const { T, theta } = pairTravel(shared, a, b, left.mats, right.mats, clearance);
      const need = 2 * clearance + T;
      const bounded = theta <= MAX_TURN; // past it, sub-step before trusting the bound
      if (bounded && left.lb + right.lb > need) return null;
      tighten(left, key, need);
      tighten(right, key, need);
      if (bounded && left.lb + right.lb > need) return null;
      if (right.v - left.v <= tol * ADVANCE_FLOOR) return { unresolved: true, left: left.v, right: right.v };
      const v = (left.v + right.v) / 2;
      const mid = { v, mats: matsOf(motion.at(v)), world: shared, lb: 0, exact: false };
      tighten(mid, key, need);
      if (mid.lb <= clearance) return { contact: v, clearL: left.v, clearR: right.v };
      return advance(key, a, b, left, mid) ?? advance(key, a, b, mid, right);
    };
    const sideAt = (v) => ({ v, mats: matsOf(motion.at(v)), world: shared, lb: 0, exact: false });
    // Every contact of one pair inside [left, right] (both ends clear): advancement finds
    // the first, its ends are bisected, and the clear pieces bisection leaves on either side
    // are advanced in turn, so a second graze or a re-entry inside one step is found too.
    const scan = (key, a, b, left, right) => {
      for (let from = left; ;) {
        const g = advance(key, a, b, from, right);
        if (!g) return;
        if (g.unresolved) {
          addContact(a, b, g.left, g.right, g.left, g.right, g.left, true);
          if (g.right >= right.v) return;
          from = sideAt(g.right);
          continue;
        }
        const enter = bisect(g.clearL, g.contact, a, b);
        const exit = bisect(g.clearR, g.contact, a, b);
        if (enter.vClear > from.v) scan(key, a, b, from, sideAt(enter.vClear));
        addContact(a, b, enter.vContact, exit.vContact, enter.vClear, exit.vClear);
        if (exit.vClear >= right.v) return;
        from = sideAt(exit.vClear);
      }
    };
    const grazes = (prev, cur) => {
      for (const c of cur.cands) {
        if (open.has(c.key) || cur.touching.has(c.key)) continue; // only pairs clear at both ends
        // each step's side of a pair is kept, so what one step's advancement read there is
        // the next step's left side
        const left = prev.sides.get(c.key) ?? { v: prev.v, mats: prev.pose.mats, world: shared, lb: prev.L.get(c.key) ?? 0, exact: prev.exact.has(c.key) };
        const right = { v: cur.v, mats: cur.pose.mats, world: shared, lb: cur.L.get(c.key), exact: cur.exact.has(c.key) };
        cur.sides.set(c.key, right);
        scan(c.key, c.a, c.b, left, right);
      }
    };

    // Contact state changes between the previous step and this one.
    const transitions = (prev, cur) => {
      for (const key of cur.touching) {
        if (open.has(key)) continue;
        const r = cur.exact.get(key);
        if (!prev) { open.set(key, addContact(r.a, r.b, cur.v, hi, null, null)); continue; }
        const cut = bisect(prev.v, cur.v, r.a, r.b);
        // an earlier graze in the clear piece before the entry
        if (rigid && cut.vClear > prev.v) scan(key, r.a, r.b, prev.sides.get(key) ?? sideAt(prev.v), sideAt(cut.vClear));
        open.set(key, addContact(r.a, r.b, cut.vContact, hi, cut.vClear, null));
      }
      for (const [key, c] of open) {
        // a still pair was not re-read: its contact carries on
        if (cur.touching.has(key) || cur.skip.has(key)) continue;
        const cut = bisect(cur.v, prev.v, c.a, c.b);
        c.to = cut.vContact; c.after = cut.vClear;
        open.delete(key);
        // a re-entry in the clear piece after the exit
        if (rigid && cut.vClear < cur.v) {
          const right = { v: cur.v, mats: cur.pose.mats, world: shared, lb: cur.L.get(key) ?? 0, exact: cur.exact.has(key) };
          cur.sides.set(key, right);
          scan(key, c.a, c.b, sideAt(cut.vClear), right);
        }
      }
    };

    let last = null;
    if (rigid) {
      const maxTravel = clearance / 2 + SETTLE_STEP_MM;
      const minH = (hi - lo) / (Math.max(2, maxSteps) - 1);
      let v = lo, h = minH;
      last = measure(lo, poseAt(lo));
      transitions(null, last);
      while (v < hi) {
        if (now() > deadline) { timedOut = true; break; }
        h = Math.min(h * 2, hi - v);
        let next;
        for (;;) {
          const v2 = h >= hi - v ? hi : v + h;
          next = poseAt(v2);
          next.v = v2;
          const travel = shared.travel(last.pose.mats, next.mats, active);
          if (travel <= maxTravel) break;
          if (h <= minH) { row.capped = true; break; }
          h /= 2;
        }
        v = next.v;
        const cur = measure(v, next);
        grazes(last, cur);
        transitions(last, cur);
        last = cur;
      }
    } else {
      for (let i = 0; i < SWEEP_REBUILD_STEPS; i++) {
        if (now() > deadline) { timedOut = true; break; }
        const v = i === SWEEP_REBUILD_STEPS - 1 ? hi : lo + ((hi - lo) * i) / (SWEEP_REBUILD_STEPS - 1);
        const pose = poseAt(v);
        try {
          const cur = measure(v, pose);
          transitions(last, cur);
          last = { ...cur, pose: null }; // its world is released below
        } finally { pose.release(); }
      }
    }

    if (timedOut) for (const c of open.values()) c.to = last.v; // read up to here
    const merged = mergeContacts(contacts);
    const depthAt = (v, a, b) => {
      const pose = poseAt(v);
      try { return pose.world.depth(a, b, pose.mats); } finally { pose.release(); }
    };
    let out = merged;
    if (touching) {
      // each contact interval read along its length and split into stretches
      out = [];
      let deepest = null;
      for (const c of merged) {
        if (timedOut) { out.push({ ...c, depth: null, depthUnread: true }); continue; }
        const w = rigid
          ? walkDepth(c, { depthAt, allowance, tol, deadline, now, stepOk: (vl, vr, limit) => {
              const { T, theta } = pairTravel(shared, c.a, c.b, matsOf(motion.at(vl)), matsOf(motion.at(vr)), clearance);
              return T <= limit && theta <= MAX_TURN;
            } })
          : walkDepth(c, { depthAt, allowance, tol, deadline, now, grid: rebuildGrid(lo, hi) });
        if (w.deep && (!deepest || w.deep.depth > deepest.depth)) deepest = { ...w.deep, a: c.a, b: c.b };
        const pieceOf = (st) => {
          const piece = { ...c, from: st.from, to: st.to, before: st.before, after: st.after, depth: st.depth, allowed: !st.over };
          if (st.from !== c.from) {
            // a stretch that starts inside the interval: its own point and driver
            piece.at = readAt(st.from, pairKey(c.a, c.b), Infinity)?.at ?? c.at;
            piece.driver = driverAt(st.before ?? st.from, c.a, c.b);
          }
          return piece;
        };
        if (w.unread) {
          timedOut = true;
          // What was read before the clock stopped keeps its reading: a stretch proven past
          // the allowance is a contact that counts, whatever follows it. Only the rest of the
          // interval, from the last stretch read, is unread.
          const { partial } = w;
          if (!partial) { out.push({ ...c, depth: w.deep?.depth ?? null, depthUnread: true }); continue; }
          for (const st of w.stretches) out.push(pieceOf(st));
          // a stretch past the allowance counts as far as it was read; one within it says
          // nothing until it ends, so it joins the unread rest
          let rest = { from: partial.from, before: partial.before, depth: partial.depth };
          if (partial.over) {
            out.push(pieceOf(partial));
            rest = { from: partial.to, before: partial.to, depth: null };
          }
          const unread = { ...c, from: rest.from, before: rest.before, depth: rest.depth, depthUnread: true };
          if (rest.from !== c.from) unread.at = readAt(rest.from, pairKey(c.a, c.b), Infinity)?.at ?? c.at;
          out.push(unread);
          continue;
        }
        for (const st of w.stretches) out.push(pieceOf(st));
      }
      // pieces pressing in: the minimum is how deep, negated
      if (deepest && deepest.depth > TOUCH_TOL_MM) {
        best = { distance: -deepest.depth, a: deepest.a, b: deepest.b, at: readAt(deepest.value, pairKey(deepest.a, deepest.b), Infinity)?.at ?? null, value: deepest.value };
      }
    } else if (!timedOut) {
      // informational: never changes the row, so the clock stops it without a mark
      for (const c of merged) {
        const n = c.to > c.from ? DEPTH_SAMPLES : 1;
        let deep = -Infinity;
        for (let i = 0; i < n && deep !== null; i++) {
          if (now() > deadline) deep = null;
          else deep = Math.max(deep, depthAt(i === n - 1 ? c.to : c.from + ((c.to - c.from) * i) / (n - 1), c.a, c.b));
        }
        if (deep === null) break;
        c.depth = deep;
      }
    }
    row.minClearance = best;
    row.contacts = out.map(({ before: _b, after: _a, ...c }) => c);
    if (timedOut) return capContacts({ ...row, clear: null, skipped: "timeout" });
    const blocking = out.filter((c) => c.allowed !== true);
    row.clear = blocking.length === 0;
    if (s.kind === "param") row.freeRange = freeRange(blocking, Math.min(Math.max(full[s.param] ?? lo, lo), hi), lo, hi);
    return capContacts(row);
  } finally {
    shared?.dispose();
    disposeIndexes(owned);
    kernel.endSubPart?.();
  }
}

/**
 * `row` with at most SWEEP_MAX_CONTACTS contacts: every blocking one first (in order), then
 * the unread ones (each withholds the gate while nothing blocks), then the allowed ones, and
 * `contactsOmitted` the number left off. A row within the cap is returned as it is.
 */
export function capContacts(row) {
  const all = row.contacts ?? [];
  if (all.length <= SWEEP_MAX_CONTACTS) return row;
  const blocks = (c) => !c.depthUnread && sweepContactBlocks(row, c);
  const ranked = [...all.filter(blocks), ...all.filter((c) => !blocks(c) && c.depthUnread), ...all.filter((c) => !blocks(c) && !c.depthUnread)];
  return { ...row, contacts: ranked.slice(0, SWEEP_MAX_CONTACTS), contactsOmitted: all.length - SWEEP_MAX_CONTACTS };
}

/** The values a rebuild sweep checks at (its SWEEP_REBUILD_STEPS steps). */
function rebuildGrid(lo, hi) {
  return Array.from({ length: SWEEP_REBUILD_STEPS }, (_, i) => (i === SWEEP_REBUILD_STEPS - 1 ? hi : lo + ((hi - lo) * i) / (SWEEP_REBUILD_STEPS - 1)));
}

/**
 * Read contact `c`'s depth along [c.from, c.to] with `depthAt(v, a, b)` and split it into
 * stretches past `allowance` (`over`) and within it. Readings are spaced by
 * `stepOk(vl, vr, limit)` (true when the pair moves at most `limit` mm over the step;
 * halved until it is, down to a floor), or, given
 * `grid`, at the grid's values inside the interval. A crossing between two readings is
 * bisected to `tol`. Returns `{ stretches: [{ from, to, before, after, depth, over }],
 * deep: { depth, value } | null, unread, partial }`: `unread` when the deadline stopped it,
 * with `deep` the deepest reading so far, `stretches` the ones finished before it and
 * `partial` the one it stopped in, read from its `from` to its `to` (null when not even the
 * first reading was taken). `before`/`after` of the first and last stretch are the
 * contact's own; inside, the bisected value on the other side of each crossing.
 *
 * `limit` is DEPTH_STEP_MM, or, after a reading d past the allowance, d − allowance when
 * that is more: depth cannot fall by more than the pair moves, so no point of that step
 * can come back within the allowance unseen. A pair pressed deep along a whole swing (a
 * knuckle in the other plate) is then read in a few long steps, not one per 0.2 mm. Its
 * reported depth is the deepest READING, so there it can be short of the true deepest by
 * up to half a step's travel; whether it presses in is decided exactly as before.
 */
function walkDepth(c, { depthAt, allowance, tol, deadline, now, stepOk = null, grid = null }) {
  let deep = null;
  const read = (v) => {
    if (now() > deadline) return null;
    const d = depthAt(v, c.a, c.b);
    if (!deep || d > deep.depth) deep = { depth: d, value: v };
    return d;
  };
  const stretches = [];
  let d0 = read(c.from);
  if (d0 === null) return { stretches, deep, unread: true, partial: null };
  let cur = { from: c.from, to: c.from, before: c.before, after: undefined, depth: d0, over: d0 > allowance };
  // the next reading, and the crossing to it when its side differs from cur's
  const visit = (vPrev, v, d) => {
    if ((d > allowance) === cur.over) { cur.to = v; cur.depth = Math.max(cur.depth, d); return true; }
    let a = vPrev, b = v; // a on cur's side, b on the new side
    let newDepth = d;
    while (b - a > tol) {
      const mid = (a + b) / 2, dm = read(mid);
      if (dm === null) return false;
      if ((dm > allowance) === cur.over) { a = mid; cur.depth = Math.max(cur.depth, dm); } else { b = mid; newDepth = Math.max(newDepth, dm); }
    }
    cur.to = a; cur.after = b;
    stretches.push(cur);
    cur = { from: b, to: v, before: a, after: undefined, depth: newDepth, over: !cur.over };
    return true;
  };
  let v = c.from;
  if (grid) {
    for (const g of [...grid.filter((x) => x > c.from && x < c.to), c.to]) {
      if (g <= v) continue;
      const d = read(g);
      if (d === null || !visit(v, g, d)) return { stretches, deep, unread: true, partial: cur };
      v = g;
    }
  } else {
    const floor = tol * ADVANCE_FLOOR;
    let h = c.to - c.from, dLast = d0;
    while (v < c.to) {
      h = Math.min(h * 2, c.to - v);
      const limit = Math.max(DEPTH_STEP_MM, dLast - allowance);
      let v2;
      for (;;) {
        v2 = h >= c.to - v ? c.to : v + h;
        if (h <= floor || stepOk(v, v2, limit)) break;
        h /= 2;
      }
      const d = read(v2);
      if (d === null || !visit(v, v2, d)) return { stretches, deep, unread: true, partial: cur };
      v = v2; dLast = d;
    }
  }
  cur.to = c.to; cur.after = c.after;
  stretches.push(cur);
  return { stretches, deep, unread: false };
}

/**
 * Contacts by first value, a pair's pieces with no proven-clear gap between them joined into
 * one: a floor-width interval advancement could not prove clear, beside a real contact (a
 * graze leaving at a shallow angle reads so for a few floors past its bisected exit), is part
 * of that contact. A merged contact is `unresolved` only when every piece of it was.
 */
function mergeContacts(contacts) {
  const sorted = [...contacts].sort((x, y) => x.from - y.from);
  const out = [], lastOf = new Map();
  for (const c of sorted) {
    const key = pairKey(c.a, c.b), prev = lastOf.get(key);
    if (prev && (c.before ?? c.from) <= (prev.after ?? prev.to) + 1e-12) {
      if (c.to > prev.to) { prev.to = c.to; prev.after = c.after; }
      if (!c.unresolved) delete prev.unresolved;
      continue;
    }
    const copy = { ...c };
    out.push(copy);
    lastOf.set(key, copy);
  }
  return out;
}

/**
 * The contact-free interval around `v0`, from the clear side of each bisected contact end.
 * `v0` is the param's current value clamped into the sweep's range, so a current value
 * outside it reads the interval at the nearer end.
 */
function freeRange(contacts, v0, lo, hi) {
  let a = lo, b = hi;
  for (const c of contacts) {
    if (c.from <= v0 && v0 <= c.to) return null;
    if (c.to < v0) a = Math.max(a, c.after ?? c.to);
    if (c.from > v0) b = Math.min(b, c.before ?? c.from);
  }
  return [a, b];
}

/**
 * The param with the largest share of the pair's closing speed at `v`: each moving param
 * nudged at its own rate along the motion, the separation n·(M_a p_a − M_b p_b) read from
 * placement matrices alone. Null when the pair has no separating normal there (overlap).
 */
function closingDriver(motion, matsOf, v, a, b, r, tol) {
  if (!r?.normal) return null;
  const q0 = motion.at(v);
  const m0 = matsOf(q0);
  const ma = m0.get(a) ?? IDENTITY, mb = m0.get(b) ?? IDENTITY;
  const pa = applyMat(invertRigid(ma), r.pointA), pb = applyMat(invertRigid(mb), r.pointB);
  const sep = (mats) => {
    const A = applyMat(mats.get(a) ?? IDENTITY, pa), B = applyMat(mats.get(b) ?? IDENTITY, pb);
    return r.normal[0] * (A[0] - B[0]) + r.normal[1] * (A[1] - B[1]) + r.normal[2] * (A[2] - B[2]);
  };
  const s0 = sep(m0);
  const qa = motion.at(Math.max(motion.lo, v - tol)), qb = motion.at(Math.min(motion.hi, v + tol));
  const dv = (Math.min(motion.hi, v + tol) - Math.max(motion.lo, v - tol)) || 1;
  let driver = null, bestClose = -Infinity;
  for (const k of Object.keys(q0)) {
    if (!isNum(qa[k]) || !isNum(qb[k])) continue;
    const rate = (qb[k] - qa[k]) / dv;
    if (rate === 0) continue;
    let close;
    try { close = -(sep(matsOf({ ...q0, [k]: q0[k] + rate * tol })) - s0); } catch { continue; }
    if (close > bestClose) { bestClose = close; driver = k; }
  }
  return driver;
}
