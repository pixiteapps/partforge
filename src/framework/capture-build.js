// Correlated one-shot geometry builds for captureView — a private channel that
// does NOT go through the regen loop. Same shape as export-controller's pending
// Map (export-controller.js): allocate a jobId, resolve when the matching
// reply arrives. Pure — no DOM, no worker; `send` is injected.
export function createCaptureBuild({ send }) {
  let nextId = 1;
  let disposed = false;
  const pending = new Map(); // jobId -> resolve

  function request({ subparts, view, params, backend }) {
    // After teardown the workers are gone, so a fresh send would post to a terminated
    // worker (a silent no-op) and its promise would hang forever. Resolve null instead
    // — captureView's documented "disposed runtime resolves null" contract.
    if (disposed) return Promise.resolve(null);
    // String-namespaced ("cap-N") so a capture jobId stays outside
    // export-controller's "export-"/"warm-" ids — both share the same worker
    // message space, and exportCtl.handleMessage claims every id in its own
    // namespace before checking type, so a colliding id could otherwise settle
    // the wrong promise.
    const jobId = `cap-${nextId++}`;
    return new Promise((resolve) => {
      pending.set(jobId, resolve);
      // cache:true so the worker reuses its per-sub-part geometry memo (the
      // expensive CSG); only the per-view place() + meshing re-run.
      send({ type: "capture-generate", jobId, subparts, view, params, cache: true }, backend);
    });
  }

  // Returns true iff this message was a reply this controller owns (so the
  // caller — mount.js's onWorkerMessage — can skip it entirely). Keyed on
  // membership in `pending` first: the namespaced jobId guarantees another
  // channel's message never matches, so a hit here is always ours. A failed
  // build (the worker's shared catch posts a generic error/needs-occt/
  // needs-import-mesh, jobId intact) resolves to null rather than leaving the
  // caller hanging forever — captureView treats null as "capture failed, skip".
  // needs-import-mesh MUST be claimed here rather than falling through to
  // mount's live-loop crossover case: this capture job never went through the
  // regen loop, so treating its reply as a live crossover would call
  // loop.buildDone() for a build the live loop never dispatched, and could
  // fire a stray tessellate-imports request or flip the live importMeshState
  // latch. A capture-generate hit on an unprimed STEP import is not itself
  // retried — the v1 behavior is "fail this off-loop op cleanly"; the import
  // gets primed by the next live build instead.
  function handleMessage(data) {
    const jobId = data?.jobId;
    if (jobId == null || !pending.has(jobId)) return false;
    if (data.type === "capture-meshes") {
      pending.get(jobId)(data.meshes);
    } else if (data.type === "error" || data.type === "needs-occt" || data.type === "needs-import-mesh") {
      pending.get(jobId)(null);
    } else {
      return false;
    }
    pending.delete(jobId);
    return true;
  }

  // Teardown / worker death: settle every in-flight request to null instead
  // of leaving its promise permanently pending (a caller awaiting captureView
  // across a viewer dispose must still get an answer, even a negative one).
  function dispose() {
    disposed = true;
    for (const resolve of pending.values()) resolve(null);
    pending.clear();
  }

  return { request, handleMessage, dispose };
}
