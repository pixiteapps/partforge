// Which params pose one piece against another (motion params), and which of them a
// declared `verify.sweeps` entry moves (spec 2026-11-12-moving-fits-swept-design.md, A).
// Lint's motion-unswept warning and verify's sweepCoverage check both read motions
// through this one module, so the two name the same params with the same hint. A goal
// handle's target and seed are never motions (unmovableParams): the solver poses the limb.
//
// A BVH-free leaf, like sweep-targets.js, whose probing it reuses: geometry-free probes and
// the placement rule only, never the collision world, the native core or oracle/, so the
// lint closure and the worker's eager closure may load it (test/worker-layering.test.js).
// No sweep is ever run here. Nothing here throws on a malformed part: a param whose motion
// cannot be probed is skipped.
//
// A part object is treated as immutable between calls: the view scan is memoized per part
// object (scanViews), keyed on the params, the budget and the identity of `parameters`,
// `parts`, `views`, `handles` and `derive`. Replacing one of those rescans; mutating one
// in place does not.
//
// A build the probe cannot TRUST (it queried its solid, or passed a function) is judged by
// what it READS, per sub-part (collide/untrusted-reads.js, the rule the engine's own
// scanMotion uses, so a motion found here is swept rigidly): one that never reads the param
// cannot rebuild when it moves; one that throws, runs away, or reads it, rebuilds.
import { exportSubParts, resolveParams } from "../part-model.js";
import { probePoses } from "../pose-probe.js";
import { viewAnimations } from "../animation.js";
import { invertRigid, mulMat4 } from "../geometry/pose.js";
import { rangesOf } from "../pose/param-solve.js";
import { controlNodes } from "../panel/model.js";
import { desugar } from "../panel/legacy.js";
import { handleParamKeys } from "../pose/handle-source.js";
import { controlBoundKeys } from "../lint/rules-schema.js";
import { normalizeCollisions } from "./declaration.js";
import { sameMat, IDENTITY } from "./motion.js";
import { CONTACT_EPS } from "./pairs.js";
import { poseMatrices } from "./place.js";
import { MOTION_SAMPLES, readSweep, scanMotion } from "./sweep-targets.js";
import { untrustedBuildReads, untrustedRebuilds } from "./untrusted-reads.js";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

// The control types that set a value along a travel, so can pose a motion (a legacy
// control desugars to "slider" unless it names another `control`).
const CONTINUOUS = new Set(["slider", "number"]);

// A control with no finite range is probed this far either side of its value: a placement
// that reads it is a motion with no range to sweep (the hint asks for a min and max).
const NOMINAL_STEPS = [1, 10];

/**
 * The exportable pieces shown at params q, each with its placement mat4 (null: not rigid),
 * `shown`, every sub-part shown there, joined by name, and `mats`, every shown sub-part's.
 */
function placementsAt(part, view, q) {
  const { p, d } = resolveParams(part, q);
  const mats = poseMatrices(part, view, p, d);
  const pieces = new Map(exportSubParts(part, view, p).map((name) => [name, mats.get(name) ?? null]));
  return { pieces, shown: [...mats.keys()].join("\n"), mats };
}

/**
 * Params some build shown at `full` reads (derive reads expanded; an untrusted build's
 * recorded on the probe kernel), or null when one of those builds cannot be read at all.
 * A param outside the set cannot change a build there.
 */
function buildReadsAt(part, view, full) {
  const reads = new Set();
  for (const [name, entry] of probePoses(part, view, full, { scope: "build" })) {
    const keys = entry.trusted ? entry.reads ?? [] : untrustedBuildReads(part, name, full);
    if (!keys) return null;
    for (const k of keys) reads.add(k);
  }
  return reads;
}

/**
 * Params some placement shown at `full` reads (derive reads expanded, so a param reaching
 * place() through `d` counts), from one place-scope probe per sub-part; null when one of
 * them cannot be probed (then every param is stepped). A param outside the set moves no
 * placement at `full`, exactly what the stepped pre-filter below would find, at no probe.
 */
function placeReadsAt(part, view, full) {
  const reads = new Set();
  for (const entry of probePoses(part, view, full, { scope: "place" }).values()) {
    if (!entry.trusted) return null;
    for (const k of entry.reads ?? []) reads.add(k);
  }
  return reads;
}

/**
 * Whether stepping `param` over the params `qs` rebuilds a shown sub-part, decided per
 * sub-part: a trusted build by its build-scope hash (differing from the first one seen),
 * an untrusted one by its reads (untrusted-reads.js, the rule scanMotion uses). Over lo,
 * mid and hi it is the cheap proof (3 probes rather than 17; false there is no proof of
 * the opposite: scanMotion's full scan decides).
 */
function rebuildsAt(part, view, qs, param) {
  const first = new Map();
  for (const q of qs) {
    for (const [name, e] of probePoses(part, view, q, { scope: "build" })) {
      if (!e.trusted) {
        if (untrustedRebuilds(part, name, q, [param])) return true;
        continue;
      }
      if (!first.has(name)) first.set(name, e.baseHash);
      else if (first.get(name) !== e.baseHash) return true;
    }
  }
  return false;
}

/** Whether any shown piece's placement differs between the samples (cheap: matrices only). */
function placementChanges(samples) {
  const first = samples[0].mats;
  for (const { mats } of samples.slice(1)) {
    if (mats.size !== first.size) return true;
    for (const [name, m] of mats) if (!first.has(name) || !sameMat(m, first.get(name))) return true;
  }
  return false;
}

/**
 * The relative motion of the exportable pieces over the values `vs` of one param, each read
 * through `sample(v)` (its placementsAt, computed once per value):
 * `{ moving, against, shownChanges }`, or null when there is none (nothing moves, or every
 * moving piece shares one delta and nothing shown stays still) or it cannot be read
 * rigidly, which includes the exportable pieces shown not being the same at every sample.
 * `shownChanges`: the set of all shown sub-parts is not the same at every sample.
 */
function relativeMotion(vs, sample) {
  const at = vs.map(sample);
  const shownChanges = at.some((s) => s.shown !== at[0].shown);
  const samples = at.map((s) => s.pieces);
  const names = [...samples[0].keys()];
  // a piece enabled for only part of the range is unreadable, whichever end it is missing at
  const key = (s) => [...s.keys()].join("\n");
  if (samples.some((s) => key(s) !== key(samples[0]))) return null;
  if (names.length < 2) return null;
  // m_i · m_0⁻¹ per piece per sample; a piece missing or not rigid at any sample is unreadable
  const deltas = new Map();
  for (const name of names) {
    const m0 = samples[0].get(name);
    if (!m0) return null;
    const inv = invertRigid(m0);
    const list = [];
    for (const s of samples) {
      const m = s.get(name);
      if (!m) return null;
      list.push(mulMat4(m, inv));
    }
    deltas.set(name, list);
  }
  const still = names.filter((n) => deltas.get(n).every((m) => sameMat(m, IDENTITY)));
  const moved = names.filter((n) => !still.includes(n));
  if (!moved.length) return null;
  if (still.length) return { moving: moved, against: still, shownChanges };
  // nothing stays still: a motion only if the moving pieces do not all move together
  const lead = deltas.get(moved[0]);
  const together = (n) => deltas.get(n).every((m, i) => sameMat(m, lead[i]));
  const group = moved.filter(together);
  if (group.length === moved.length) return null;
  return { moving: group, against: moved.filter((n) => !together(n)), shownChanges };
}

/** The keys a continuous control (slider, number) sets, or null when the schema cannot be read. */
function continuousKeys(part) {
  try {
    return new Set(controlNodes(desugar(part?.parameters)).filter((c) => CONTINUOUS.has(c.type)).map((c) => c.key));
  } catch {
    return null;
  }
}

/**
 * Params that can never be a motion, read off the declaration alone (no probing):
 * - a goal handle's target (`params: { position, aim? }`): a target, not a
 *   motion, never swept (sweep-targets.js readSweep, lint's sweep-goal-handle);
 * - a goal handle's `seed` (an array of param keys): the solver's starting guess, not a
 *   joint motion. The pose comes from the goal; moving the seed alone only changes where
 *   the solve starts, and a pose it reaches by failing the solve is the `tool` probe's to
 *   report. A seed param some non-goal handle also writes is still a motion: that handle
 *   moves it as a joint;
 * - a param nobody can move: no statically visible control (lint's controlBoundKeys with
 *   `excludeHidden`, the control-default-not-literal population) and no handle writes it;
 * - a DISCRETE param: its controls are none of them continuous (a slider or a number —
 *   select, radio, text, custom and the rest pick values, not a travel) and no non-goal
 *   handle writes it. Discrete poses are checked by presets and cases, never swept.
 * Nothing here throws on a malformed handle or schema: what cannot be read excludes nothing.
 */
function unmovableParams(part) {
  const out = new Set();
  const handles = isPlainObject(part?.handles) ? Object.values(part.handles) : [];
  const written = new Set();
  const seeds = new Set();
  const jointWritten = new Set(); // keys a non-goal handle writes
  for (const h of handles) {
    try {
      for (const k of handleParamKeys(h)) written.add(k);
      if (h?.drag !== "goal") {
        for (const k of handleParamKeys(h)) jointWritten.add(k);
        continue;
      }
      if (Array.isArray(h.seed)) for (const k of h.seed) if (typeof k === "string") seeds.add(k);
      // partforge's goal form is `params: { position, aim? }`; anything else names no target
      const p = h.params;
      if (!isPlainObject(p)) continue;
      for (const k of [...(Array.isArray(p.position) ? p.position : []), ...(Array.isArray(p.aim) ? p.aim : [])]) {
        if (typeof k === "string") out.add(k);
      }
    } catch { /* a malformed handle excludes nothing */ }
  }
  for (const k of seeds) if (!jointWritten.has(k)) out.add(k);
  let visible = null;
  try { visible = controlBoundKeys(part, { excludeHidden: true }); } catch { /* unreadable schema: keep every param */ }
  if (visible) for (const k of rangesOf(part).keys()) if (!visible.has(k) && !written.has(k)) out.add(k);
  const continuous = continuousKeys(part);
  if (continuous) for (const k of rangesOf(part).keys()) if (!continuous.has(k) && !jointWritten.has(k)) out.add(k);
  return out;
}

/**
 * One view's motions: `{ motions, partial }`. `stop()` is asked before each candidate
 * param; once it answers true the scan ends there with `partial: true` and the motions
 * found so far.
 */
function scanView(part, view, full, stop = () => false) {
  const out = [];
  let ranges, p0, buildReads, placeReads, skip, continuous;
  try {
    ranges = rangesOf(part);
    p0 = resolveParams(part, full).p;
    if (exportSubParts(part, view, p0).length < 2) return { motions: out, partial: false };
    skip = unmovableParams(part);
    continuous = continuousKeys(part);
    if (stop()) return { motions: out, partial: true };
    buildReads = buildReadsAt(part, view, full);
    placeReads = placeReadsAt(part, view, full);
  } catch {
    return { motions: out, partial: false };
  }
  for (const [param, r] of ranges) {
    if (skip.has(param) || (placeReads && !placeReads.has(param))) continue;
    const v0 = p0[param];
    if (!isNum(v0)) continue;
    if (stop()) return { motions: out, partial: true };
    const finite = isNum(r.min) && isNum(r.max) && r.max > r.min;
    const lo = finite ? r.min : v0 - NOMINAL_STEPS.at(-1), hi = finite ? r.max : v0 + NOMINAL_STEPS.at(-1);
    const vs = Array.from({ length: MOTION_SAMPLES + 1 }, (_, i) => lo + (hi - lo) * (i / MOTION_SAMPLES));
    const ends = [vs[0], vs[MOTION_SAMPLES / 2], vs[MOTION_SAMPLES]];
    // each value's placements once: the pre-filter's probes are samples of the run below
    const seen = new Map();
    const sample = (v) => {
      if (!seen.has(v)) seen.set(v, placementsAt(part, view, { ...full, [param]: v }));
      return seen.get(v);
    };
    const probes = finite ? ends : [v0, ...NOMINAL_STEPS.flatMap((s) => [v0 - s, v0 + s])];
    try {
      // cheap pre-filter: only a param that moves some placement gets the sample run
      if (!placementChanges(probes.map(sample))) continue;
      // rule (a), cheapest evidence first: a param whose build hashes already differ at lo,
      // mid and hi rebuilds, so it is a size and never reaches the sample runs below
      const buildRead = !buildReads || buildReads.has(param);
      if (buildRead && rebuildsAt(part, view, ends.map((v) => ({ ...full, [param]: v })), param)) continue;
      const rel = relativeMotion(vs, sample);
      if (!rel) continue;
      // rule (a): a param that rebuilds anything shown is a size, not a motion. A param no
      // shown build reads cannot rebuild one, so only the others pay for the full scan:
      // the engine's own (scanMotion), so coverage, lint and the engine agree on what
      // rebuilds, an untrusted build included.
      if (buildRead || rel.shownChanges) {
        const scan = scanMotion(part, view, { lo, hi, at: (v) => ({ ...full, [param]: v }) });
        if (scan.rebuild.length) continue;
      }
      // `discrete`: a handle moves it, but its control picks values (a select), so it can take no min and max
      out.push({ param, range: finite ? [r.min, r.max] : null, moving: rel.moving, against: rel.against,
        ...(continuous && !continuous.has(param) ? { discrete: true } : {}) });
    } catch {
      continue; // a motion that cannot be probed is skipped
    }
  }
  return { motions: out, partial: false };
}

/**
 * Params that, stepped over their control range with the others at `full`, rebuild no
 * sub-part shown in `view` and move at least one exportable sub-part relative to another
 * exportable sub-part shown there: `[{ param, range, moving, against }]`. `range` is
 * `[min, max]`, or null for a numeric control with no finite range that a placement reads.
 * A goal handle's target and seed, and a param nobody can move (unmovableParams), are never
 * motions.
 */
export function motionParams(part, view, full = part?.defaults ?? {}) {
  return scanView(part, view, full).motions;
}

// The scan of every view, memoized per part object: the last (params, budget, the five
// declaration references — see the module header) it ran with and its result, so lint and
// verify in one apply share one scan. Coverage is not cached:
// it reads the sweeps, which a caller may hand in, and costs no probing.
const SCANS = new WeakMap();
const sortedJson = (v) => JSON.stringify(v, (_, x) => (isPlainObject(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

const DECL_KEYS = ["parameters", "parts", "views", "handles", "derive"];
const declOf = (part) => DECL_KEYS.map((k) => part[k]);
const sameDecl = (decl, part) => DECL_KEYS.every((k, i) => decl[i] === part[k]);

/** `{ views: [[view, motions]], partial }` over every view, within `budgetMs`. */
function scanViews(part, full, budgetMs, now) {
  const views = Object.keys(part.views);
  let key = null;
  if (now === Date.now) {
    try { key = `${budgetMs}|${sortedJson(full)}`; } catch { /* unkeyable params: scan uncached */ }
    const hit = key != null && SCANS.get(part);
    if (hit && hit.key === key && sameDecl(hit.decl, part)) return hit.result;
  }
  const t0 = now();
  const stop = () => now() - t0 >= budgetMs;
  const result = { views: [], partial: false };
  for (const view of views) {
    const { motions, partial } = scanView(part, view, full, stop);
    result.views.push([view, motions]);
    if (partial) { result.partial = true; break; }
  }
  if (key != null) SCANS.set(part, { key, decl: declOf(part), result });
  return result;
}

/**
 * Every declared sweep read once: name → its `readSweep` result, or null when it cannot be
 * read. Empty for a part with no `verify.sweeps` map.
 */
export function readSweeps(part, full = part?.defaults ?? {}) {
  const out = new Map();
  const sweeps = part?.verify?.sweeps;
  if (!isPlainObject(sweeps)) return out;
  let declClear = CONTACT_EPS;
  try { declClear = normalizeCollisions(part)?.clearance ?? CONTACT_EPS; } catch { /* lint reports */ }
  for (const [name, spec] of Object.entries(sweeps)) {
    try { out.set(name, readSweep(part, name, spec, full, declClear)); } catch { out.set(name, null); }
  }
  return out;
}

/**
 * Params moved by some declared `verify.sweeps` entry that runs in `view`: a param sweep's
 * param, a handle sweep's params, the keys a path's or preset pair's waypoints change, and
 * an animation's tracked params. An unreadable sweep, or one that cannot run, covers nothing.
 * `reads` (optional): each sweep's `readSweep` result by name, from `readSweeps`, so a
 * caller that already read the sweeps (lint) does not read them again.
 */
export function coveredParams(part, view, full = part?.defaults ?? {}, reads = readSweeps(part, full)) {
  const out = new Set();
  for (const r of reads.values()) {
    if (!r || r.goal) continue;
    for (const s of r.entries) {
      if (s.skip) continue;
      if (s.views && !s.views.includes(view)) continue;
      if (s.animViews && !s.animViews.includes(view)) continue;
      if (s.kind === "param") out.add(s.param);
      else if (s.kind === "path") {
        const ws = s.waypoints.map((w) => ({ ...full, ...w }));
        for (const k of new Set(ws.flatMap(Object.keys))) {
          if (ws.some((w) => !Object.is(w[k], ws[0][k]))) out.add(k);
        }
      } else if (s.kind === "animation") {
        const anim = (viewAnimations(part).get(view) ?? []).find((a) => a.name === s.animation);
        for (const k of anim?.trackedKeys ?? []) out.add(k);
      }
    }
  }
  return out;
}

/**
 * Every view's motion params that no sweep covers there, one entry per param (the first
 * view it is uncovered in): `{ motions: [{ view, param, range, moving, against }], partial }`.
 * Empty for a part with no `views` map. `reads`: as for `coveredParams`; by default the
 * sweeps are read once, on the first view with a motion. The scan stops at `budgetMs`
 * (`now` is the clock, for tests): `partial` then says some (view, param) candidates were
 * never looked at, so the list names what was found, never that the rest is clear.
 */
export function uncoveredMotions(part, full = part?.defaults ?? {}, reads, { budgetMs = 1000, now = Date.now } = {}) {
  if (!isPlainObject(part?.views)) return { motions: [], partial: false };
  const scan = scanViews(part, full, budgetMs, now);
  const motions = [], seen = new Set();
  for (const [view, list] of scan.views) {
    if (!list.length) continue;
    reads ??= readSweeps(part, full);
    const covered = coveredParams(part, view, full, reads);
    for (const m of list) {
      if (covered.has(m.param) || seen.has(m.param)) continue;
      seen.add(m.param);
      motions.push({ view, ...m });
    }
  }
  return { motions, partial: scan.partial };
}

/**
 * One uncovered motion as a finding's two halves: `message`, the sentence naming the motion
 * (no closing period), and `hint`, the sweep to add. The hint always suggests `clearance: 0`;
 * a slider or number control with no finite range is asked for a min and max first, and a
 * discrete control a handle writes (`discrete`) is given a sweep with an explicit `range`.
 */
export function motionFinding({ view, param, range, moving, against, discrete = false }) {
  // the param as an object key: bare when it is a JS identifier, else quoted (`"lid-angle"`)
  const key = /^[A-Za-z_$][\w$]*$/.test(param) ? param : JSON.stringify(param);
  const q = JSON.stringify(param);
  const sweep = `add verify.sweeps: { ${key}: { param: ${q}, clearance: 0 } } and verify.expect._view: { sweepContacts: 0 }.`;
  const message = `"${param}" moves ${moving.join(", ")} against ${against.join(", ")} in view "${view}" and no sweep checks that motion`;
  if (range) return { message, hint: `A${sweep.slice(1)}` };
  // a select or other discrete control a handle writes cannot take a min and max: the sweep names its span
  if (discrete) {
    return { message, hint: `Add verify.sweeps: { ${key}: { param: ${q}, range: [lo, hi], clearance: 0 } } with the span the handle moves it over, and verify.expect._view: { sweepContacts: 0 }.` };
  }
  return { message, hint: `Give the "${param}" control a min and max, then ${sweep}` };
}

/** The hint lint and verify both give for one uncovered motion: message and hint joined. */
export function motionHint(entry) {
  const { message, hint } = motionFinding(entry);
  return `${message}. ${hint}`;
}
