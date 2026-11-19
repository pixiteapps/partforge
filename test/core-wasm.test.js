// The committed WebAssembly (src/framework/core/core-wasm.js, core-full-wasm.js) must have been built
// from the C++ in native/ as it stands: a C++ edit without a rebuild would ship the
// OLD core under the new source, and the parity test would be testing the wrong
// thing. This recomputes the source hash the build script stamps — no compiler needed.
//   Rebuild with: node scripts/build-core-wasm.mjs   (needs Emscripten's em++)
import { expect, test } from "vitest";
import { sourceHash } from "../scripts/build-core-wasm.mjs";
import { CORE_SOURCE_HASH, CORE_WASM_BASE64 } from "../src/framework/core/core-wasm.js";
import { CORE_FULL_SOURCE_HASH } from "../src/framework/core/core-full-wasm.js";

test("core-wasm.js and core-full-wasm.js were built from the current native/ sources", () => {
  expect(CORE_SOURCE_HASH).toBe(sourceHash());
  expect(CORE_FULL_SOURCE_HASH).toBe(sourceHash());
});

// Every worker downloads the base build before its first preview, whatever the part. It
// was 100 KB of WebAssembly when the implicit engine was split out of it (the full build
// is three times that, twice over). A new native pass that only some parts need belongs
// in the full build, or in a module of its own — not here.
test("the base build stays small", () => {
  expect(CORE_WASM_BASE64.length * 3 / 4).toBeLessThan(140_000);
});
