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
// (exported from partforge/oracle and partforge/testing) or
// `globalThis.PARTFORGE_CORE = false` before the first build turns it off for
// that realm — a worker is its own realm, so a host sets it there. If the module
// cannot be instantiated at all the passes quietly keep their JS.
import { CORE_WASM_BASE64 } from "./core-wasm.js";

let enabled = !(globalThis.PARTFORGE_CORE === false || globalThis.PARTFORGE_CORE === "off");
let booted; // undefined: not tried yet; null: unavailable

export function setCoreEnabled(on) { enabled = !!on; }

// The live core, or null when disabled or unavailable.
export function core() {
  if (!enabled) return null;
  if (booted === undefined) booted = boot();
  return booted;
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
  if (typeof WebAssembly !== "object") return null;
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
      // Views are rebuilt per use: any call that grows memory detaches the old buffer.
      f64: () => new Float64Array(x.memory.buffer, scratch, 32),
      copyIn(arr) {
        if (!arr || arr.length === 0) return 0;
        const ptr = x.malloc(arr.byteLength);
        new Uint8Array(x.memory.buffer, ptr, arr.byteLength).set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
        return ptr;
      },
      copyOut: (Ctor, ptr, len) => (ptr && len ? new Ctor(x.memory.buffer, ptr, len).slice() : new Ctor(0)),
    };
  } catch {
    return null;
  }
}
