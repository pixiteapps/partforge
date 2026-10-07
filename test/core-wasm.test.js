// The committed WebAssembly (src/framework/core/core-wasm.js) must have been built
// from the C++ in native/ as it stands: a C++ edit without a rebuild would ship the
// OLD core under the new source, and the parity test would be testing the wrong
// thing. This recomputes the source hash the build script stamps — no compiler needed.
//   Rebuild with: node scripts/build-core-wasm.mjs   (needs Emscripten's em++)
import { expect, test } from "vitest";
import { sourceHash } from "../scripts/build-core-wasm.mjs";
import { CORE_SOURCE_HASH } from "../src/framework/core/core-wasm.js";

test("core-wasm.js was built from the current native/ sources", () => {
  expect(CORE_SOURCE_HASH).toBe(sourceHash());
});
