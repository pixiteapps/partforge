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

test("a frozen derived profile read through .map builds", async () => {
  const frozen = {
    parameters: [{ id: "s", title: "S", controls: [{ key: "h", type: "slider", min: 1, max: 9, step: 1 }] }],
    defaults: { h: 2 },
    views: { v: { label: "V" } },
    derive: () => ({ prof: Object.freeze([Object.freeze([0, 0]), Object.freeze([5, 0]), Object.freeze([5, 5])]) }),
    parts: { one: { views: ["v"], build: (k, p, d) => k.extrude({ profile: d.prof.map(([x, y]) => [x, y]), h: p.h }) } },
  };
  const reply = await gen(frozen, ["one"], frozen.defaults);
  expect(reply?.meshes?.[0]?.name).toBe("one");
  expect(reply.meshes[0].pieceKeys).toEqual(["h"]);
});

test("a throwing build ends its provenance; the next build still carries origins", async () => {
  const throwing = { ...part, parts: { ...part.parts, bad: { views: ["v"], build: (k, p) => { k.box({ min: [0, 0, 0], max: [p.w, 1, 1] }); throw new Error("boom"); } } } };
  const post = vi.fn();
  await handle(k, throwing, { type: "generate", subparts: ["one", "bad"], view: "v", params: part.defaults }, post);
  expect(post.mock.calls.map(([m]) => m).find((m) => m.type === "error")).toBeTruthy();
  // Nothing is still recording: a build outside a generate gets no origins...
  const cap = vi.fn();
  await handle(k, throwing, { type: "capture-generate", subparts: ["two"], view: "v", params: part.defaults }, cap);
  expect(cap.mock.calls.map(([m]) => m).find((m) => m.type === "capture-meshes").meshes[0].originIds).toBeUndefined();
  // ...and the next generate's clean sub-part carries its own origins.
  const { meshes } = await gen(throwing, ["two"], { ...part.defaults, w: 21 });
  expect(meshes[0].origins[meshes[0].originIds[0] - 1]).toEqual(["b", "w"]);
});

// A cached op (a boolean, a label) hands back the solid its FIRST run made, whose run
// ids are that run's. The primitives feeding it must keep their ids across builds, or
// every record minted before the cached op is orphaned from the second build on.
const facePart = {
  parameters: [{ id: "s", title: "S", controls: ["w", "a", "b"].map((key) => ({ key, type: "slider", min: 0, max: 100, step: 1 })) }],
  defaults: { w: 20, a: 10, b: 4 },
  views: { v: { label: "V" } },
  parts: {
    cut: { views: ["v"], build: (k, p) => k.box({ min: [0, 0, 0], max: [p.w, p.w, p.w] }).cut(k.cylinder({ d: p.b, h: 50 })).translate([p.a, 0, 0]) },
    ball: { views: ["v"], build: (k, p) => k.sphere(p.w).cut(k.box({ min: [0, 0, 0], max: [p.b, p.b, 50] })).translate([p.a, 0, 0]) },
    labeled: { views: ["v"], build: (k, p) => k.box({ min: [0, 0, 0], max: [p.w, p.w, p.w] }).label("x").translate([p.a, 0, 0]) },
    // sub-part two of the same job hits the first one's cached label
    labeledTwin: { views: ["v"], build: (k, p) => { const b = k.box({ min: [0, 0, 0], max: [p.w, p.w, p.w] }).label("x"); return b.translate([p.a, 1, 0]); } },
  },
};
const originSets = (m) => (m.origins ?? []).map((o) => [...o].sort().join()).sort();

test("face origins survive a rebuild that hits the solid cache", async () => {
  const names = ["cut", "ball", "labeled", "labeledTwin"];
  const expected = { cut: ["a,b", "a,w"], ball: ["a,b", "a,w"], labeled: ["a,w"], labeledTwin: ["a,w"] };
  const first = await gen(facePart, names, facePart.defaults);
  for (const m of first.meshes) expect(originSets(m), `first ${m.name}`).toEqual(expected[m.name]);
  const second = await gen(facePart, names, { ...facePart.defaults, a: 11 });
  for (const m of second.meshes) expect(originSets(m), `second ${m.name}`).toEqual(expected[m.name]);
});

test("a label after a transform keeps the faces' origins", async () => {
  const p2 = { ...facePart, parts: {
    tl: { views: ["v"], build: (k, p) => k.box({ min: [0, 0, 0], max: [p.w, p.w, p.w] }).translate([p.a, 0, 0]).label("x") },
    rl: { views: ["v"], build: (k, p) => k.box({ min: [0, 0, 0], max: [p.w, p.w, p.w] }).rotate(p.a, [0, 0, 0], [0, 0, 1]).label("x") },
    ctl: { views: ["v"], build: (k, p) => k.box({ min: [0, 0, 0], max: [p.w, p.w, p.w] }).cut(k.cylinder({ d: p.b, h: 50 })).translate([p.a, 2, 3]).label("x") },
  } };
  for (const params of [facePart.defaults, { ...facePart.defaults, a: 12 }]) {
    const { meshes } = await gen(p2, ["tl", "rl", "ctl"], params);
    expect(originSets(meshes[0])).toEqual(["a,w"]);
    expect(originSets(meshes[1])).toEqual(["a,w"]);
    expect(originSets(meshes[2])).toEqual(["a,b", "a,w"]);
  }
});

test("a derived array read through .map, for-of or as a whole ranks by its own inputs", async () => {
  const arr = {
    parameters: [{ id: "s", title: "S", controls: ["a", "b", "c", "h"].map((key) => ({ key, type: "slider", min: 0, max: 100, step: 1 })) }],
    defaults: { a: 10, b: 20, c: 5, h: 3 },
    views: { v: { label: "V" } },
    derive: (p) => ({ pts: [[0, 0], [p.a, 0], [p.a, p.b]], other: p.c * 2 }),
    parts: {
      map: { views: ["v"], build: (k, p, d) => k.extrude({ profile: d.pts.map(([x, y]) => [x, y]), h: p.h }) },
      forof: { views: ["v"], build: (k, p, d) => { const o = []; for (const q of d.pts) o.push([q[0], q[1]]); return k.extrude({ profile: o, h: p.h }); } },
      whole: { views: ["v"], build: (k, p, d) => k.extrude({ profile: d.pts, h: p.h }) },
    },
  };
  const { meshes } = await gen(arr, ["map", "forof", "whole"], arr.defaults);
  for (const m of meshes) {
    expect(m.reads, m.name).toEqual(["a", "b", "c", "h"]); // the recorded attribution still gates
    expect(m.pieceKeys, m.name).toEqual(["a", "b", "h"]);
    expect(originSets(m), m.name).toEqual(["a,b,h"]);
  }
});
