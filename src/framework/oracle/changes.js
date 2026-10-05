// What changed since the previous inspect of this view — the agent's
// "did my edit do what I meant" signal (spec: partforge-cloud
// docs/superpowers/specs/2026-09-30-geometry-diff-design.md). One tracker per
// kernel lifetime (a worker, a headless pool); best-effort by design: a retired
// worker, a new key or a new view simply has no baseline. Also hosts the measure
// memo for sub-parts whose final hash did not change.
//
// Call order inside one inspect: begin → buildView → endBuild(built) → measure →
// finish. endBuild is where every LIVE-solid read happens (hashes and the indexed
// mesh the boolean diff needs): measure ends with kernel.cleanup(), which frees
// the posed solids, so finish works only from what endBuild captured plus
// measure's volumes.
import { startHashRecording, stopHashRecording } from "../geometry/solid-hash.js";
import { changedRoots } from "./op-graph.js";
import { bounds } from "./mesh.js";
import { composePose } from "../geometry/pose.js";

// The share of the consumer's whole-report timeout this tracker may spend,
// measured from begin() — buildView, endBuild's re-meshing and measure all run
// before finish, so a budget counted from finish alone could push the report
// past partforge-cloud's REPORT_TIMEOUT_MS (8 s), which discards match, measure
// and verify together. 6 s leaves verify and match scoring the rest.
export const REPORT_SHARE_MS = 6000;

const centre = (positions) => {
  const b = bounds(positions);
  return [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2);
};
const shapeHashOf = (s) => s?._canon?.hash ?? s?._baseHash ?? null;
// The rotation block of a solid's placement — the trailing rigid transforms on
// top of its shape hash: Manifold's canon chain ({op, ...}) or OCCT's pending
// pose ({t, ...}). Composed rather than compared entry by entry, so two chains
// that land on the same orientation agree. null when the backend exposes none.
const rotationOf = (s) => {
  const steps = s?._canon?.chain?.map(({ op, ...r }) => ({ t: op, ...r })) ?? s?._pose;
  if (!Array.isArray(steps)) return null;
  const m = composePose(steps);
  return [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
};
const rotationChanged = (a, b) => !!a && !!b && a.some((v, i) => Math.abs(v - b[i]) > 1e-6);
const triangleCount = (mesh) => (mesh?.indices ? mesh.indices.length / 3 : (mesh?.positions?.length ?? 0) / 9);
// The boolean diff needs an INDEXED mesh. buildView's mesh is Manifold's
// non-indexed soup, so a Manifold solid is re-meshed; an OCCT display mesh is
// already indexed (and OCCT has no boolean diff), so it is copied rather than
// re-tessellated at export quality.
const indexedMeshOf = (solid, mesh) => {
  const m = mesh?.indices ? mesh : solid.toIndexedMesh();
  return { positions: Float32Array.from(m.positions), indices: Uint32Array.from(m.indices) };
};

export function createChangeTracker({ now = Date.now, budgetMs = 2000, maxTriangles = 300000 } = {}) {
  let key = null;
  let view = null;         // the view this round is building (from begin)
  let baseline = null;     // { view, hashes:Set|null (null: the record overflowed), subparts: Map(name -> entry) }
  let record = null;
  // Map(name -> {hash, shape, rotation, centre, mesh, volume}) from endBuild;
  // `mesh` is null for a sub-part too big to diff (over maxTriangles/2).
  let captured = null;
  let startedAt = null;    // begin()'s clock reading: the report deadline counts from here
  let memoPrev = new Map(), memoNext = new Map();
  let pairPrev = new Map(), pairNext = new Map();
  const mk = (hash, k2) => `${hash}\u0000${k2}`;      // facts depend on geometry, not the name
  const pk = (a, ha, b, hb) => `${a}\u0000${ha}\u0000${b}\u0000${hb}`;

  // Stored under a structuredClone: the caller's `facts`/`gap` object is also
  // handed out as part of the oracle's REPORT, which a consumer is free to
  // mutate. Without the clone, that mutation reaches through the same object
  // reference into the memo and poisons a later hit; cloning on write is what
  // keeps the memo's copy independent of whatever happens to the report.
  // Cloned on read too, for the same reason in the other direction: a hit is
  // handed out in the report. Every clone is guarded — a value structuredClone
  // refuses is simply not memoized (or reads as a miss), so measure measures
  // instead of throwing.
  const clone = (v) => { try { return structuredClone(v); } catch { return undefined; } };
  const memo = {
    get: (name, hash, k2) => {
      const v = memoPrev.get(mk(hash, k2));
      const c = v === undefined ? undefined : clone(v);
      return c ? { ...c, name } : undefined;
    },
    set: (name, hash, k2, facts) => { const c = clone(facts); if (c !== undefined) memoNext.set(mk(hash, k2), c); },
    getPair: (a, ha, b, hb) => { const v = pairPrev.get(pk(a, ha, b, hb)); return v === undefined ? undefined : clone(v); },
    setPair: (a, ha, b, hb, gap) => { const c = clone(gap); if (c !== undefined) pairNext.set(pk(a, ha, b, hb), c); },
  };

  const reset = () => { baseline = null; memoPrev = new Map(); pairPrev = new Map(); };
  const clearRound = () => { record = null; captured = null; startedAt = null; memoNext = new Map(); pairNext = new Map(); };
  const prevFor = (v) => (baseline?.view === v ? baseline : null);

  return {
    memo,
    begin(k, v) {
      if (k !== key) { key = k; reset(); }
      view = v;
      clearRound();
      startedAt = now();
      startHashRecording();
    },
    endBuild(built) {
      record = stopHashRecording();
      captured = null;
      if (!Array.isArray(built)) return;
      try {
        const prev = prevFor(view);
        captured = new Map();
        for (const { name, solid, mesh } of built) {
          const hash = solid?._hash ?? null;
          const old = prev?.subparts.get(name);
          // An unchanged sub-part keeps the stored entry: no re-mesh for it.
          if (old && hash && old.hash === hash) { captured.set(name, { ...old }); continue; }
          // Re-meshing is uncounted by finish's budget, so a sub-part too big for
          // the boolean diff anyway (the pair is refused past maxTriangles) is not
          // captured at all: next round it falls back to the volume-delta verdict.
          const big = triangleCount(mesh) > maxTriangles / 2;
          captured.set(name, {
            hash, shape: shapeHashOf(solid), rotation: rotationOf(solid),
            centre: centre(mesh.positions), mesh: big ? null : indexedMeshOf(solid, mesh),
          });
        }
      } catch {
        captured = null;
      }
    },
    abort() { stopHashRecording(); clearRound(); },
    finish(kernel, v, built, measured) {
      try {
        // No capture means no baseline can be stored for this build: forget the
        // old one too, so the next round reports {} rather than diffing two builds back.
        if (!Array.isArray(built) || !captured || v !== view) { reset(); return {}; }
        const start = now();
        // Whichever ends first: the diff budget, or the report's share counted from begin().
        const deadline = Math.min(start + budgetMs, (startedAt ?? start) + REPORT_SHARE_MS);
        const vol = new Map((measured?.subparts ?? []).map((s) => [s.name, s.volume]));
        const prev = prevFor(v);
        const out = [];
        let unchanged = 0, skipped = null, verdicts = 0, timedOut = false;
        for (const [name, entry] of captured) {
          entry.volume = vol.get(name) ?? null;
          if (!prev) continue;
          const old = prev.subparts.get(name);
          if (!old) { out.push({ name, verdict: "new" }); verdicts++; continue; }
          const { hash, shape, mesh, rotation } = entry;
          if (hash && hash === old.hash) { unchanged++; verdicts++; continue; }
          // Both graphs are needed: against a missing baseline graph every op reads as new.
          const ops = record?.size && prev.hashes && hash ? changedRoots(record, hash, prev.hashes) : [];
          const withOps = (o) => (ops.length ? { ...o, changedOps: ops } : o);
          if (shape && shape === old.shape) {
            // `moved` is the bounding-box centre's offset, so a rotation about the
            // centre reads as ≈0 — `rotated` is what says the orientation changed.
            const a = old.centre, b = entry.centre;
            const rotated = rotationChanged(old.rotation, rotation);
            out.push(withOps({ name, verdict: "moved", moved: [0, 1, 2].map((i) => b[i] - a[i]), ...(rotated ? { rotated: true } : {}) }));
            verdicts++;
            continue;
          }
          // Budget spent: this build is still stored whole as the next baseline
          // (captured holds every entry), but nothing more is diffed.
          if (timedOut || now() > deadline) { timedOut = true; continue; }
          const delta = { volumeDeltaMm3: (entry.volume ?? 0) - (old.volume ?? 0) };
          // Either side too big to have been captured: the diff would refuse it anyway.
          if (!mesh || !old.mesh) {
            if (typeof kernel?._meshDiff === "function") skipped ??= "too-large";
            out.push(withOps({ name, verdict: "reshaped", ...delta })); verdicts++; continue;
          }
          if (typeof kernel?._meshDiff !== "function") {
            out.push(withOps({ name, verdict: "reshaped", ...delta })); verdicts++; continue;
          }
          const floor = Math.max(0.5, 1e-4 * Math.abs(entry.volume ?? 0));
          // A throw (a WASM fault, OOM) is not one of the reported skip reasons: it
          // falls back to the volume delta and the loop goes on, so the baseline
          // still rotates to this build.
          let d;
          try { d = kernel._meshDiff(old.mesh, mesh, { maxTriangles, minVolume: floor }); } catch { d = null; }
          if (!d?.ok) {
            if (d) skipped ??= d.reason;
            out.push(withOps({ name, verdict: "reshaped", ...delta })); verdicts++; continue;
          }
          const add = d.addedMm3 > floor, rem = d.removedMm3 > floor;
          const regions = [
            ...d.added.map((r) => ({ change: "added", ...r })),
            ...d.removed.map((r) => ({ change: "removed", ...r })),
          ].sort((x, y) => y.mm3 - x.mm3).slice(0, 3);
          out.push(withOps({
            name, verdict: add && !rem ? "added" : rem && !add ? "removed" : "reshaped",
            addedMm3: d.addedMm3, removedMm3: d.removedMm3, ...(regions.length ? { regions } : {}),
          }));
          verdicts++;
        }
        if (prev) for (const name of prev.subparts.keys()) if (!captured.has(name)) { out.push({ name, verdict: "deleted" }); verdicts++; }
        baseline = { view: v, hashes: record ? new Set(record.keys()) : null, subparts: captured };
        memoPrev = memoNext; pairPrev = pairNext;
        if (!prev) return {};
        if (timedOut && verdicts === 0) return { changesSkipped: "timeout" };
        if (timedOut) skipped ??= "timeout";
        // "unchanged" is a claim about EVERY sub-part, so a timed-out one rules it out.
        const changes = out.length === 0 && !timedOut
          ? { unchanged: true, subparts: [], unchangedSubparts: unchanged }
          : { subparts: out, unchangedSubparts: unchanged };
        return skipped ? { changes, changesSkipped: skipped } : { changes };
      } catch {
        reset();
        return {};
      } finally {
        clearRound();
      }
    },
  };
}
