import { beforeAll, expect, test } from "vitest";
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
