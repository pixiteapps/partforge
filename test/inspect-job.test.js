import { describe, it, expect } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { handle } from "../src/framework/jobs.js";
import part from "../src/parts/planter.js";

describe("inspect job", () => {
  it("posts a report with measure + verify for the default view", async () => {
    const kernel = await bootManifoldKernel();
    const view = Object.keys(part.views)[0];
    const posts = [];
    await handle(kernel, part, { type: "inspect", view, params: {} }, (m) => posts.push(m));

    const report = posts.find((m) => m.type === "report");
    expect(report).toBeTruthy();
    expect(report.measure.subparts.length).toBeGreaterThan(0);
    expect(report.measure.subparts[0]).toHaveProperty("volume");
    expect(report.measure).toHaveProperty("overlaps");
    expect(report.verify).toHaveProperty("ok");
    expect(report.verify).toHaveProperty("failures");
  });
});

describe("inspect job handles", () => {
  it("carries the measure report's handles, and omits them for a part without any", async () => {
    const kernel = await bootManifoldKernel();
    const run = async (p) => {
      const posts = [];
      await handle(kernel, p, { type: "inspect", view: Object.keys(p.views)[0], params: {} }, (m) => posts.push(m));
      return posts.find((m) => m.type === "report");
    };
    const withHandles = { ...part, handles: { rim: { point: () => [1, 2, 3], params: ["dia"] } } };
    expect((await run(part)).measure).not.toHaveProperty("handles");
    const r = await run(withHandles);
    expect(r.measure.handles).toEqual([
      { id: "rim", label: "rim", kind: "point", point: [1, 2, 3], params: ["dia"], locked: false },
    ]);
  });
});
