// src/framework/export-controller.js
// Owns the jobId correlation for headless exportParts(): matches worker
// replies (progress/download/error) back to the Promise that started them.
// Pure — no DOM, no worker; `send` and the sink are injected.
import { triggerDownload, downloadParts } from "./download.js";
import { safeName } from "./safe-name.js";

// The one place the "which backend does this export format need" policy lives.
// STEP is always OCCT — only OCCT (OpenCASCADE) emits exact B-rep; Manifold's mesh
// CSG has no STEP writer. Every other format is free to use whichever backend the
// caller is already using for preview. Both the UI export buttons (mount.js) and
// the headless exportParts() API route through this so the rule is never encoded
// twice.
export function backendForFormat(format, defaultBackend) {
  return format === "step" ? "occt" : defaultBackend();
}

// Job ids are unique per controller, not just per mount: `export-<c>-<n>` and
// `warm-<c>-<n>`, where <c> numbers the controllers this module has made. Each
// mount makes one controller, but a host may keep a worker across mounts
// (partforge-cloud's pool rebinds it with setPart), and that worker's replies
// then reach whichever mount is listening now. Exports are never epoch-guarded
// (KERNEL-CONTRACT), so a disposed mount's slow export still answers after the
// remount. When every mount numbered its jobs from 1, that late reply settled
// the next mount's same-numbered export with pre-edit geometry. A worker can
// only be shared within one realm, and this counter covers the whole realm.
let controllers = 0;
// Every id any controller mints, so a reply to another controller's job is
// recognised even though this controller never sent it.
const CONTROLLER_JOB_ID = /^(?:export|warm)-\d+-\d+$/;

export function createExportController({ send, currentView, title, defaultBackend = () => "manifold", currentParams = () => ({}) }) {
  const pending = new Map(); // jobId -> { resolve, reject, onProgress }
  const controller = ++controllers;
  let nextId = 1;
  // Warm jobs get their own prefix for the reason mount.js spells out for
  // tessellate-imports: this map is keyed by jobId alone and read before any
  // type check, so a warm and an export sharing an id would settle each
  // other's Promise.
  let nextWarmId = 1;

  // `options` are the cut & print kit's download options (format "bundle"). They ride
  // the message for any format when given — the worker's other export branches never
  // read them — and are left off entirely when not, so every other export's message is
  // exactly what it always was.
  function exportParts({ parts, format, quality = "print", onProgress, options } = {}) {
    const jobId = `export-${controller}-${nextId++}`;
    const type = `export-${format}`;
    const backend = backendForFormat(format, defaultBackend);
    return new Promise((resolve, reject) => {
      pending.set(jobId, { resolve, reject, onProgress });
      send({ type, jobId, parts, view: currentView(), params: currentParams(), name: title(), quality,
        ...(options !== undefined ? { options } : {}) }, backend);
    });
  }

  // Pay a backend's cold boot on purpose, before anything needs it. STEP is
  // pinned to OCCT (backendForFormat), whose ~11 MB WASM loads lazily on its
  // first job — so for a Manifold-previewed part the STEP export IS that boot,
  // and the user waits for it having just asked for a file. A host that knows an
  // export is likely (its download dialog just opened) can spend that time
  // earlier instead.
  //
  // Best-effort by contract: resolves true once the kernel is up, false on any
  // failure or teardown, and NEVER rejects — a speculative warm must not become
  // an unhandled rejection in a host that fired it and moved on.
  function warmKernel() {
    const jobId = `warm-${controller}-${nextWarmId++}`;
    return new Promise((resolve) => {
      pending.set(jobId, { resolve: () => resolve(true), reject: () => resolve(false) });
      send({ type: "warm-kernel", jobId }, backendForFormat("step", defaultBackend));
    });
  }

  // Returns true iff this message is a reply to an export-controller job (so
  // the caller can skip legacy handling): a pending job is settled, any other
  // is dropped. `sink` is partforge's onDownload.
  function handleMessage(m, sink) {
    const jobId = m?.jobId;
    const entry = jobId != null ? pending.get(jobId) : undefined;
    // A controller's id with nothing pending here: a job this controller
    // already settled, or one a disposed controller sent to a worker the host
    // kept. Either way its Promise is already settled, so claim the reply and
    // drop it. Passing it on would let mount's switch read an "error" as a
    // failed build and a "download" as a viewbar save.
    if (!entry) return typeof jobId === "string" && CONTROLLER_JOB_ID.test(jobId);
    if (m.type === "progress") { entry.onProgress?.(m.phase); return true; }
    if (m.type === "kernel-warm") { pending.delete(m.jobId); entry.resolve(); return true; }
    if (m.type === "download") {
      pending.delete(m.jobId);
      triggerDownload(m.data, m.filename, m.mime, sink);
      entry.resolve();
      return true;
    }
    if (m.type === "download-parts") {
      pending.delete(m.jobId);
      const zipName = `${safeName(title(), "parts")}.zip`; // title() is the part's meta.title — untrusted
      downloadParts(m, zipName, sink);
      entry.resolve();
      return true;
    }
    if (m.type === "error") { pending.delete(m.jobId); entry.reject(new Error(m.message)); return true; }
    if (m.type === "needs-occt") { pending.delete(m.jobId); entry.reject(new Error("needs OCCT backend")); return true; }
    // needs-import-mesh MUST be claimed here (jobId intact from the worker's
    // shared catch) rather than falling through to mount's live-loop crossover
    // case: this export job never went through the regen loop, so treating its
    // reply as a live crossover would call loop.buildDone() for a build the
    // live loop never dispatched. v1 behavior is to fail this off-loop op
    // cleanly rather than build a second crossover flow for it — the import
    // gets primed by the next live build instead.
    if (m.type === "needs-import-mesh") {
      pending.delete(m.jobId);
      entry.reject(new Error("STEP import needs tessellation — retry after the first preview build primes it"));
      return true;
    }
    return false;
  }

  // Reject every in-flight export and clear the map — for teardown / worker
  // death, where worker replies will never arrive to settle these Promises.
  function dispose(reason) {
    const err = new Error(reason ?? "export cancelled");
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
  }

  return { exportParts, warmKernel, handleMessage, dispose };
}
