// test/export-mount-wiring.test.js
// mount() needs DOM+WASM, so we test the wiring seam: onWorkerMessage must give
// the controller first refusal on jobId-tagged messages. We reproduce that seam.
import { expect, test, vi } from "vitest";
import { createExportController } from "../src/framework/export-controller.js";

test("controller consumes jobId messages; legacy path handles the rest", () => {
  const sent = [];
  const ctl = createExportController({ send: (m) => sent.push(m), currentView: () => "all", title: () => "T" });
  const sink = vi.fn();
  const legacy = vi.fn();

  // simulate mount's onWorkerMessage dispatch:
  const onMessage = (data) => { if (!ctl.handleMessage(data, sink)) legacy(data); };

  ctl.exportParts({ parts: ["a"], format: "stl", onProgress: vi.fn() });
  const { jobId } = sent[0];
  onMessage({ type: "progress", phase: "x", jobId });          // consumed
  onMessage({ type: "meshes", triangles: 1 });                  // legacy
  onMessage({ type: "download-parts", parts: [{ name: "a", data: new ArrayBuffer(2) }], ext: "stl", mime: "model/stl", jobId });
  expect(legacy).toHaveBeenCalledTimes(1);
  expect(legacy).toHaveBeenCalledWith(expect.objectContaining({ type: "meshes" }));
  expect(sink).toHaveBeenCalledTimes(1);
});

// A host that keeps one worker across mounts (partforge-cloud's pool rebinds
// it with setPart) hands a DISPOSED mount's late replies to whichever mount is
// listening now. Exports are never epoch-guarded (KERNEL-CONTRACT), so a slow
// export sent before an edit still answers after it. That reply must not settle
// the new mount's own export, which would report pre-edit geometry as the
// retry's file, and it must not reach the new mount's legacy switch, which
// reads an "error" as a failed build and a "download" as a viewbar save.
test("a disposed mount's late export replies neither settle a later mount's export nor reach its legacy switch", async () => {
  const mount = () => {
    const sent = [];
    const ctl = createExportController({ send: (m) => sent.push(m), currentView: () => "all", title: () => "T" });
    return { ctl, sent };
  };
  const step = (jobId, filename) => ({ type: "download", data: new ArrayBuffer(2), filename, mime: "application/step", jobId });

  // Mount A starts a STEP export, then an edit remounts: A is disposed, its
  // export rejected, and the worker keeps running A's job.
  const a = mount();
  a.ctl.exportParts({ parts: ["a"], format: "step", onProgress: vi.fn() }).catch(() => {});
  a.ctl.warmKernel();
  const [staleExport, staleWarm] = a.sent.map((m) => m.jobId);
  a.ctl.dispose("viewer disposed");

  // Mount B hears the same worker. The user retries the export.
  const b = mount();
  const sink = vi.fn();
  const legacy = vi.fn();
  const onMessage = (data) => { if (!b.ctl.handleMessage(data, sink)) legacy(data); };
  let retried = false;
  const retry = b.ctl.exportParts({ parts: ["a"], format: "step", onProgress: vi.fn() }).then(() => { retried = true; });

  // A's late replies arrive first.
  onMessage({ type: "progress", phase: "loading exact kernel", jobId: staleExport });
  onMessage(step(staleExport, "before-the-edit.step"));
  onMessage({ type: "error", message: "stale failure", jobId: staleExport });
  onMessage({ type: "kernel-warm", jobId: staleWarm });
  await Promise.resolve();
  expect(retried).toBe(false);
  expect(sink).not.toHaveBeenCalled();
  expect(legacy).not.toHaveBeenCalled();

  // B's own reply settles B's export with B's file.
  onMessage(step(b.sent[0].jobId, "after-the-edit.step"));
  await retry;
  expect(retried).toBe(true);
  expect(sink).toHaveBeenCalledTimes(1);
  expect(sink.mock.calls[0][0].filename).toBe("after-the-edit.step");
});

// Fix round (task-9 review): a needs-import-mesh reply for an export job's own
// jobId (e.g. a STEP export of a part with an unprimed STEP import) must be
// consumed by the controller here, never reaching mount's live-loop legacy
// path — that path treats needs-import-mesh as a live crossover signal
// (loop.buildDone(), a tessellate-imports request) which would be wrong for a
// build the live regen loop never dispatched.
test("controller consumes needs-import-mesh for its own jobId; legacy path never sees it", async () => {
  const sent = [];
  const ctl = createExportController({ send: (m) => sent.push(m), currentView: () => "all", title: () => "T" });
  const sink = vi.fn();
  const legacy = vi.fn();
  const onMessage = (data) => { if (!ctl.handleMessage(data, sink)) legacy(data); };

  const done = ctl.exportParts({ parts: ["a"], format: "step", onProgress: vi.fn() });
  done.catch(() => {}); // rejection is expected and asserted below
  const { jobId } = sent[0];
  onMessage({ type: "needs-import-mesh", jobId, subparts: ["a"] });

  expect(legacy).not.toHaveBeenCalled();
  await expect(done).rejects.toThrow(/STEP import needs tessellation/);
});
