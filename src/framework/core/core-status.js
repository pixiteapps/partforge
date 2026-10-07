// Where this realm's native core stands, and who wants to hear about it — kept
// apart from core.js so a host can import it (partforge/worker re-exports it)
// without pulling in the WebAssembly bytes. core.js records into it.
//
// Falling back to the JS is silent to the user (the answers are identical) but
// must not be silent to the host: onCoreFallback(listener) is told — once — when
// the core becomes unavailable or faults, with a fixed reason and nothing else,
// so it can go straight into a host's telemetry.

// Every reason a fallback can carry. A fixed vocabulary on purpose: hosts record
// it, and an error message could carry anything.
export const CORE_FALLBACK_REASONS = Object.freeze(["no_webassembly", "boot_failed", "out_of_memory", "trap", "error"]);

let fallback = null; // { state: "unavailable" | "faulted", reason } once it happened
let refused = 0;     // meshes the core declined (malformed MeshGL) — the JS took them
let probe = () => "idle"; // core.js installs the live answer when it loads
const listeners = new Set();

export function setStateProbe(fn) { probe = fn; }

export function recordFallback(state, reason) {
  if (fallback) return; // the first cause is the one worth knowing
  fallback = { state, reason };
  for (const fn of listeners) {
    try { fn({ ...fallback }); } catch { /* a host listener must never break a build */ }
  }
}

// A pass sent a mesh to the JS because the core declined it (not a fault).
export function countRefusedMesh() { refused++; }

// Where this realm's core stands:
//   state: "idle" (not needed yet) | "on" | "off" (switched off) |
//          "unavailable" (could not start) | "faulted" (stopped after a fault)
//   reason: one of CORE_FALLBACK_REASONS for unavailable/faulted, else null
//   refusedMeshes: how many meshes went to the JS because the core declined them
export function coreStatus() {
  return { state: fallback?.state ?? probe(), reason: fallback?.reason ?? null, refusedMeshes: refused };
}

// Call `listener({ state, reason })` once when the core becomes unavailable or
// faults — immediately if it already has. Returns an unsubscribe function.
export function onCoreFallback(listener) {
  if (fallback) {
    try { listener({ ...fallback }); } catch { /* see recordFallback */ }
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Tests only (via core.js's setCoreForTesting): forget everything recorded.
export function resetCoreStatus() {
  fallback = null;
  refused = 0;
  listeners.clear();
}
