// Drives runWorker() with a stubbed `self`/`postMessage` — no real Worker, but the
// real Manifold WASM boot and the real job loop. (Manifold-only: the OCCT test
// below never touches its kernel, so the two-backends-one-process rule holds.)
import { afterEach, expect, test, vi } from "vitest";
import { runWorker } from "../src/framework/worker.js";

// A metre-wide cylinder: the print tier sizes circles by chord tolerance (circle-segs.js)
// and a small radius facets identically at both tiers, so only a circle past the cap
// radius (~467 mm) still shows the 116 → 480 gap this test tells the kernels apart by.
const part = {
  defaults: {}, views: { v: { label: "V" } },
  parts: { a: { views: ["v"], build: (k) => k.cylinder({ r: 500, h: 10 }) } },
};

afterEach(() => { delete globalThis.self; delete globalThis.postMessage; });

function bootFakeWorker(name) {
  const posts = [];
  // Real WorkerGlobalScope exposes `self.navigator`; paper.js (pulled into the worker
  // module graph by text2d → curve-fill) reads `self.navigator.userAgent` for its
  // browser/OS detection, so the fake worker must provide it too.
  globalThis.self = { name, navigator: { userAgent: "node" } };
  globalThis.postMessage = (m) => posts.push(m);
  runWorker(part);
  return posts;
}

const stlTriangles = (dl) => new DataView(dl.parts[0].data).getUint32(80, true);

test("the manifold worker picks its kernel from msg.quality, not the job type", async () => {
  const posts = bootFakeWorker("manifold");
  // onmessage enqueues onto the worker's serial job pump and returns immediately
  // (a real WorkerGlobalScope ignores the handler's return value), so wait on the
  // posted results rather than awaiting the dispatch. Both exports still run —
  // only generates supersede each other.
  self.onmessage({ data: { type: "export-stl", view: "v", params: {} } }); // no quality → preview
  self.onmessage({ data: { type: "export-stl", view: "v", params: {}, quality: "print" } });
  const downloads = await vi.waitFor(() => {
    const d = posts.filter((m) => m.type === "download-parts");
    expect(d).toHaveLength(2);
    return d;
  }, { timeout: 30_000 });
  const [preview, print] = downloads.map(stlTriangles);
  expect(print).toBeGreaterThan(preview * 3); // at the cap radius print tessellates ~4× finer than preview
});

test("the occt worker announces ready at startup, before its kernel boots", () => {
  // mount gates the first generate on a ready message; if only the manifold worker
  // sends one, boot silently depends on both workers being spawned unconditionally.
  const posts = bootFakeWorker("occt");
  expect(posts).toContainEqual({ type: "ready" });
});
