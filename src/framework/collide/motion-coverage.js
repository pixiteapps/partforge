// Which params pose one piece against another (motion params), and which of them a
// declared `verify.sweeps` entry moves (spec 2026-11-12-moving-fits-swept-design.md, A).
// Lint's motion-unswept warning and verify's sweepCoverage check both read motions
// through this one module, so the two name the same params with the same hint.
//
// A BVH-free leaf, like sweep-targets.js, whose probing it reuses: geometry-free probes and
// the placement rule only, never the collision world, the native core or oracle/, so the
// lint closure and the worker's eager closure may load it (test/worker-layering.test.js).
// No sweep is ever run here. Nothing here throws on a malformed part: a param whose motion
// cannot be probed is skipped.
import { exportSubParts, resolveParams } from "../part-model.js";
import { probePoses } from "../pose-probe.js";
import { viewAnimations } from "../animation.js";
import { invertRigid, mulMat4 } from "../geometry/pose.js";
import { rangesOf } from "../pose/param-solve.js";
import { normalizeCollisions } from "./declaration.js";
import { sameMat, IDENTITY } from "./motion.js";
import { CONTACT_EPS } from "./pairs.js";
import { poseMatrices } from "./place.js";
import { MOTION_SAMPLES, readSweep, scanMotion } from "./sweep-targets.js";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

// A control with no finite range is probed this far either side of its value: a placement
// that reads it is a motion with no range to sweep (the hint asks for a min and max).
const NOMINAL_STEPS = [1, 10];

/**
 * The exportable pieces shown at params q, each with its placement mat4 (null: not rigid),
 * and `shown`, every sub-part shown there, joined by name.
 */
function placementsAt(part, view, q) {
  const { p, d } = resolveParams(part, q);
  const mats = poseMatrices(part, view, p, d);
  const pieces = new Map(exportSubParts(part, view, p).map((name) => [name, mats.get(name) ?? null]));
  return { pieces, shown: [...mats.keys()].join("\n") };
}

/**
 * Params some build shown at `full` reads (derive reads expanded), or null when one of
 * those builds cannot be probed. A param outside the set cannot change a build there.
 */
function buildReadsAt(part, view, full) {
  const reads = new Set();
  for (const entry of probePoses(part, view, full, { scope: "build" }).values()) {
    if (!entry.trusted) return null;
    for (const k of entry.reads ?? []) reads.add(k);
  }
  return reads;
}

/** Whether any shown piece's placement differs between the probes (cheap: matrices only). */
function placementChanges(part, view, qs) {
  let first = null;
  for (const q of qs) {
    const { p, d } = resolveParams(part, q);
    const mats = poseMatrices(part, view, p, d);
    if (!first) { first = mats; continue; }
    if (mats.size !== first.size) return true;
    for (const [name, m] of mats) if (!first.has(name) || !sameMat(m, first.get(name))) return true;
  }
  return false;
}

/**
 * The relative motion of the exportable pieces over the samples `vs` of `param`:
 * `{ moving, against, shownChanges }`, or null when there is none (nothing moves, or every
 * moving piece shares one delta and nothing shown stays still) or it cannot be read
 * rigidly, which includes the exportable pieces shown not being the same at every sample.
 * `shownChanges`: the set of all shown sub-parts is not the same at every sample.
 */
function relativeMotion(part, view, full, param, vs) {
  const at = vs.map((v) => placementsAt(part, view, { ...full, [param]: v }));
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

/**
 * Params that, stepped over their control range with the others at `full`, rebuild no
 * sub-part shown in `view` and move at least one exportable sub-part relative to another
 * exportable sub-part shown there: `[{ param, range, moving, against }]`. `range` is
 * `[min, max]`, or null for a numeric control with no finite range that a placement reads.
 */
export function motionParams(part, view, full = part?.defaults ?? {}) {
  const out = [];
  let ranges, p0, buildReads;
  try {
    ranges = rangesOf(part);
    p0 = resolveParams(part, full).p;
    if (exportSubParts(part, view, p0).length < 2) return out;
    buildReads = buildReadsAt(part, view, full);
  } catch {
    return out;
  }
  for (const [param, r] of ranges) {
    const v0 = p0[param];
    if (!isNum(v0)) continue;
    const finite = isNum(r.min) && isNum(r.max) && r.max > r.min;
    const lo = finite ? r.min : v0 - NOMINAL_STEPS.at(-1), hi = finite ? r.max : v0 + NOMINAL_STEPS.at(-1);
    const probes = finite ? [lo, (lo + hi) / 2, hi] : [v0, ...NOMINAL_STEPS.flatMap((s) => [v0 - s, v0 + s])];
    try {
      // cheap pre-filter: only a param that moves some placement gets the full scan
      if (!placementChanges(part, view, probes.map((v) => ({ ...full, [param]: v })))) continue;
      const vs = Array.from({ length: MOTION_SAMPLES + 1 }, (_, i) => lo + (hi - lo) * (i / MOTION_SAMPLES));
      const rel = relativeMotion(part, view, full, param, vs);
      if (!rel) continue;
      // rule (a): a param that rebuilds anything shown is a size, not a motion. A param no
      // shown build reads cannot rebuild one, so only the others pay for the full scan
      // (the engine's own, so lint and the engine agree on what rebuilds).
      if (!buildReads || buildReads.has(param) || rel.shownChanges) {
        const scan = scanMotion(part, view, { lo, hi, at: (v) => ({ ...full, [param]: v }) });
        if (scan.rebuild.length) continue;
      }
      out.push({ param, range: finite ? [r.min, r.max] : null, moving: rel.moving, against: rel.against });
    } catch {
      continue; // a motion that cannot be probed is skipped
    }
  }
  return out;
}

/**
 * Params moved by some declared `verify.sweeps` entry that runs in `view`: a param sweep's
 * param, a handle sweep's params, the keys a path's or preset pair's waypoints change, and
 * an animation's tracked params. An unreadable sweep, or one that cannot run, covers nothing.
 */
export function coveredParams(part, view, full = part?.defaults ?? {}) {
  const out = new Set();
  const sweeps = part?.verify?.sweeps;
  if (!isPlainObject(sweeps)) return out;
  let declClear = CONTACT_EPS;
  try { declClear = normalizeCollisions(part)?.clearance ?? CONTACT_EPS; } catch { /* lint reports */ }
  for (const [name, spec] of Object.entries(sweeps)) {
    let r;
    try { r = readSweep(part, name, spec, full, declClear); } catch { continue; }
    if (r.goal) continue;
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
 * view it is uncovered in): `[{ view, param, range, moving, against }]`. Empty for a part
 * with no `views` map.
 */
export function uncoveredMotions(part, full = part?.defaults ?? {}) {
  const views = part?.views;
  if (!isPlainObject(views)) return [];
  const out = [], seen = new Set();
  for (const view of Object.keys(views)) {
    const motions = motionParams(part, view, full);
    if (!motions.length) continue;
    const covered = coveredParams(part, view, full);
    for (const m of motions) {
      if (covered.has(m.param) || seen.has(m.param)) continue;
      seen.add(m.param);
      out.push({ view, ...m });
    }
  }
  return out;
}

/** The hint lint and verify both give for one uncovered motion. Always `clearance: 0`. */
export function MOTION_HINT({ view, param, range, moving, against }) {
  const head = `"${param}" moves ${moving.join(", ")} against ${against.join(", ")} in view "${view}" and no sweep checks that motion. `;
  return head + (range
    ? `Add verify.sweeps: { ${param}: { param: "${param}", clearance: 0 } } and verify.expect._view: { sweepContacts: 0 }.`
    : `Give the "${param}" control a min and max first, so the sweep has a range.`);
}
