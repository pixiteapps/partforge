// The native core: native/*.cpp compiled to WebAssembly (built by
// scripts/build-core-wasm.mjs), instantiated lazily and synchronously the first
// time a pass asks for it.
//
// Two builds, one instance at a time:
//   BASE (core-wasm.js, imported statically below)  creased normals and the BVH.
//       Small, and what every part's first load downloads.
//   FULL (core-full-wasm.js, imported on demand by loadFullCore)  the base passes
//       plus the implicit engine, scalar and SIMD. Only a part that calls
//       k.implicit needs it: the worker's job loop loads it at the first k.implicit
//       call and runs the job again (jobs.js, NEEDS_FULL_CORE below); Node callers
//       load it up front (CLI, partforge/testing).
// core() boots the full build once its bytes are here, else the base build; a base
// instance is replaced by a full one as soon as nothing holds it. An instance says
// which it is (`c.full`), and the implicit engine takes only a full one. Until
// then its JS answers, with the same bytes, and asks for the load so the next
// build has it — or, where the caller said it can load and retry
// (core-status.js setFullCoreRequired), the call throws NEEDS_FULL_CORE.
//
// What it runs — each a bit-exact port of a JS pass, which stays as the
// fallback:
//   creasedNormals          geometry/creased-normals.js (+ blend-surfaces.js)
//   the oracle's BVH        oracle/bvh.js, via cachedBVH (+ min-wall.js)
//   the implicit engine     implicit/*: sample, mesh, project, cleanup and detail
//                           sessions (core/implicit-core.js; native/implicit_*.cpp)
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
import { fullCoreRequired, NEEDS_FULL_CORE, recordFallback, resetCoreStatus, setStateProbe } from "./core-status.js";

export { CORE_FALLBACK_REASONS, coreStatus, countRefusedMesh, onCoreFallback, NEEDS_FULL_CORE, setFullCoreRequired } from "./core-status.js";

// What the core may keep holding between passes. Ordinary forges never grow it
// past its 16 MB start; a preview mesh needs ~145 bytes/triangle at the peak
// (screw, 210k triangles: 29 MB; a 1M-triangle mesh: 138 MB). Re-booting costs a
// few milliseconds — so cap the retained memory low.
// Implicit sessions grow it too (~88 MB at the 0.5 mm hand); the instance is
// recycled once the sessions are destroyed and it is idle (releaseIfIdle).
export const RECYCLE_BYTES = 64 * 1024 * 1024;

let enabled = true;
let booted; // undefined: not tried yet (or recycled); null: unavailable or poisoned
// The full build's bytes once loadFullCore has them: { scalar, simd } base64.
let fullWasm = null;
let fullLoading = null;
let fullFailed = false; // the import was tried and failed: the JS engine is this realm's answer
export const OUT_OF_MEMORY = "partforge core: out of WebAssembly memory";

function reasonOf(err) {
  if (err?.message === OUT_OF_MEMORY) return "out_of_memory";
  if (typeof WebAssembly === "object" && err instanceof WebAssembly.RuntimeError) return "trap";
  return "error";
}

// The live answer for coreStatus() (core-status.js) while nothing has failed.
setStateProbe(() => (!enabled || flagOff() ? "off" : booted ? "on" : "idle"));

export function setCoreEnabled(on) { enabled = !!on; }

const flagOff = () => globalThis.PARTFORGE_CORE === false || globalThis.PARTFORGE_CORE === "off";

// A base instance is stale once the full build's bytes are here. (`full === false`
// exactly: a test's stand-in instance says nothing, and must not be swapped out.)
const outgrown = (c) => fullWasm !== null && c.full === false;

// The live core, or null when disabled, unavailable or poisoned.
export function core() {
  if (!enabled || flagOff()) return null;
  if (booted && outgrown(booted) && booted.live === 0) booted = undefined;
  if (booted === undefined) booted = boot();
  return booted;
}

// The live core when it is the FULL build (the implicit engine's exports), else
// null: disabled, unavailable, poisoned, or the full build is not loaded. Not loaded
// YET (never tried, or still on its way) throws NEEDS_FULL_CORE where the caller asked
// for that (setFullCoreRequired: it loads the build and runs the work again);
// otherwise this asks for the load, so a later build finds it. A base instance
// something still holds (a live BVH) also answers null, until it is released.
export function fullCore() {
  const c = core();
  if (c && c.full === false && fullWasm === null && !fullFailed) {
    if (fullCoreRequired()) {
      throw Object.assign(new Error("implicit: the native core's full build is not loaded yet — await loadFullCore() and build again"), { code: NEEDS_FULL_CORE });
    }
    void loadFullCore();
  }
  return c && c.full !== false ? c : null;
}

// Load the full build (core-full-wasm.js: the implicit engine). Resolves true once
// core() can boot it, false when it could not be loaded (a host that cannot resolve
// the import — the implicit engine then keeps its JS, with identical output).
// Idempotent; never rejects. Call it before building a part that uses k.implicit.
// (Line comments on purpose: this file's header says `native/*.cpp`, which the
// layering tests' comment stripper pairs with the next block-comment end.)
export function loadFullCore() {
  if (fullWasm !== null) return Promise.resolve(true);
  return (fullLoading ??= import("./core-full-wasm.js").then((m) => {
    fullWasm = { scalar: m.CORE_FULL_WASM_BASE64, simd: m.CORE_FULL_WASM_SIMD_BASE64 };
    return true;
  }, () => { fullFailed = true; return false; }));
}

// Whether the full build's bytes are loaded (loadFullCore has resolved true).
export const fullCoreLoaded = () => fullWasm !== null;

// The instance `c` faulted (a trap, or an allocation that failed): never use it
// again in this realm. Objects still holding it check `c.poisoned` and fall back.
// `err` is what was thrown; only its category is kept (reasonOf).
export function poisonCore(c, err) {
  if (c) c.poisoned = true;
  if (booted === c || c == null) booted = null;
  recordFallback("faulted", reasonOf(err));
}

// Drop `c` if its memory grew past RECYCLE_BYTES, or it is a base instance and the
// full build has since loaded, and nothing holds it (no live BVH); the next core()
// boots a fresh, small instance.
export function releaseIfIdle(c) {
  if (booted === c && c.live === 0 && (c.x.memory.buffer.byteLength > RECYCLE_BYTES || outgrown(c))) booted = undefined;
}

// Tests only: install a stand-in instance (or undefined to re-boot), and forget
// any recorded fallback, refusal count and listeners.
export function setCoreForTesting(c) {
  booted = c;
  resetCoreStatus();
}

// Tests only: forget the full build's bytes (false: a realm that never loaded them),
// wait for them again (true), install stand-in bytes ({ scalar, simd } base64), or
// stand as a realm whose load failed ("failed"). The live instance is dropped either way.
export async function setFullCoreForTesting(loaded) {
  fullWasm = loaded && typeof loaded === "object" ? loaded : null;
  fullLoading = loaded === "failed" ? Promise.resolve(false) : null;
  fullFailed = loaded === "failed";
  booted = undefined;
  if (loaded === true) await loadFullCore();
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

// The smallest module using wasm SIMD (a function returning i8x16.popcnt of a
// splat): an engine that validates it runs the SIMD build of the core.
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

// Which FULL build to boot: the SIMD one (the same bits, faster lane loops — see
// scripts/build-core-wasm.mjs) unless the engine lacks wasm SIMD or
// globalThis.PARTFORGE_CORE_SIMD === false (tests; read at each boot). The base
// build is scalar only.
function wantSimd() {
  if (globalThis.PARTFORGE_CORE_SIMD === false) return false;
  try { return WebAssembly.validate(SIMD_PROBE); } catch { return false; }
}

function instantiate(full, simd) {
  const stub = () => 0;
  // Synchronous on purpose: a pass asks mid-build and must get an answer now.
  const bytes = decodeBase64(full ? (simd ? full.simd : full.scalar) : CORE_WASM_BASE64);
  return new WebAssembly.Instance(new WebAssembly.Module(bytes), {
    env: { emscripten_notify_memory_growth: () => {} },
    wasi_snapshot_preview1: { fd_close: stub, fd_write: stub, fd_seek: stub },
  });
}

function boot() {
  if (typeof WebAssembly !== "object") {
    recordFallback("unavailable", "no_webassembly");
    return null;
  }
  try {
    const full = fullWasm; // the bytes this instance is built from (null: the base build)
    let simd = full !== null && wantSimd();
    let instance;
    try {
      instance = instantiate(full, simd);
    } catch (err) {
      // The probe passed but the SIMD build would not compile or instantiate:
      // the scalar build has the same bits, so try it once before giving up.
      if (!simd) throw err;
      simd = false;
      instance = instantiate(full, false);
    }
    const x = instance.exports;
    x._initialize?.();
    // One 32-double scratch block for small inputs and outputs.
    const scratch = x.malloc(32 * 8);
    return {
      x,
      full: full !== null, // the full build (the implicit engine's exports), not the base one
      simd,            // a full instance's variant (true: CORE_FULL_WASM_SIMD_BASE64)
      scratch,
      live: 0,         // core BVHs not yet disposed and implicit sessions not yet destroyed (both pin this instance)
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
    recordFallback("unavailable", "boot_failed");
    return null;
  }
}
