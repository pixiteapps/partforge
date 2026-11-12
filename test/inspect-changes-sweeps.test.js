// Change tracking and declared sweeps share one report deadline, and change tracking
// takes it first: a sweep that would spend the whole share must not leave the change
// report empty. The clock is stubbed and the sweep engine mocked to spend 10 s of it.
import { afterAll, beforeAll, expect, test, vi } from "vitest";

let clock = 1_000_000;
vi.mock("../src/framework/oracle/sweep.js", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    runSweeps: (...args) => {
      const rows = real.runSweeps(...args);
      clock += 10_000; // past the whole REPORT_SHARE_MS
      return rows;
    },
  };
});

const { bootManifoldKernel, handle } = await import("../src/testing.js");

let k, spy;
beforeAll(async () => {
  k = await bootManifoldKernel();
  spy = vi.spyOn(Date, "now").mockImplementation(() => clock);
});
afterAll(() => spy.mockRestore());

const blockPart = (w) => ({
  meta: { title: "changes + sweeps", units: "mm" },
  parameters: [{ id: "g", title: "G", description: "d", controls: [
    { key: "w", label: "Width", unit: "mm", min: 5, max: 40, step: 1, description: "block width" },
  ] }],
  defaults: { w },
  parts: { block: { label: "block", build: (kk, p) => kk.box({ min: [0, 0, 0], max: [p.w, 10, 10] }), views: { main: (s) => s } } },
  views: { main: { label: "Main" } },
  collisions: {},
  verify: { sweeps: { grow: { param: "w", range: [5, 40] } } },
});

const inspect = async (part, extra = {}) => {
  const posted = [];
  await handle(k, part, { type: "inspect", view: "main", params: {}, ...extra }, (m) => posted.push(m));
  return posted.find((m) => m.type === "report") ?? posted;
};

test("a change-tracked inspect still diffs when its sweeps would use the whole share", async () => {
  await inspect(blockPart(10), { changesKey: "share" });
  const r = await inspect(blockPart(20), { changesKey: "share" });
  expect(r.measure.sweeps).toHaveLength(1);
  expect(r.changesSkipped).toBeUndefined();
  expect(r.changes.subparts).toHaveLength(1);
  const [row] = r.changes.subparts;
  expect(row.name).toBe("block");
  expect(row.verdict).toBe("added");
  expect(row.addedMm3).toBeCloseTo(1000, 0);
}, 60_000);

// A sweep that moves nothing in the inspected view runs in the view where it does, inside
// the same report deadline: here the inspected view's sweeps spend the whole share, so the
// other view's row is a timeout, never a second budget.
test("a sweep run in another view shares the report's one deadline", async () => {
  const part = blockPart(10);
  const twoViews = {
    ...part,
    parts: { ...part.parts, stand: { label: "stand", build: (kk) => kk.box({ min: [0, 0, 0], max: [5, 5, 5] }), views: { flat: (s) => s } } },
    views: { flat: { label: "Flat" }, main: { label: "Main" } },
    verify: { ...part.verify, expect: { _view: { sweepContacts: 0 } } },
  };
  const r = await inspect(twoViews, { view: "flat" });
  expect(r.measure.sweeps).toEqual([]);
  const gate = r.verify.cases[0].checks.find((c) => c.metric === "sweepContacts");
  expect(gate.rows).toEqual([expect.objectContaining({ name: "grow", skipped: "timeout", view: "main" })]);
  expect(r.verify.ok).toBe(null);
}, 60_000);
