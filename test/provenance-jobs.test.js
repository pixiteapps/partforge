import { beforeAll, expect, test, vi } from "vitest";
import { bootManifoldKernel, handle } from "../src/testing.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });
const gen = async (part, subparts, params) => {
  const post = vi.fn();
  await handle(k, part, { type: "generate", subparts, view: "v", params }, post);
  return post.mock.calls.map(([m]) => m).find((m) => m.type === "meshes");
};

const part = {
  parameters: [{ id: "s", title: "S", controls: [
    { key: "w", type: "slider", min: 1, max: 50, step: 1 }, { key: "a", type: "slider", min: 0, max: 100, step: 0.1 }, { key: "b", type: "slider", min: 0, max: 100, step: 0.1 }] }],
  defaults: { w: 20, a: 10, b: 30 },
  views: { v: { label: "V" } },
  derive: (p) => ({ open: [p.a / 10, p.b / 10] }),
  parts: {
    one: { views: ["v"], build: (k, p, d) => k.box({ min: [0, 0, 0], max: [p.w, p.w, d.open[0]] }) },
    two: { views: ["v"], build: (k, p, d) => k.box({ min: [0, 0, 0], max: [p.w, p.w, d.open[1]] }) },
  },
};

test("generate ships per-triangle origins and nudged piece keys, and leaves reads alone", async () => {
  const { meshes } = await gen(part, ["one", "two"], part.defaults);
  const one = meshes.find((m) => m.name === "one"), two = meshes.find((m) => m.name === "two");
  expect(one.reads).toEqual(["a", "b", "w"]);
  expect(one.pieceKeys).toEqual(["a", "w"]);
  expect(two.pieceKeys).toEqual(["b", "w"]);
  expect(one.origins[one.originIds[0] - 1]).toEqual(["a", "w"]);
  expect(two.origins[two.originIds[0] - 1]).toEqual(["b", "w"]);
});

test("capture-generate carries no origins", async () => {
  const post = vi.fn();
  await handle(k, part, { type: "capture-generate", subparts: ["one"], view: "v", params: part.defaults }, post);
  const reply = post.mock.calls.map(([m]) => m).find((m) => m.type === "capture-meshes");
  expect(reply.meshes[0].originIds).toBeUndefined();
});
