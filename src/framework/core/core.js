// The native core: native/*.cpp compiled to one WebAssembly module
// (core-wasm.js, built by scripts/build-core-wasm.mjs), loaded lazily and
// synchronously the first time a pass asks for it.
//
// What it runs — each a bit-exact port of a JS pass, which stays as the
// fallback:
//   creasedNormals          geometry/creased-normals.js (+ blend-surfaces.js)
//   the oracle's BVH        oracle/bvh.js, via cachedBVH (+ min-wall.js)
//
// Bit-exact is the contract, not an aspiration: test/core-parity.test.js builds
// the reference parts both ways and requires identical output, so turning the
// core on or off changes no mesh, normal, edge, reading or verdict — only how
// long they take (several times faster with a JIT; far more on a host whose JS
// is interpreted).
//
// The switch: on by default wherever WebAssembly exists. `setCoreEnabled(false)`
// (exported from partforge/oracle and partforge/testing), or
// `globalThis.PARTFORGE_CORE = false` (read on every use, so it can be set any
// time), turns it off for that realm — a worker is its own realm, so a host sets
// it there. If the module cannot be instantiated the passes keep their JS.
//
// Failure is contained, never fatal: a failed allocation or a trap inside the
// module POISONS that instance (poisonCore) — nothing touches it again — and
// the pass that hit it, and every pass after, runs its JS instead. And because
// WebAssembly memory only ever grows, an instance whose memory passed
// RECYCLE_BYTES is dropped once nothing holds it (releaseIfIdle); the next pass
// boots a fresh one in a few milliseconds and the old memory goes to the GC.
//
// Falling back is silent to the user (the answers are identical) but must not be
// silent to the host: coreStatus() says where this realm stands, and
// onCoreFallback(listener) is told — once — when the core becomes unavailable or
// faults, with a fixed reason (CORE_FALLBACK_REASONS) and nothing else, so a host
// can count fallbacks in its own telemetry.
import { CORE_WASM_BASE64 } from "./core-wasm.js";

// What the core may keep holding between passes. Ordinary forges never grow it
// past its 16 MB start; a preview mesh needs ~145 bytes/triangle at the peak
// (screw, 210k triangles: 29 MB; a 1M-triangle mesh: 138 MB). Re-booting costs a
// few milliseconds — the module is 64 KB — so cap the retained memory low.
export const RECYCLE_BYTES = 64 * 1024 * 1024;

let enabled = true;
let booted; // undefined: not tried yet (or recycled); null: unavailable or poisoned
let fallback = null; // { state: "unavailable" | "faulted", reason } once it happened
let refused = 0;     // meshes the core declined (malformed MeshGL) — the JS took them
const listeners = new Set();

const OUT_OF_MEMORY = "partforge core: out of WebAssembly memory";
// Every reason a fallback can carry. A fixed vocabulary on purpose: hosts record
// it as telemetry, and an error message could carry anything.
export const CORE_FALLBACK_REASONS = Object.freeze(["no_webassembly", "boot_failed", "out_of_memory", "trap", "error"]);

function reasonOf(err) {
  if (err?.message === OUT_OF_MEMORY) return "out_of_memory";
  if (typeof WebAssembly === "object" && err instanceof WebAssembly.RuntimeError) return "trap";
  return "error";
}

function fellBack(state, reason) {
  if (fallback) return; // the first cause is the one worth knowing
  fallback = { state, reason };
  for (const fn of listeners) {
    try { fn({ ...fallback }); } catch { /* a host listener must never break a build */ }
  }
}

// Where this realm's core stands:
//   state: "idle" (not needed yet) | "on" | "off" (switched off) |
//          "unavailable" (could not start) | "faulted" (stopped after a fault)
//   reason: one of CORE_FALLBACK_REASONS for unavailable/faulted, else null
//   refusedMeshes: how many meshes went to the JS because the core declined them
export function coreStatus() {
  const state = fallback?.state
    ?? (!enabled || flagOff() ? "off" : booted ? "on" : "idle");
  return { state, reason: fallback?.reason ?? null, refusedMeshes: refused };
}

// Call `listener({ state, reason })` once when the core becomes unavailable or
// faults — immediately if it already has. Returns an unsubscribe function.
export function onCoreFallback(listener) {
  if (fallback) {
    try { listener({ ...fallback }); } catch { /* see fellBack */ }
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// A pass sent a mesh to the JS because the core declined it (not a fault).
export function countRefusedMesh() { refused++; }

export function setCoreEnabled(on) { enabled = !!on; }

const flagOff = () => globalThis.PARTFORGE_CORE === false || globalThis.PARTFORGE_CORE === "off";

// The live core, or null when disabled, unavailable or poisoned.
export function core() {
  if (!enabled || flagOff()) return null;
  if (booted === undefined) booted = boot();
  return booted;
}

// The instance `c` faulted (a trap, or an allocation that failed): never use it
// again in this realm. Objects still holding it check `c.poisoned` and fall back.
// `err` is what was thrown; only its category is kept (reasonOf).
export function poisonCore(c, err) {
  if (c) c.poisoned = true;
  if (booted === c || c == null) booted = null;
  fellBack("faulted", reasonOf(err));
}

// Drop `c` if its memory grew past RECYCLE_BYTES and nothing holds it (no live
// BVH); the next core() boots a fresh, small instance.
export function releaseIfIdle(c) {
  if (booted === c && c.live === 0 && c.x.memory.buffer.byteLength > RECYCLE_BYTES) booted = undefined;
}

// Tests only: install a stand-in instance (or undefined to re-boot), and forget
// any recorded fallback, refusal count and listeners.
export function setCoreForTesting(c) {
  booted = c;
  fallback = null;
  refused = 0;
  listeners.clear();
}

const B64 = (() => {
  const t = new Uint8Array(128);
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < a.length; i++) t[a.charCodeAt(i)] = i;
  return t;
})();
// Not atob: some JS hosts (an app's own JavaScriptCore context) have none.
function decodeBase64(s) {
  let n = s.length;
  while (n > 0 && s[n - 1] === "=") n--;
  const out = new Uint8Array((n * 3) >> 2);
  let o = 0;
  for (let i = 0; i < n; i += 4) {
    const v = (B64[s.charCodeAt(i)] << 18) | (B64[s.charCodeAt(i + 1)] << 12)
      | (i + 2 < n ? B64[s.charCodeAt(i + 2)] << 6 : 0) | (i + 3 < n ? B64[s.charCodeAt(i + 3)] : 0);
    out[o++] = v >> 16;
    if (i + 2 < n) out[o++] = (v >> 8) & 255;
    if (i + 3 < n) out[o++] = v & 255;
  }
  return out;
}

function boot() {
  if (typeof WebAssembly !== "object") {
    fellBack("unavailable", "no_webassembly");
    return null;
  }
  try {
    const stub = () => 0;
    // Synchronous on purpose: a pass asks mid-build and must get an answer now.
    // The module is small (well under every engine's synchronous-compile limit).
    const instance = new WebAssembly.Instance(new WebAssembly.Module(decodeBase64(CORE_WASM_BASE64)), {
      env: { emscripten_notify_memory_growth: () => {} },
      wasi_snapshot_preview1: { fd_close: stub, fd_write: stub, fd_seek: stub },
    });
    const x = instance.exports;
    x._initialize?.();
    // One 32-double scratch block for small inputs and outputs.
    const scratch = x.malloc(32 * 8);
    return {
      x,
      scratch,
      live: 0,         // core BVHs not yet disposed (they pin this instance)
      poisoned: false,
      // Never hands out 0: a failed malloc (memory exhausted) throws instead, so
      // nothing is ever written over the module's low memory.
      alloc(bytes) {
        const ptr = x.malloc(bytes || 1);
        if (!ptr) throw new Error(OUT_OF_MEMORY);
        return ptr;
      },
      // Views are rebuilt per use: any call that grows memory detaches the old buffer.
      f64: () => new Float64Array(x.memory.buffer, scratch, 32),
      copyIn(arr) {
        if (!arr || arr.length === 0) return 0;
        const ptr = this.alloc(arr.byteLength);
        new Uint8Array(x.memory.buffer, ptr, arr.byteLength).set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
        return ptr;
      },
      copyOut: (Ctor, ptr, len) => (ptr && len ? new Ctor(x.memory.buffer, ptr, len).slice() : new Ctor(0)),
    };
  } catch {
    fellBack("unavailable", "boot_failed");
    return null;
  }
}
