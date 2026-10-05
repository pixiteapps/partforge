import { beforeAll, expect, test, vi } from "vitest";
import * as bedLayoutModule from "../src/framework/export/bed-layout.js";
import { bootManifoldKernel } from "../src/testing.js";
import { handle } from "../src/framework/jobs.js";

let k;
const part = {
  meta: { title: "Two Piece" },
  defaults: {},
  parts: {
    a: { label: "A", views: ["all"], export: { name: "a" }, build: (kk) => kk.box({ size: [10, 10, 10] }) },
    b: { label: "B", views: ["all"], export: { name: "b" }, build: (kk) => kk.box({ size: [8, 8, 8] }).translate([20, 0, 0]) },
    ghost: { label: "G", views: ["all"], exportable: false, build: (kk) => kk.box({ size: [5, 5, 5] }) },
  },
  views: { all: { label: "All" } },
};
beforeAll(async () => { k = await bootManifoldKernel(); });

const run = async (msg) => { const posts = []; await handle(k, part, msg, (m) => posts.push(m)); return posts; };

test("export-stl honors explicit parts and echoes jobId", async () => {
  const posts = await run({ type: "export-stl", parts: ["a"], params: {}, jobId: 7, quality: "print" });
  const dl = posts.find((m) => m.type === "download-parts");
  expect(dl.jobId).toBe(7);
  expect(dl.parts.map((p) => p.name)).toEqual(["a"]);
});

test("explicit parts filter out exportable:false and unknown names", async () => {
  const posts = await run({ type: "export-stl", parts: ["a", "ghost", "nope"], params: {}, jobId: 8 });
  const dl = posts.find((m) => m.type === "download-parts");
  expect(dl.parts.map((p) => p.name)).toEqual(["a"]);
});

test("empty resolved selection posts an error carrying jobId", async () => {
  const posts = await run({ type: "export-stl", parts: ["ghost"], params: {}, jobId: 9 });
  const err = posts.find((m) => m.type === "error");
  expect(err).toBeTruthy();
  expect(err.jobId).toBe(9);
});

test("progress messages carry jobId", async () => {
  const posts = await run({ type: "export-stl", parts: ["a"], params: {}, jobId: 5 });
  const prog = posts.filter((m) => m.type === "progress");
  expect(prog.length).toBeGreaterThan(0);
  expect(prog.every((m) => m.jobId === 5)).toBe(true);
});

const mapPart = {
  meta: { title: "Map Pieces" },
  defaults: {},
  parts: {
    a: { label: "A", views: { all: true }, export: { name: "a" }, build: (kk) => kk.box({ size: [10, 10, 10] }) },
    b: { label: "B", views: { all: true }, export: { name: "b" }, build: (kk) => kk.box({ size: [8, 8, 8] }) },
    legacy: { label: "L", views: ["all"], export: { name: "legacy" }, build: (kk) => kk.box({ size: [4, 4, 4] }).translate([0, 0, 30]) },
  },
  views: { all: { label: "All" } },
};

test("3MF and STEP lay out map-form pieces apart and leave legacy pieces where they are", async () => {
  const real = bedLayoutModule.layoutExportPieces;
  let boxes, names;
  // Solids are disposed when the job ends, so read the laid-out boxes inside the call.
  const spy = vi.spyOn(bedLayoutModule, "layoutExportPieces").mockImplementation((pt, pieces) => {
    const laid = real(pt, pieces);
    names = pieces.map((pc) => pc.name);
    boxes = Object.fromEntries(laid.map((pc) => [pc.name, pc.solid.boundingBox()]));
    return laid;
  });
  try {
  for (const type of ["export-3mf", "export-step"]) {
    spy.mockClear();
    const posts = [];
    // The Manifold test kernel has no STEP writer; the layout runs before it is called.
    const kern = type === "export-step" ? Object.create(k, { toSTEP: { value: async () => new Uint8Array(4) } }) : k;
    await handle(kern, mapPart, { type, parts: ["a", "b", "legacy"], params: {}, jobId: 1, view: "all" }, (m) => posts.push(m));
    expect(posts.find((m) => m.type === "download")).toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(1);
    const box = (name) => boxes[name];
    const [ba, bb] = [box("a"), box("b")];
    expect(ba.max[0] <= bb.min[0] || bb.max[0] <= ba.min[0] || ba.max[1] <= bb.min[1] || bb.max[1] <= ba.min[1]).toBe(true);
    expect(box("legacy").min[2]).toBeCloseTo(30, 6);
    expect(names).toEqual(["a", "b", "legacy"]);
  }
  } finally { spy.mockRestore(); }
});

test("STL is never laid out", async () => {
  const spy = vi.spyOn(bedLayoutModule, "layoutExportPieces");
  const posts = [];
  await handle(k, mapPart, { type: "export-stl", parts: ["a", "b"], params: {}, jobId: 2 }, (m) => posts.push(m));
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});
