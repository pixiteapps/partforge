// The drag guard: what keeps a dragged piece from passing through another in Pose mode.
// settle walks from the last clear params to the solved ones in sub-steps no longer than
// SETTLE_STEP_MM of travel, and bisects back to contact at the first step that is not clear
// (the hard guarantee); then (COLLIDE_SLIDE) it slides the rest of the move along the
// contact, every slide step walked and checked the same way. Which pairs a drag may leave
// touching is exemptions.js.
// Part-agnostic: the caller hands in matsAt(params) → Map (world.js's mats contract) and
// the names that can move. Pure, like the world it reads.
import { pairKey, CONTACT_EPS } from "./pairs.js";
import { invertRigid } from "../geometry/pose.js";
import { applyMat } from "./motion.js";
import { createExemptions } from "./exemptions.js";

export const SETTLE_STEP_MM = 1;      // the most a moving point travels between two checks
export const MAX_SUBSTEPS = 32;       // settle's sub-steps per frame; a flick past it lags
export const SETTLE_BISECTIONS = 12;  // 1 mm step → ~0.25 µm of contact
// true: a settle that stops at contact slides the rest of the move along the contact
// instead (slideStep): each pair in contact is read once at the stop — its closest points
// and normal, held in each mesh's own frame — and its gap linearised in the moving params
// by finite differences on placements alone (no BVH). The remaining step is projected off
// every contact it would close, onto "gap >= SLIDE_SKIN_MM", in step-relative units (each
// param scaled by its own remaining change), and walked and checked like any step. The skin
// is what lets a slide move: a piece resting exactly at contact meets a curved neighbour
// again on the first sub-step of any tangent move, so the projection also lifts it a hair
// off. Up to SLIDE_ROUNDS projections a frame (a slide that meets a second contact).
// A gap check is most of a blocked frame's cost (~0.8 ms each on the hand), so a sliding
// settle bisects less: SLIDE_BISECTIONS (a sub-step is at most SETTLE_STEP_MM, so ~16 µm).
export const COLLIDE_SLIDE = true;
export const SLIDE_BISECTIONS = 6;
export const SLIDE_SKIN_MM = 0.05;
export const SLIDE_ROUNDS = 2;
const SLIDE_WITHIN_MM = 0.25; // pairs this close at the stop are its contacts
const SLIDE_FD = 1e-3;        // finite-difference step, as a share of a param's remaining change
// How far a slide may move a pinned point before settle undoes it (mm, settle's `pinDrift`):
// the slide works outside the solver, where a pin is not held, so one that moves a pinned
// point past the solver's own pin residual (well under what reads as letting go) stops dead.
export const PIN_SLIDE_MM = 0.5;
const sub = (x, y) => [x[0] - y[0], x[1] - y[1], x[2] - y[2]];
const reached = (at, end) => Object.keys(end).every((k) => typeof end[k] !== "number" || Math.abs(end[k] - at[k]) <= 1e-9 * (1 + Math.abs(end[k])));

const apply = applyMat; // undefined = identity (the mats contract)

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

// matsAt with its last few answers kept: a frame asks for the same params' placements
// several times over (the travel's end and the last sub-step, a slide from where a walk
// stopped). Keyed by params content, as derive's memo is.
const MATS_MEMO = 6;
const sameParams = (a, b) => {
  if (a === b) return true;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!Object.hasOwn(b, k) || !Object.is(a[k], b[k])) return false;
  return true;
};
function memoMats(matsAt) {
  const memo = []; // { params, mats }, newest first
  return (params) => {
    for (const e of memo) if (sameParams(e.params, params)) return e.mats;
    const mats = matsAt(params);
    // the key is a snapshot: a caller that edits its params object later cannot alias it
    memo.unshift({ params: { ...params }, mats });
    if (memo.length > MATS_MEMO) memo.length = MATS_MEMO;
    return mats;
  };
}

export function createDragGuard({ world, matsAt: rawMatsAt, start, moving, clearance = CONTACT_EPS }) {
  const matsAt = memoMats(rawMatsAt);
  const exempt = createExemptions({ world, startMats: matsAt(start), moving, clearance });

  return {
    isClear: (params) => exempt.check(matsAt(params)).clear,

    /**
     * Walk from `from` toward `to` (along `blend`), stopping at contact and, with
     * COLLIDE_SLIDE, sliding the rest of the move along it. `pinDrift(params) → mm`, when
     * given, vetoes a slide: one whose result it reads past PIN_SLIDE_MM is discarded and
     * the move re-walked stop-dead from `from`. Transactional: a discarded attempt's
     * exemption changes are rolled back, so the re-walk sees the exemptions `from` had.
     * Returns { params, blocked, contacts? } (contacts: the normals at the stop, facing
     * the side that moved, whether or not it slid).
     */
    settle(from, to, { blend = linearBlend(from, to), pinDrift } = {}) {
      if (!COLLIDE_SLIDE) return stopDead(from, blend);
      const saved = exempt.snapshot();
      const s = slide(from, blend);
      if (!s.contacts || !pinDrift || !(pinDrift(s.params) > PIN_SLIDE_MM)) return s;
      exempt.restore(saved);
      return stopDead(from, blend);
    },
  };

  /** Stop at contact; still report the normals, so a caller can slide its own target along them. */
  function stopDead(from, blend) {
    const first = walk(from, blend, SETTLE_BISECTIONS);
    if (!first.blocked) return first;
    const mats = matsAt(first.params), contacts = readContacts(mats);
    // judged on the whole intended move (blend(1)), not the part walked: the side that moved more
    return contacts.length ? { ...first, contacts: facing(contacts, mats, blend(1)) } : first;
  }

  function slide(from, blend) {
    const first = walk(from, blend, SLIDE_BISECTIONS);
    if (!first.blocked) return first;
    let at = first.params, blocked = first.blocked, contacts;
    const end = blend(1);
    for (let round = 0; round < SLIDE_ROUNDS && blocked; round++) {
      const step = slideStep(at, end);
      if (!step) break;
      const { target } = step;
      contacts ??= step.contacts;
      const r = walk(at, linearBlend(at, target), SLIDE_BISECTIONS);
      at = r.params;
      blocked = r.blocked ?? (reached(at, end) ? null : blocked);
      if (!r.blocked) break;
    }
    return contacts ? { params: at, blocked, contacts } : { params: at, blocked };
  }

  /** The non-exempt pairs within SLIDE_WITHIN_MM at mats: closest points in mesh frames, normal. */
  function readContacts(mats) {
    const contacts = [];
    for (const r of world.distances(mats, { names: moving, within: clearance + SLIDE_WITHIN_MM })) {
      if (exempt.has(pairKey(r.a, r.b)) || !r.normal) continue;
      const ma = mats.get(r.a), mb = mats.get(r.b);
      contacts.push({
        a: r.a, b: r.b, n: r.normal, gap: r.distance,
        pa: apply(ma ? invertRigid(ma) : undefined, r.pointA), pb: apply(mb ? invertRigid(mb) : undefined, r.pointB),
      });
    }
    return contacts;
  }
  // Each contact's surface normal in world space, facing the side the step moved more —
  // the dragged side: a drag target pushed along −normal is pushed into the surface.
  function facing(contacts, mats, end) {
    const endMats = matsAt(end);
    return contacts.map((c) => {
      const moveA = Math.hypot(...sub(apply(endMats.get(c.a), c.pa), apply(mats.get(c.a), c.pa)));
      const moveB = Math.hypot(...sub(apply(endMats.get(c.b), c.pb), apply(mats.get(c.b), c.pb)));
      const toward = moveA >= moveB ? c.a : c.b;
      return { a: c.a, b: c.b, normal: toward === c.a ? [...c.n] : c.n.map((x) => -x), moving: toward };
    });
  }

  /**
   * Where the rest of a blocked move can go: `at` plus the remaining step (`end` − `at`, its
   * numeric keys) projected off the contacts at `at`, or null (no move, or no contact to
   * slide along). Each contact's gap is linear in the params here: n · (A(p)·pa − B(p)·pb),
   * its closest points held in their meshes' frames and its normal fixed.
   * The finite differences nudge each param by SLIDE_FD of its own remaining change; a param
   * that derive re-solves (a goal drag's seeds) may not answer smoothly there, and then the
   * projection is off and the walk's own check refuses the slide: safe, just stuck.
   */
  function slideStep(at, end) {
    const keys = Object.keys(end).filter((k) => typeof at[k] === "number" && typeof end[k] === "number" && end[k] !== at[k]);
    if (!keys.length) return null;
    const mats = matsAt(at);
    const contacts = readContacts(mats);
    if (!contacts.length) return null;
    const gapAt = (m, c) => {
      const wa = apply(m.get(c.a), c.pa), wb = apply(m.get(c.b), c.pb);
      return c.n[0] * (wa[0] - wb[0]) + c.n[1] * (wa[1] - wb[1]) + c.n[2] * (wa[2] - wb[2]);
    };
    // each contact's gradient in step-relative units: d gap / d u_k, u_k = Δp_k / step_k
    const step = keys.map((k) => end[k] - at[k]);
    const base = contacts.map((c) => gapAt(mats, c));
    const grads = contacts.map(() => new Float64Array(keys.length));
    keys.forEach((k, j) => {
      const h = SLIDE_FD * step[j];
      const m = matsAt({ ...at, [k]: at[k] + h });
      contacts.forEach((c, i) => { grads[i][j] = (gapAt(m, c) - base[i]) / SLIDE_FD; });
    });
    // u = 1 is the whole remaining step: project it onto every gap >= skin, a few passes
    const u = new Float64Array(keys.length).fill(1);
    for (let pass = 0; pass < 8; pass++) {
      let moved = false;
      contacts.forEach((c, i) => {
        const g = grads[i];
        let dot = 0, nn = 0;
        for (let j = 0; j < g.length; j++) { dot += g[j] * u[j]; nn += g[j] * g[j]; }
        const short = clearance + SLIDE_SKIN_MM - (c.gap + dot);
        if (short <= 1e-9 || nn < 1e-18) return;
        for (let j = 0; j < g.length; j++) u[j] += (short * g[j]) / nn;
        moved = true;
      });
      if (!moved) break;
    }
    const target = { ...end };
    keys.forEach((k, j) => { target[k] = at[k] + u[j] * step[j]; });
    return { target, contacts: facing(contacts, mats, end) };
  }

  function walk(from, blend, bisections) {
    let t0 = 0, p0 = from, m0 = matsAt(from);
    const total = world.travel(m0, matsAt(blend(1)), moving); // whole: the last sub-step reuses it
    let dt = total > 0 ? Math.min(1, (0.9 * SETTLE_STEP_MM) / total) : 1;
    for (let steps = 0; t0 < 1 && steps < MAX_SUBSTEPS; steps++) {
      // A step no longer than SETTLE_STEP_MM of travel: shrink by the secant until it fits
      // (a chord underestimates an arc, so the first guess can be long).
      // A blend that jumps (a goal blend re-solves) may never fit: then lag at the last
      // clear step rather than check a step long enough to tunnel.
      let t1, p1, m1, trv;
      for (let tries = 0; ; tries++) {
        t1 = Math.min(1, t0 + dt); p1 = blend(t1); m1 = matsAt(p1);
        trv = world.travel(m0, m1, moving);
        if (trv <= SETTLE_STEP_MM) break;
        if (tries === 8) return { params: p0, blocked: null };
        dt = (t1 - t0) * Math.max(0.1, (0.9 * SETTLE_STEP_MM) / trv);
      }
      const c = exempt.check(m1);
      if (!c.clear) {
        let lo = t0, loP = p0, hi = t1, blocked = c.blocked;
        for (let i = 0; i < bisections; i++) {
          const mid = (lo + hi) / 2, pm = blend(mid), cm = exempt.check(matsAt(pm));
          if (cm.clear) { exempt.accept(cm); lo = mid; loP = pm; } else { hi = mid; blocked = cm.blocked; }
        }
        return { params: loP, blocked };
      }
      exempt.accept(c);
      const took = t1 - t0;
      t0 = t1; p0 = p1; m0 = m1;
      dt = trv > 0 ? took * Math.min(2, (0.9 * SETTLE_STEP_MM) / trv) : Math.min(1, took * 2);
    }
    return { params: p0, blocked: null };
  }
}
