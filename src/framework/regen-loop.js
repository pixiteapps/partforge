// The auto-regenerate state machine (no DOM, no workers — pure orchestration).
// mount.js wires it to the geometry service: `missingParts` reports what the
// active view still needs, `send` dispatches one build job for those parts.
//
// Invariants (pinned by test/framework/regen-loop.test.js):
// - nothing is sent until ready() (the worker announced its kernel);
// - at most one dispatch CYCLE is in flight; kicks while generating are absorbed
//   and the caller re-kicks after the cycle's last buildDone(). `send` may fan a
//   dispatch out to several workers (per-sub-part backend routing) and reports
//   how many jobs it posted; each worker reply is one buildDone();
// - markDirty() bumps the params version and debounces a kick, so dragging a
//   slider queues one build per pause, not one per pixel;
// - a build that a mid-flight edit outdated is reported stale by buildDone()
//   (return false → the caller discards the meshes and kicks a rebuild);
// - markDirty({debounce:false}) bumps without arming the timer (the animation
//   fast-apply path kicks explicitly).
export function createRegenLoop({ missingParts, send, debounceMs = 180 }) {
  let kernelReady = false;
  let pending = 0;       // worker replies still owed for the in-flight dispatch cycle
  let disposed = false;
  let paramsVersion = 0; // bumped on every settings edit
  let genVersion = -1;   // the params version the in-flight build is building
  let timer = null;

  function kick() {
    if (disposed || !kernelReady || pending > 0) return; // re-kicked when the current cycle finishes
    const missing = missingParts();
    if (missing.length === 0) return;
    genVersion = paramsVersion;
    // A send with no return value is the single-job case (one worker, one reply).
    pending = send(missing) ?? 1;
  }

  return {
    kick,
    ready() { if (disposed) return; kernelReady = true; kick(); },
    // `debounce: false` is the animation driver's mode: the version still bumps
    // (stale in-flight builds are still detected), but no timer is armed — the
    // driver kicks explicitly after the pose fast path has repaired, so a
    // pose-only frame sends no job and a geometry frame dispatches immediately
    // whenever the worker is idle (best-effort at worker cadence, clock-free).
    markDirty({ debounce = true } = {}) {
      paramsVersion++;
      clearTimeout(timer);
      if (debounce) timer = setTimeout(kick, debounceMs);
    },
    // One job of the cycle finished (meshes / needs-occt / error). Returns whether
    // its result is still current; the caller applies the meshes only on true, then
    // kicks (a no-op until the cycle's last reply). Guarded decrement: a reply
    // outside any cycle (an export-triggered needs-occt) must not pre-close the next.
    buildDone() {
      if (pending > 0) pending--;
      return genVersion === paramsVersion;
    },
    version: () => paramsVersion,
    // A build is in flight and nothing has edited the params since it was sent —
    // the test a progressive batch (meshes-partial) must pass to be shown.
    isFresh: () => pending > 0 && genVersion === paramsVersion,
    // Terminal: cancel the pending debounce and refuse all future sends.
    dispose() { disposed = true; clearTimeout(timer); },
  };
}
