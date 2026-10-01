// The kit's hop through the export controller (contract §8.1): `options` rides the
// worker message for any format whenever the caller gave one, and is absent otherwise;
// the kit's reply is an ordinary single-file download, and its failure an ordinary error.
import { expect, test, vi } from "vitest";
import { createExportController } from "../src/framework/export-controller.js";

function setup() {
  const sent = [];
  const ctl = createExportController({
    send: (msg, backend) => sent.push({ msg, backend }),
    currentView: () => "all",
    title: () => "Box",
    currentParams: () => ({ t: 3 }),
  });
  return { ctl, sent };
}

test("a kit export sends export-bundle, with its options, on the preview backend", () => {
  const { ctl, sent } = setup();
  const options = { destination: "service", kerf: 0.15, stock: [{ group: "*", size: [300, 300] }] };
  ctl.exportParts({ parts: ["front"], format: "bundle", options, onProgress: vi.fn() });
  expect(sent).toHaveLength(1);
  expect(sent[0].backend).toBe("manifold");
  expect(sent[0].msg.jobId).toMatch(/^export-\d+-\d+$/);
  expect(sent[0].msg).toMatchObject({ type: "export-bundle", parts: ["front"], view: "all",
    params: { t: 3 }, name: "Box", quality: "print", options });
});

test("no options key at all when the caller passed none", () => {
  const { ctl, sent } = setup();
  ctl.exportParts({ parts: ["front"], format: "stl", onProgress: vi.fn() });
  expect("options" in sent[0].msg).toBe(false);
});

test("options ride any format when given; only the kit reads them", () => {
  const { ctl, sent } = setup();
  ctl.exportParts({ parts: ["front"], format: "3mf", options: { sets: 2 }, onProgress: vi.fn() });
  expect(sent[0].msg).toMatchObject({ type: "export-3mf", options: { sets: 2 } });
});

test("the kit's zip reaches the sink and settles the export", async () => {
  const { ctl, sent } = setup();
  const sink = vi.fn();
  const done = ctl.exportParts({ parts: ["front"], format: "bundle", options: {}, onProgress: vi.fn() });
  const { jobId } = sent[0].msg;
  const data = new Uint8Array([80, 75, 3, 4]);
  expect(ctl.handleMessage({ type: "download", data, filename: "box-kit.zip", mime: "application/zip", jobId }, sink)).toBe(true);
  expect(sink).toHaveBeenCalledWith({ data, filename: "box-kit.zip", mime: "application/zip" });
  await expect(done).resolves.toBeUndefined();
});

test("a cut kit options error rejects with the worker's message verbatim", async () => {
  const { ctl, sent } = setup();
  const done = ctl.exportParts({ parts: ["front"], format: "bundle", options: { kerf: 2 }, onProgress: vi.fn() });
  const { jobId } = sent[0].msg;
  ctl.handleMessage({ type: "error", message: "cut kit options: kerf must be a number from 0 to 0.5 mm, got 2", jobId }, vi.fn());
  await expect(done).rejects.toThrow("cut kit options: kerf must be a number from 0 to 0.5 mm, got 2");
});
