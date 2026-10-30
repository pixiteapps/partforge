import { beforeAll, expect, test, vi } from "vitest";
import { strFromU8, unzipSync } from "fflate";
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

test("STEP lays out map-form pieces apart and leaves legacy pieces where they are", async () => {
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
  for (const type of ["export-step"]) {
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

// The 3MF export frees each piece once it is meshed and lays the meshes out from their
// bounds (feedback #212), so its layout is checked in the file it writes.
const objectBoxes = (data) => {
  const xml = strFromU8(unzipSync(new Uint8Array(data))["3D/3dmodel.model"]);
  return Object.fromEntries([...xml.matchAll(/<object [^>]*name="([^"]+)"[^>]*>(.*?)<\/object>/g)].map(([, name, body]) => {
    const v = [...body.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)].map((m) => m.slice(1).map(Number));
    return [name, { min: [0, 1, 2].map((i) => Math.min(...v.map((p) => p[i]))), max: [0, 1, 2].map((i) => Math.max(...v.map((p) => p[i]))) }];
  }));
};

test("3MF lays out map-form pieces apart, leaves legacy pieces where they are, and frees each piece", async () => {
  const kk = await bootManifoldKernel();
  const cleanup = vi.spyOn(kk, "cleanup");
  const posts = [];
  await handle(kk, mapPart, { type: "export-3mf", parts: ["a", "b", "legacy"], params: {}, jobId: 1, view: "all" }, (m) => posts.push(m));
  const boxes = objectBoxes(posts.find((m) => m.type === "download").data);
  expect(Object.keys(boxes)).toEqual(["a", "b", "legacy"]);
  const [ba, bb] = [boxes.a, boxes.b];
  expect(ba.max[0] <= bb.min[0] || bb.max[0] <= ba.min[0] || ba.max[1] <= bb.min[1] || bb.max[1] <= ba.min[1]).toBe(true);
  expect(ba.min[2]).toBeCloseTo(0, 5); // resting on the bed
  expect(boxes.legacy.min[2]).toBeCloseTo(30, 5);
  expect(cleanup.mock.calls.length).toBeGreaterThanOrEqual(4); // once per piece, plus the job's own
});

test("STL is never laid out", async () => {
  const spy = vi.spyOn(bedLayoutModule, "layoutExportPieces");
  const posts = [];
  await handle(k, mapPart, { type: "export-stl", parts: ["a", "b"], params: {}, jobId: 2 }, (m) => posts.push(m));
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

// Feedback #212: a many-piece STL export must free each piece's solids before the next,
// and a piece that runs the heap out must say which piece and what to do about it.
test("export-stl frees each piece's solids before building the next", async () => {
  const kk = await bootManifoldKernel();
  const cleanup = vi.spyOn(kk, "cleanup");
  const posts = []; await handle(kk, part, { type: "export-stl", parts: ["a", "b"], params: {}, quality: "print" }, (m) => posts.push(m));
  expect(posts.find((m) => m.type === "download-parts").parts).toHaveLength(2);
  expect(cleanup.mock.calls.length).toBeGreaterThanOrEqual(3); // once per piece, plus the job's own
});

test("a piece that runs the kernel out of memory names itself, its place, and the remedy", async () => {
  const trapping = { ...part, parts: { ...part.parts, b: { ...part.parts.b, build: () => { throw new RuntimeError("memory access out of bounds"); } } } };
  const posts = []; await handle(k, trapping, { type: "export-stl", parts: ["a", "b"], params: {}, jobId: 3 }, (m) => posts.push(m));
  const err = posts.find((m) => m.type === "error");
  expect(err.jobId).toBe(3);
  expect(err.message).toMatch(/^exporting "B" \(part 2 of 2\) ran out of memory — export fewer parts at a time/);
  expect(err.message).toMatch(/: (RuntimeError: )?memory access out of bounds$/); // raw text last, for a host's trap classifier
});

test("an ordinary failure in a many-piece export names the piece without memory advice", async () => {
  const broken = { ...part, parts: { ...part.parts, a: { ...part.parts.a, build: () => { throw new Error("bad wall"); } } } };
  const posts = []; await handle(k, broken, { type: "export-stl", parts: ["a", "b"], params: {} }, (m) => posts.push(m));
  expect(posts.find((m) => m.type === "error").message).toBe('exporting "A" (part 1 of 2) failed: bad wall');
});

class RuntimeError extends Error { constructor(m) { super(m); this.name = "RuntimeError"; } }
