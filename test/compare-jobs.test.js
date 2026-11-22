// The reference compare view's one-shot worker job: a sub-part and the sub-part its
// `reference` names, posed for one view, split into common / missing / excess meshes.
// Manifold-only (the OCCT kernel has no _compareSolids; "unsupported" is simulated).
import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { handle } from "../src/framework/jobs.js";
import { COMPARE_MAX_TRIANGLES } from "../src/framework/oracle/compare.js";

let kernel;
beforeAll(async () => { kernel = await bootManifoldKernel(); });

const run = async (k, part, msg) => {
  const posts = [];
  await handle(k, part, msg, (m, transfer) => posts.push({ m, transfer }));
  return posts;
};

// part = a 20×20×10 block plus a 10×5×5 tab; reference = the block plus a 4×4×4 boss.
const comparePart = (overrides = {}) => ({
  meta: { title: "t" },
  defaults: {},
  views: { main: {} },
  parts: {
    body: {
      views: ["main"],
      build: (k) => k.box({ size: [20, 20, 10] }).union(k.box({ size: [10, 5, 5] }).at([12, 0, 0])),
    },
    target: {
      views: ["main"],
      build: (k) => k.box({ size: [20, 20, 10] }).union(k.box({ size: [4, 4, 4] }).at([0, 0, 10])),
    },
    ...overrides,
  },
});

const msg = (extra = {}) => ({ type: "compare-generate", jobId: 41, name: "body", ref: "target", view: "main", params: {}, ...extra });

describe("compare-generate", () => {
  it("returns common, missing and excess meshes with their volumes", async () => {
    const posts = await run(kernel, comparePart(), msg());
    const { m, transfer } = posts.find((p) => p.m.type === "compare-meshes");
    expect(m.jobId).toBe(41);
    const { common, missing, excess } = m.pieces;
    expect(missing.mm3).toBeCloseTo(64, 3);
    // The tab spans x 7..17; the 7 past the block edge at x = 10 sticks out (7×5×5).
    expect(excess.mm3).toBeCloseTo(175, 3);
    expect(common.mm3).toBeCloseTo(4000, 3);
    for (const piece of [common, missing, excess]) {
      expect(piece.positions).toBeInstanceOf(Float32Array);
      expect(piece.normals).toBeDefined();
      expect(piece).toHaveProperty("indices"); // undefined for a triangle soup, as in a meshes reply
      expect(piece.edges).toBeDefined();
      expect(piece.triangles).toBeGreaterThan(0);
      expect(transfer).toContain(piece.positions.buffer);
    }
    expect(m.tolerance).toBeGreaterThan(0);
    expect(typeof m.ms).toBe("number");
    expect(m).not.toHaveProperty("offsetUsed");
  });

  it("an exact match has no missing or excess piece", async () => {
    const same = comparePart({ target: { views: ["main"], build: (k) => k.box({ size: [20, 20, 10] }).union(k.box({ size: [10, 5, 5] }).at([12, 0, 0])) } });
    const posts = await run(kernel, same, msg());
    const { m } = posts.find((p) => p.m.type === "compare-meshes");
    expect(m.pieces.missing).toBeNull();
    expect(m.pieces.excess).toBeNull();
    expect(m.pieces.common.mm3).toBeCloseTo(4175, 3);
  });

  it("passes the shared triangle ceiling and replies skipped: too-large", async () => {
    let asked;
    const tight = new Proxy(kernel, {
      get: (t, key) => key === "_compareSolids"
        ? (a, b, o) => { asked = o; return t._compareSolids(a, b, { ...o, maxTriangles: 10 }); }
        : t[key],
    });
    const posts = await run(tight, comparePart(), msg());
    expect(asked.maxTriangles).toBe(COMPARE_MAX_TRIANGLES);
    expect(asked.tolerance).toBeGreaterThan(0);
    expect(posts.map((p) => p.m)).toEqual([{ type: "compare-meshes", jobId: 41, skipped: "too-large" }]);
  });

  it("an empty sub-part replies skipped: not-closed", async () => {
    const empty = comparePart({ target: { views: ["main"], build: (k) => k.box({ size: [5, 5, 5] }).cut(k.box({ size: [10, 10, 10] })) } });
    const posts = await run(kernel, empty, msg());
    expect(posts.map((p) => p.m)).toEqual([{ type: "compare-meshes", jobId: 41, skipped: "not-closed" }]);
  });

  it("a kernel without _compareSolids replies skipped: unsupported", async () => {
    const occtLike = new Proxy(kernel, { get: (t, key) => (key === "_compareSolids" ? undefined : t[key]) });
    const posts = await run(occtLike, comparePart(), msg());
    expect(posts.map((p) => p.m)).toEqual([{ type: "compare-meshes", jobId: 41, skipped: "unsupported" }]);
  });

  it("a build error posts the worker's error reply with the jobId", async () => {
    const broken = comparePart({ target: { views: ["main"], build: () => { throw new Error("boom"); } } });
    const posts = await run(kernel, broken, msg());
    const err = posts.find((p) => p.m.type === "error");
    expect(err.m.jobId).toBe(41);
    expect(err.m.message).toMatch(/boom/);
    expect(posts.some((p) => p.m.type === "compare-meshes")).toBe(false);
  });
});
