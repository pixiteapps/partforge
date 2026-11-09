// The occt worker's half of test/worker-boot-retry.test.js: it boots lazily, on its
// first job, and a failed boot must be forgotten there too. The kernel is a stand-in
// (warm-kernel only needs to reach handle()), so no OCCT boots here.
import { afterEach, expect, test, vi } from "vitest";

let failures = 0;
let boots = 0;
vi.mock("replicad-opencascadejs/src/replicad_single.js", () => ({
  default: async () => {
    boots++;
    if (failures > 0) {
      failures--;
      throw new Error("WebAssembly compilation aborted: Network error");
    }
    return {};
  },
}));
vi.mock("replicad-opencascadejs/src/replicad_single.wasm?url", () => ({ default: "occt.wasm" }));
vi.mock("replicad", () => ({ setOC: () => {} }));
vi.mock("../src/framework/geometry/occt-backend.js", () => ({ createOcctKernel: () => ({}) }));

import { runWorker } from "../src/framework/worker.js";

const part = { defaults: {}, views: { v: { label: "V" } }, parts: {} };

afterEach(() => { delete globalThis.self; delete globalThis.postMessage; failures = 0; boots = 0; });

test("the occt worker boots again on the job after a failed boot, and keeps the kernel once up", async () => {
  failures = 1;
  const posts = [];
  globalThis.self = { name: "occt", navigator: { userAgent: "node" } };
  globalThis.postMessage = (m) => posts.push(m);
  runWorker(part);
  expect(boots).toBe(0); // lazy: nothing boots before a job asks

  const warm = (jobId) => self.onmessage({ data: { type: "warm-kernel", jobId } });
  const reply = (type, jobId) => vi.waitFor(() => {
    const m = posts.find((p) => p.type === type && p.jobId === jobId);
    expect(m).toBeTruthy();
    return m;
  });

  warm("a");
  expect((await reply("error", "a")).message).toMatch(/Network error/);
  warm("b");
  await reply("kernel-warm", "b");
  expect(boots).toBe(2);
  warm("c");
  await reply("kernel-warm", "c");
  expect(boots).toBe(2);
});
