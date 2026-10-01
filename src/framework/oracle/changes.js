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

const centre = (positions) => {
  const b = bounds(positions);
  return [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2);
};
const shapeHashOf = (s) => s?._canon?.hash ?? s?._baseHash ?? null;
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
  let baseline = null;     // { view, hashes:Set|null (null: the record overflowed), subparts: Map(name -> {hash, shape, mesh, volume}) }
  let record = null;
  let captured = null;     // Map(name -> {hash, shape, mesh}) from endBuild
  let memoPrev = new Map(), memoNext = new Map();
  let pairPrev = new Map(), pairNext = new Map();
  const mk = (hash, k2) => `${hash}\u0000${k2}`;      // facts depend on geometry, not the name
  const pk = (a, ha, b, hb) => `${a}\u0000${ha}\u0000${b}\u0000${hb}`;

  const memo = {
    get: (name, hash, k2) => { const v = memoPrev.get(mk(hash, k2)); return v ? { ...v, name } : undefined; },
    set: (name, hash, k2, facts) => { memoNext.set(mk(hash, k2), facts); },
    getPair: (a, ha, b, hb) => pairPrev.get(pk(a, ha, b, hb)),
    setPair: (a, ha, b, hb, gap) => { pairNext.set(pk(a, ha, b, hb), gap); },
  };

  const reset = () => { baseline = null; memoPrev = new Map(); pairPrev = new Map(); };
  const clearRound = () => { record = null; captured = null; memoNext = new Map(); pairNext = new Map(); };
  const prevFor = (v) => (baseline?.view === v ? baseline : null);

  return {
    memo,
    begin(k, v) {
      if (k !== key) { key = k; reset(); }
      view = v;
      clearRound();
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
          // An unchanged sub-part keeps the stored mesh: no re-mesh for it.
          const same = old && hash && old.hash === hash;
          captured.set(name, { hash, shape: shapeHashOf(solid), mesh: same ? old.mesh : indexedMeshOf(solid, mesh) });
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
        const vol = new Map((measured?.subparts ?? []).map((s) => [s.name, s.volume]));
        const prev = prevFor(v);
        const out = [];
        let unchanged = 0, skipped = null, verdicts = 0, timedOut = false;
        for (const [name, entry] of captured) {
          entry.volume = vol.get(name) ?? null;
          if (!prev) continue;
          const old = prev.subparts.get(name);
          if (!old) { out.push({ name, verdict: "new" }); verdicts++; continue; }
          const { hash, shape, mesh } = entry;
          if (hash && hash === old.hash) { unchanged++; verdicts++; continue; }
          // Both graphs are needed: against a missing baseline graph every op reads as new.
          const ops = record?.size && prev.hashes && hash ? changedRoots(record, hash, prev.hashes) : [];
          const withOps = (o) => (ops.length ? { ...o, changedOps: ops } : o);
          if (shape && shape === old.shape) {
            const a = centre(old.mesh.positions), b = centre(mesh.positions);
            out.push(withOps({ name, verdict: "moved", moved: [0, 1, 2].map((i) => b[i] - a[i]) }));
            verdicts++;
            continue;
          }
          // Budget spent: this build is still stored whole as the next baseline
          // (captured holds every entry), but nothing more is diffed.
          if (timedOut || now() - start > budgetMs) { timedOut = true; continue; }
          const delta = { volumeDeltaMm3: (entry.volume ?? 0) - (old.volume ?? 0) };
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
