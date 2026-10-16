// If the SIMD build passes the validate probe but will not compile or
// instantiate, the core boots the scalar build instead of falling back to JS.
import { expect, test, vi } from "vitest";

vi.mock("../src/framework/core/core-wasm.js", async (orig) => {
  const real = await orig();
  return { ...real, CORE_WASM_SIMD_BASE64: "AAAAAAAAAAAAAAAA" }; // not a wasm module
});

import { core, coreStatus } from "../src/framework/core/core.js";

test("a SIMD build that fails to compile retries the scalar build", () => {
  const c = core();
  expect(c).not.toBeNull();
  expect(c.simd).toBe(false);
  expect(coreStatus().state).not.toBe("unavailable");
});
