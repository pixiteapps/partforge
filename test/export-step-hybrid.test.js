// A STEP export of a part with organic sub-parts runs in two legs: the Manifold worker
// meshes the organic sub-parts (mesh-subparts), then the OCCT worker writes the file with
// those meshes (export-step). Workers are faked: `send` records, replies go through
// handleMessage as a worker's would.
import { expect, test, vi } from "vitest";
import { createExportController } from "../src/framework/export-controller.js";

function setup(organic = ["grip"]) {
  const sent = [];
  const sink = vi.fn();
  const ctl = createExportController({
    send: (msg, backend) => sent.push({ msg, backend }),
    currentView: () => "all",
    title: () => "Hybrid",
    defaultBackend: () => "manifold",
    currentParams: () => ({ r: 5 }),
    organicFor: () => organic,
  });
  return { ctl, sent, reply: (m) => ctl.handleMessage(m, sink), sink };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const MESH = { positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0), indices: Uint32Array.of(0, 1, 2) };

test("organic sub-parts are meshed on Manifold first, then the file is written on OCCT", async () => {
  const { ctl, sent, reply } = setup();
  const progress = vi.fn();
  const done = ctl.exportParts({ format: "step", onProgress: progress });
  expect(sent).toHaveLength(1);
  expect(sent[0].backend).toBe("manifold");
  expect(sent[0].msg).toMatchObject({ type: "mesh-subparts", parts: ["grip"], view: "all", params: { r: 5 }, quality: "print" });
  expect(sent[0].msg.jobId).toMatch(/^mesh-\d+-\d+$/);

  reply({ type: "progress", phase: "meshing Grip", jobId: sent[0].msg.jobId });
  reply({ type: "subpart-meshes", jobId: sent[0].msg.jobId, meshes: { grip: MESH } });
  await flush();
  expect(sent).toHaveLength(2);
  expect(sent[1].backend).toBe("occt");
  expect(sent[1].msg).toMatchObject({ type: "export-step", view: "all", meshes: { grip: MESH } });

  reply({ type: "progress", phase: "writing STEP file", jobId: sent[1].msg.jobId });
  reply({ type: "download", data: new ArrayBuffer(4), filename: "hybrid.step", mime: "application/step", jobId: sent[1].msg.jobId });
  await expect(done).resolves.toBeUndefined();
  expect(progress.mock.calls.map((c) => c[0])).toEqual(["meshing Grip", "writing STEP file"]);
});

test("a STEP export with no organic sub-parts sends exactly today's single message", () => {
  const { ctl, sent } = setup([]);
  ctl.exportParts({ format: "step" });
  expect(sent).toHaveLength(1);
  expect(sent[0].backend).toBe("occt");
  expect(sent[0].msg.type).toBe("export-step");
  expect(sent[0].msg).not.toHaveProperty("meshes");
});

test("a failed meshing leg rejects and never sends export-step", async () => {
  const { ctl, sent, reply } = setup();
  const done = ctl.exportParts({ format: "step" });
  reply({ type: "error", message: "could not build Grip", jobId: sent[0].msg.jobId });
  await expect(done).rejects.toThrow("could not build Grip");
  await flush();
  expect(sent).toHaveLength(1);
});

test("an organic and shelled sub-part rejects before anything is sent", async () => {
  const sent = [];
  const ctl = createExportController({
    send: (msg, backend) => sent.push({ msg, backend }),
    currentView: () => "all", title: () => "T",
    organicFor: () => { throw new Error('"cup" calls k.implicit and shell'); },
  });
  await expect(ctl.exportParts({ format: "step" })).rejects.toThrow(/cup/);
  expect(sent).toEqual([]);
});

test("other formats never mesh first", () => {
  const { ctl, sent } = setup();
  ctl.exportParts({ format: "stl" });
  ctl.exportParts({ format: "3mf" });
  expect(sent.map((s) => s.msg.type)).toEqual(["export-stl", "export-3mf"]);
});
