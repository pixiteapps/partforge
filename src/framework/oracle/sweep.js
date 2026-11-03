// Sweeps: a declared motion stepped end to end, checked for contact all the way along it
// (spec 2026-11-02-collisions-design.md, "Sweeps"). A sweep is a parameter over its range,
// a handle (one parameter sweep per DOF), a path between presets or waypoints, or an
// animation's timeline. Every motion is read as one value v running from `lo` to `hi`:
// the parameter's own value, or t ∈ [0, 1] for a path or an animation.
//
// Two paths. RIGID (only place() changes along the motion): each in-view sub-part is built
// once, posed at the start, and moved by relative matrices (relativeMatsAt), with steps
// halved until no moving point travels more than (clearance + COLLIDE_BAND_MM) / 2 between
// checks. REBUILD (some sub-part's build changes, or its placement is untrusted): those
// sub-parts are rebuilt per step, on SWEEP_REBUILD_STEPS evenly spaced steps.
//
// A pair counts as in contact at distance <= the sweep's clearance. A pair inside it at the
// sweep's start is a contact from the start, never exempt: a sweep asks "never closer than
// this anywhere", unlike a drag, which only refuses to push further in.
//
// Shared runtime: DOM-free, three-free and node:-free, loaded lazily by the worker. The
// caller owns the kernel round: built solids stay live until its kernel.cleanup().
import { buildView } from "./build.js";
import { viewSubParts, resolveParams, buildPosed } from "../part-model.js";
import { probePoses } from "../pose-probe.js";
import { viewAnimations, evaluate } from "../animation.js";
import { createCollisionWorld, poseMatrices, relativeMatsAt, buildIndex, disposeIndexes, IDENTITY } from "../collide/world.js";
import { normalizeCollisions } from "../collide/declaration.js";
import { COLLIDE_BAND_MM } from "../collide/guard.js";
import { CONTACT_EPS, pairKey } from "../collide/pairs.js";
import { applyMat, cornerTravel } from "../collide/motion.js";
import { invertRigid, mulMat4 } from "../geometry/pose.js";
import { rangesOf, dofsOf } from "../pose/param-solve.js";
import { handleKind } from "../pose/handle-source.js";
import { desugar } from "../panel/legacy.js";

export const SWEEP_REBUILD_STEPS = 24;
export const SWEEP_MAX_STEPS = 2000;

// The motion is sampled at this many intervals (plus a path's waypoints) to tell what it
// moves: comparing the two ends alone would drop a full turn, whose ends place alike.
const MOTION_SAMPLES = 16;
const BISECT_TOL = 1e-3; // a contact's ends, as a share of the range
const STILL_MM = 1e-9;
// minClearance chases a nearer pair only when it is nearer by this much (mm): the reading is
// within it of the sampled minimum. Chasing every hundredth of a micron re-measured each pin
// pair's wobble exactly at every step, two thirds of a hand sweep's time.
const MIN_RES_MM = 0.01;   // a pair whose relative placement moved no more than this has not moved
const sameMat = (a, b) => a === b || (!!a && !!b && a.every((v, i) => Math.abs(v - b[i]) <= 1e-9));
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const clockNow = () => globalThis.performance?.now?.() ?? Date.now();

/** Preset name → overrides, from the desugared schema (oracle/cases.js's walk). */
function presetMap(part) {
  const map = {};
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (n.kind === "preset") for (const [name, o] of Object.entries(n.presets ?? {})) map[name] ??= o;
      if (n.kind === "group") walk(n.children);
    }
  };
  walk(desugar(part.parameters ?? []));
  return map;
}

/** Waypoints blended linearly over t ∈ [0, 1]; a value that is not a number on both sides holds. */
function pathAt(waypoints) {
  const n = waypoints.length - 1;
  return (t) => {
    const s = Math.min(Math.max(t, 0), 1) * n;
    const i = Math.min(Math.floor(s), n - 1), u = s - i;
    const a = waypoints[i], b = waypoints[i + 1], out = { ...a };
    for (const k of Object.keys(b)) {
      if (isNum(a[k]) && isNum(b[k])) out[k] = a[k] + (b[k] - a[k]) * u;
      else if (u >= 1) out[k] = b[k];
    }
    return out;
  };
}

/** The motion as `{ lo, hi, at(v) → params }`, or null when its target cannot be read. */
function motionOf(part, view, full, s) {
  if (s.kind === "param") return { lo: s.range[0], hi: s.range[1], at: (v) => ({ ...full, [s.param]: v }) };
  if (s.kind === "path") return { lo: 0, hi: 1, at: pathAt(s.waypoints.map((w) => ({ ...full, ...w }))) };
  const anim = (viewAnimations(part).get(view) ?? []).find((a) => a.name === s.animation);
  return { lo: 0, hi: 1, at: (t) => ({ ...full, ...evaluate(anim, t).values }) };
}

/**
 * What a motion moves in `view`: `moving` (sub-parts whose placement changes, rigidly) and
 * `rebuild` (sub-parts whose build-scope probe hash changes, whose build or place is
 * untrusted at some sample). Throws when a sample cannot be resolved.
 */
function scanMotion(part, view, motion, extra = []) {
  const ts = [...Array.from({ length: MOTION_SAMPLES + 1 }, (_, i) => i / MOTION_SAMPLES), ...extra];
  const vs = ts.map((t) => motion.lo + (motion.hi - motion.lo) * t);
  let names = null, mats0 = null, hash0 = null;
  const moving = new Set(), rebuild = new Set();
  for (const v of vs) {
    const q = motion.at(v);
    const { p, d } = resolveParams(part, q);
    const mats = poseMatrices(part, view, p, d);
    const hashes = probePoses(part, view, q, { scope: "build" });
    if (!names) { names = viewSubParts(part, view, p); mats0 = mats; hash0 = hashes; }
    for (const name of names) {
      const m = mats.get(name), h = hashes.get(name);
      if (m === null || m === undefined || !h?.trusted || h.baseHash !== hash0.get(name)?.baseHash) rebuild.add(name);
      else if (!sameMat(m, mats0.get(name))) moving.add(name);
    }
  }
  return { moving: names.filter((n) => moving.has(n) && !rebuild.has(n)), rebuild: names.filter((n) => rebuild.has(n)) };
}

/**
 * The sweeps `part.verify.sweeps` declares for `view`, at `params`. A handle expands to one
 * param sweep per DOF ("<name>.<param>"); a goal handle yields none. A sweep whose target
 * cannot be read keeps `skip: "unreadable"`, a zero-length animation `skip: "no-motion"`;
 * a sweep that moves nothing in this view, or whose `views` leave it out, is dropped.
 */
export function normalizeSweeps(part, view, params = {}) {
  const decl = part?.verify?.sweeps;
  if (!decl || typeof decl !== "object" || Array.isArray(decl)) return [];
  const full = { ...part.defaults, ...params };
  const declClear = normalizeCollisions(part)?.clearance ?? CONTACT_EPS;
  const ranges = rangesOf(part);
  const out = [];
  for (const [name, spec] of Object.entries(decl)) {
    if (!spec || typeof spec !== "object") { out.push({ name, kind: null, skip: "unreadable", clearance: declClear, views: null }); continue; }
    const views = Array.isArray(spec.views) ? spec.views : null;
    if (views && !views.includes(view)) continue;
    const clearance = isNum(spec.clearance) && spec.clearance >= 0 ? spec.clearance : declClear;
    const base = { clearance, views };
    const unreadable = (kind) => out.push({ name, kind, ...base, skip: "unreadable" });
    const paramSweep = (sweepName, key, range) => {
      const r = ranges.get(key);
      const span = range ?? (r ? [r.min, r.max] : null);
      if (!Array.isArray(span) || !isNum(span[0]) || !isNum(span[1]) || !(span[1] > span[0])) return { name: sweepName, kind: "param", param: key, ...base, skip: "unreadable" };
      return { name: sweepName, kind: "param", param: key, range: [span[0], span[1]], ...base };
    };
    let entries;
    if (typeof spec.param === "string") {
      entries = [paramSweep(name, spec.param, spec.range)];
    } else if (typeof spec.handle === "string") {
      const handle = part.handles?.[spec.handle];
      if (!handle || typeof handle !== "object") { unreadable("param"); continue; }
      let d;
      try { d = resolveParams(part, full).d; } catch { unreadable("param"); continue; }
      if (handle.drag === "goal" || handleKind(handle, d) === null) continue; // a target, not a motion
      entries = dofsOf(handle, Object.values(part.handles), full).map((k) => paramSweep(`${name}.${k}`, k, spec.range));
    } else if (typeof spec.from === "string" || typeof spec.to === "string" || Array.isArray(spec.path)) {
      let waypoints;
      if (Array.isArray(spec.path)) waypoints = spec.path;
      else {
        const presets = presetMap(part);
        waypoints = [presets[spec.from], presets[spec.to]];
      }
      if (waypoints.length < 2 || !waypoints.every((w) => w && typeof w === "object" && !Array.isArray(w))) { unreadable("path"); continue; }
      entries = [{ name, kind: "path", waypoints, ...base }];
    } else if (typeof spec.animation === "string") {
      const anims = viewAnimations(part);
      const anim = (anims.get(view) ?? []).find((a) => a.name === spec.animation);
      if (!anim) {
        if (![...anims.values()].some((list) => list.some((a) => a.name === spec.animation))) unreadable("animation");
        continue; // declared in another view: nothing it moves is here
      }
      const duration = anim.steps.reduce((s, st) => s + (isNum(st.duration) ? st.duration : 0), 0);
      if (!(duration > 0)) { out.push({ name, kind: "animation", animation: spec.animation, ...base, skip: "no-motion" }); continue; }
      entries = [{ name, kind: "animation", animation: spec.animation, ...base }];
    } else { unreadable(null); continue; }
    for (const s of entries) {
      if (s.skip) { out.push(s); continue; }
      let scan;
      try {
        const extra = s.kind === "path" ? s.waypoints.map((_, i) => i / (s.waypoints.length - 1)) : [];
        scan = scanMotion(part, view, motionOf(part, view, full, s), extra);
      } catch { out.push({ ...s, skip: "unreadable" }); continue; }
      if (!scan.moving.length && !scan.rebuild.length) continue; // nothing moves in this view
      out.push({ ...s, moving: scan.moving, rebuild: scan.rebuild });
    }
  }
  return out;
}

const emptyRow = (s, extra) => ({
  name: s.name, clear: null, clearance: s.clearance, steps: 0, rebuilds: !!s.rebuild?.length,
  minClearance: null, contacts: [], freeRange: null, ms: 0, ...extra,
});

/**
 * Run every sweep `normalizeSweeps` gives for `view` at `params`, with `kernel` (the
 * oracle's build kernel). `deadline` is an absolute `now()` reading: a sweep it stops is
 * `skipped: "timeout"`, with what it read so far. A skipped row's `clear` is null.
 */
export function runSweeps(kernel, part, view, params = {}, { deadline = Infinity, now = clockNow } = {}) {
  const rows = [];
  const full = { ...part.defaults, ...params };
  const decl = normalizeCollisions(part);
  for (const s of normalizeSweeps(part, view, params)) {
    if (s.skip) { rows.push(emptyRow(s, { skipped: s.skip })); continue; }
    if (now() > deadline) { rows.push(emptyRow(s, { skipped: "timeout" })); continue; }
    const t0 = now();
    const row = sweepOne(kernel, part, view, full, decl, s, { deadline, now });
    row.ms = now() - t0;
    rows.push(row);
  }
  return rows;
}

function sweepOne(kernel, part, view, full, decl, s, { deadline, now }) {
  const motion = motionOf(part, view, full, s);
  const { lo, hi } = motion;
  const tol = BISECT_TOL * (hi - lo);
  const clearance = s.clearance;
  const rebuildSet = new Set(s.rebuild);
  const active = [...s.moving, ...s.rebuild];
  const owned = [];   // indexes this sweep built
  let shared = null;  // the rigid path's one world
  kernel.beginSubPart?.(`oracle:sweep:${view}`);
  try {
    const start = resolveParams(part, motion.at(lo));
    const built = buildView(kernel, part, view, motion.at(lo));
    const relMats = relativeMatsAt(part, view, start.p, start.d);
    const matsOf = (q) => {
      const { p, d } = resolveParams(part, q);
      const mats = relMats(p, d);
      for (const n of rebuildSet) mats.set(n, undefined); // rebuilt posed: the identity
      return mats;
    };
    let poseAt;
    if (!rebuildSet.size) {
      shared = createCollisionWorld({ meshes: new Map(built.map((b) => [b.name, b.mesh])), decl });
      const bounds = new Map();
      poseAt = (v) => ({ world: shared, mats: matsOf(motion.at(v)), bounds, release() {} });
    } else {
      const indexes = new Map();
      for (const b of built) if (!rebuildSet.has(b.name)) { const ix = buildIndex(b.mesh); owned.push(ix); indexes.set(b.name, ix); }
      poseAt = (v) => {
        const q = motion.at(v);
        const { p, d } = resolveParams(part, q);
        const meshes = new Map();
        for (const n of rebuildSet) meshes.set(n, buildPosed(kernel, part, n, { purpose: "display", view, p, d }).toMesh());
        const world = createCollisionWorld({ meshes, indexes, decl });
        return { world, mats: matsOf(q), bounds: new Map(), release: () => world.dispose() };
      };
    }

    const nearest = (pose, keys, within) => pose.world.distances(pose.mats, { pairs: new Set(keys), within })[0] ?? null;
    const inContact = (v, key, a, b) => {
      const pose = poseAt(v);
      try { return pose.world.within(pose.mats, a, b, clearance); } finally { pose.release(); }
    };
    // Bisect between a clear value and a contact value of one pair → both sides, to tol.
    const bisect = (vClear, vContact, key, a, b) => {
      while (Math.abs(vContact - vClear) > tol) {
        const mid = (vClear + vContact) / 2;
        if (inContact(mid, key, a, b)) vContact = mid; else vClear = mid;
      }
      return { vClear, vContact };
    };
    const readAt = (v, key, within) => {
      const pose = poseAt(v);
      try { return nearest(pose, [key], within); } finally { pose.release(); }
    };
    const driverAt = (v, a, b) => (s.kind === "param" ? s.param : closingDriver(part, view, motion, matsOf, v, a, b, readAt(v, pairKey(a, b), Infinity), tol));

    const row = emptyRow(s, { clear: true, rebuilds: rebuildSet.size > 0 });
    const contacts = [];
    const open = new Map(); // pairKey → its contact so far
    let best = null;
    let prevV = null;
    let timedOut = false;

    // Rigid path only: a pair whose relative placement has not changed since the last step
    // reads what it read there, so it is skipped and its contact state carried. Exact: its
    // distance is unchanged, and it was already no nearer than the best so far.
    const lastR = new Map();
    const stillPairs = (pose) => {
      if (rebuildSet.size) return null;
      const still = new Set();
      for (const c of pose.world.candidates(pose.mats, { names: active })) {
        const R = mulMat4(invertRigid(pose.mats.get(c.a) ?? IDENTITY), pose.mats.get(c.b) ?? IDENTITY);
        const prev = lastR.get(c.key);
        if (prev && cornerTravel(pose.world.boundsOf(c.b), prev, R) <= STILL_MM) still.add(c.key);
        else lastR.set(c.key, R);
      }
      return still;
    };

    const visit = (v, pose) => {
      row.steps++;
      const skip = stillPairs(pose);
      const touching = pose.world.distances(pose.mats, { names: active, within: clearance, bounds: pose.bounds, skip });
      const m = pose.world.distances(pose.mats, { names: active, within: best ? best.distance - MIN_RES_MM : Infinity, limit: 1, bounds: pose.bounds, skip })[0];
      if (m && (!best || m.distance < best.distance)) best = { distance: m.distance, a: m.a, b: m.b, at: m.at, value: v };
      const seen = new Set();
      for (const key of skip ?? []) if (open.has(key)) seen.add(key);
      for (const r of touching) {
        const key = pairKey(r.a, r.b);
        seen.add(key);
        if (open.has(key)) continue;
        let from = v, before = null, at = r.at;
        if (prevV !== null) {
          const cut = bisect(prevV, v, key, r.a, r.b);
          from = cut.vContact; before = cut.vClear;
          at = readAt(from, key, clearance)?.at ?? at;
        }
        const c = { from, to: hi, a: r.a, b: r.b, at, driver: driverAt(before ?? from, r.a, r.b), before, after: null };
        open.set(key, c);
        contacts.push(c);
      }
      for (const [key, c] of open) {
        if (seen.has(key)) continue;
        const cut = bisect(v, prevV, key, c.a, c.b);
        c.to = cut.vContact; c.after = cut.vClear;
        open.delete(key);
      }
      prevV = v;
    };

    if (!rebuildSet.size) {
      const maxTravel = (clearance + COLLIDE_BAND_MM) / 2;
      const minH = (hi - lo) / (SWEEP_MAX_STEPS - 1);
      let v = lo, pose = poseAt(lo), h = minH;
      visit(v, pose);
      while (v < hi) {
        if (now() > deadline) { timedOut = true; break; }
        h = Math.min(h * 2, hi - v);
        let next;
        for (;;) {
          const v2 = h >= hi - v ? hi : v + h;
          next = poseAt(v2);
          next.v = v2;
          if (h <= minH || shared.travel(pose.mats, next.mats, active) <= maxTravel) break;
          h /= 2;
        }
        v = next.v; pose = next;
        visit(v, pose);
      }
    } else {
      for (let i = 0; i < SWEEP_REBUILD_STEPS; i++) {
        if (now() > deadline) { timedOut = true; break; }
        const v = i === SWEEP_REBUILD_STEPS - 1 ? hi : lo + ((hi - lo) * i) / (SWEEP_REBUILD_STEPS - 1);
        const pose = poseAt(v);
        try { visit(v, pose); } finally { pose.release(); }
      }
    }

    if (timedOut) for (const c of open.values()) c.to = prevV; // read up to here
    row.minClearance = best;
    row.contacts = contacts.map(({ before: _b, after: _a, ...c }) => c);
    if (timedOut) return { ...row, clear: null, skipped: "timeout" };
    row.clear = contacts.length === 0;
    if (s.kind === "param") row.freeRange = freeRange(contacts, Math.min(Math.max(full[s.param] ?? lo, lo), hi), lo, hi);
    return row;
  } finally {
    shared?.dispose();
    disposeIndexes(owned);
    kernel.endSubPart?.();
  }
}

/** The contact-free interval around `v0`, from the clear side of each bisected contact end. */
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
function closingDriver(part, view, motion, matsOf, v, a, b, r, tol) {
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
