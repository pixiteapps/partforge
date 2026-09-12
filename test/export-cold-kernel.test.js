// The cold OCCT boot as it is seen from OUTSIDE the worker.
//
// STEP is the one format pinned to the exact kernel (backendForFormat), so for a
// part whose preview ran on Manifold the STEP export is the first OCCT job of the
// session and pays the whole ~11 MB WASM boot inside the export. Two things have
// to be true for a host to survive that honestly:
//
//   1. the boot's progress message must be CORRELATED, or a headless
//      exportParts() caller (partforge-cloud's export modal) shows a frozen
//      "Starting…" for the entire boot and then reports a timeout with no clue
//      what it was waiting on; and
//   2. a host must be able to trigger the boot BEFORE the export, so the wait
//      lands somewhere the user has not just asked for a file.
//
// Neither test boots OCCT for real: (1) asserts the message posted immediately
// before the boot starts, and (2) exercises the job branch on a Manifold kernel,
// since the branch's whole job is to be reached only after kernelFor() resolved.
import { expect, test, vi } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { handle } from "../src/framework/jobs.js";

const part = {
  meta: { title: "T" },
  defaults: { h: 10 },
  parts: { body: { views: ["main"], build: (k, p) => k.box({ size: [p.h, p.h, p.h] }) } },
  views: { main: { label: "Main" } },
};

// Fake WorkerGlobalScope named "occt" — the lint-worker.test.js pattern. The
// export below does start the real occtKernel() import; we never await it.
async function bootOcctWorker() {
  const posted = [];
  const self = {
    name: "occt",
    navigator: { userAgent: "node" },
    onmessage: null,
    postMessage: (m) => posted.push(m),
  };
  vi.stubGlobal("self", self);
  vi.stubGlobal("postMessage", self.postMessage);
  const { runWorker } = await import("../src/framework/worker.js");
  runWorker(part);
  return { self, posted };
}

const bootProgress = (posted) =>
  posted.find((m) => m.type === "progress" && /exact kernel/.test(m.phase ?? ""));

test("the cold-boot progress carries the job's jobId, so a headless export can show it", async () => {
  const { self, posted } = await bootOcctWorker();
  self.onmessage({ data: { type: "export-step", jobId: 7, view: "main", params: {} } });
  const progress = await vi.waitFor(() => {
    const m = bootProgress(posted);
    expect(m).toBeDefined();
    return m;
  });
  // Without this, createExportController.handleMessage drops the message (it
  // only claims replies carrying a jobId) and onProgress never fires.
  expect(progress.jobId).toBe(7);
});

test("an uncorrelated job's cold-boot progress still carries no jobId", async () => {
  // The in-page export buttons send no jobId, and their progress must keep
  // reaching mount's own `case "progress"` busy indicator rather than being
  // claimed by an export controller that has nothing pending.
  const { self, posted } = await bootOcctWorker();
  self.onmessage({ data: { type: "export-step", view: "main", params: {} } });
  const progress = await vi.waitFor(() => {
    const m = bootProgress(posted);
    expect(m).toBeDefined();
    return m;
  });
  expect(progress).not.toHaveProperty("jobId");
});

test("warm-kernel answers with kernel-warm, correlated by jobId", async () => {
  // The job body does nothing on purpose: reaching it at all is the signal,
  // because worker.js awaits kernelFor() before handle() ever runs.
  const kernel = await bootManifoldKernel(part);
  const posted = [];
  await handle(kernel, part, { type: "warm-kernel", jobId: "warm-1" }, (m) => posted.push(m));
  expect(posted).toEqual([{ type: "kernel-warm", jobId: "warm-1" }]);
});

// --- the host-facing warm, as mount wires it -------------------------------
// mount() needs DOM+WASM, so this reproduces the same seam export-mount-wiring
// does: the controller gets first refusal on correlated replies, and warm rides
// that correlation like an export does.
import { createExportController } from "../src/framework/export-controller.js";

const controller = () => {
  const sent = [];
  const ctl = createExportController({
    send: (m, backend) => sent.push({ ...m, backend }),
    currentView: () => "all",
    title: () => "T",
    defaultBackend: () => "manifold",
  });
  return { ctl, sent };
};

test("warmKernel routes to OCCT even when the preview backend is Manifold", () => {
  const { ctl, sent } = controller();
  ctl.warmKernel();
  expect(sent).toHaveLength(1);
  // The whole point: a Manifold-previewed part is exactly the one whose STEP
  // export pays the cold boot, so warming must follow backendForFormat("step").
  expect(sent[0]).toMatchObject({ type: "warm-kernel", backend: "occt" });
});

test("warmKernel resolves on its own kernel-warm and is never claimed by an export", async () => {
  const { ctl, sent } = controller();
  const legacy = vi.fn();
  const onMessage = (data) => { if (!ctl.handleMessage(data, vi.fn())) legacy(data); };

  const warm = ctl.warmKernel();
  const exportDone = ctl.exportParts({ parts: ["a"], format: "step", onProgress: vi.fn() });
  const warmJob = sent.find((m) => m.type === "warm-kernel");
  const exportJob = sent.find((m) => m.type === "export-step");
  // String-namespaced ids ("warm-N") cannot collide with the export controller's
  // plain numeric ones — the mount.js tessellate-imports lesson.
  expect(typeof warmJob.jobId).toBe("string");
  expect(typeof exportJob.jobId).toBe("number");

  onMessage({ type: "kernel-warm", jobId: warmJob.jobId });
  await expect(warm).resolves.toBe(true);
  expect(legacy).not.toHaveBeenCalled(); // consumed by the controller, not mount's switch

  onMessage({ type: "download", data: new ArrayBuffer(2), filename: "t.step", mime: "application/step", jobId: exportJob.jobId });
  await expect(exportDone).resolves.toBeUndefined();
});

test("a warm that dies with the worker resolves false rather than rejecting", async () => {
  // Warming is best-effort: it is a speculative download the host fires on a
  // dialog opening, and a host must never have to guard it to avoid an
  // unhandled rejection on teardown.
  const { ctl } = controller();
  const warm = ctl.warmKernel();
  ctl.dispose("viewer disposed");
  await expect(warm).resolves.toBe(false);
});

test("a failed warm resolves false and leaves exports unaffected", async () => {
  const { ctl, sent } = controller();
  const onMessage = (data) => ctl.handleMessage(data, vi.fn());
  const warm = ctl.warmKernel();
  onMessage({ type: "error", message: "wasm 404", jobId: sent[0].jobId });
  await expect(warm).resolves.toBe(false);
});
