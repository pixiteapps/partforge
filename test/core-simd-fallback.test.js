// If the SIMD build passes the validate probe but will not compile or
// instantiate, the core boots the scalar build instead of falling back to JS.
import { afterAll, expect, test } from "vitest";
import { core, coreStatus, setFullCoreForTesting } from "../src/framework/core/core.js";
import { CORE_FULL_WASM_BASE64 } from "../src/framework/core/core-full-wasm.js";

afterAll(() => setFullCoreForTesting(true));

test("a SIMD build that fails to compile retries the scalar build", async () => {
  await setFullCoreForTesting({ scalar: CORE_FULL_WASM_BASE64, simd: "AAAAAAAAAAAAAAAA" }); // simd: not a wasm module
  const c = core();
  expect(c).not.toBeNull();
  expect(c.full).toBe(true);
  expect(c.simd).toBe(false);
  expect(coreStatus().state).not.toBe("unavailable");
});
