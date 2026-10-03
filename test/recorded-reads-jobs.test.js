import { beforeAll, expect, test, vi } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { handle } from "../src/framework/jobs.js";
import { subPartReadKeys } from "../src/framework/param-deps.js";
import { resolveParams } from "../src/framework/part-model.js";
import { newReadSink, expandReads } from "../src/framework/read-recorder.js";
import { guarded } from "./fixtures/guarded-part.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const gen = async (part, subparts, params) => {
  const post = vi.fn();
  await handle(k, part, { type: "generate", subparts, view: "v", params }, post);
  return post.mock.calls.map(([m]) => m).find((m) => m.type === "meshes");
};

test("a generate reply carries the keys the real build read, past a geometry guard", async () => {
  const reply = await gen(guarded, ["insert"], guarded.defaults);
  expect(reply.meshes[0].reads).toEqual(["cellR", "size"]);
});

test("the probe prediction misses the guarded param — why recording exists", () => {
  expect(subPartReadKeys(guarded, "v", guarded.defaults).get("insert").has("cellR")).toBe(false);
});

test("derived reads expand to the raw params of their own group", async () => {
  const part = {
    defaults: { w: 4, h: 5, t: 2, other: 9 },
    views: { v: { label: "V" } },
    derive: { area: (p) => ({ side: p.w + p.h }), deep: (p) => ({ depth: p.t * 2 }) },
    parts: { a: { views: ["v"], build: (k, p, d) => k.box({ min: [0, 0, 0], max: [d.side, d.side, 1] }) } },
  };
  expect((await gen(part, ["a"], part.defaults)).meshes[0].reads).toEqual(["h", "w"]);
});

test("place() reads count", async () => {
  const part = {
    defaults: { r: 3, lift: 7 },
    views: { v: { label: "V" } },
    parts: { a: { views: ["v"], build: (k, p) => k.cylinder({ r: p.r, h: 2 }),
      place: (s, { p }) => s.translate([0, 0, p.lift]) } },
  };
  expect((await gen(part, ["a"], part.defaults)).meshes[0].reads).toEqual(["lift", "r"]);
});

test("asset declaration reads are attributed to every sub-part in the job", async () => {
  const part = {
    defaults: { art: "", r: 3 },
    views: { v: { label: "V" } },
    vectors: (p) => ({ logo: p.art }),
    parts: {
      a: { views: ["v"], build: (k, p) => k.cylinder({ r: p.r, h: 2 }) },
      b: { views: ["v"], build: (k) => k.cylinder({ r: 1, h: 2 }) },
    },
  };
  const reply = await gen(part, ["a", "b"], part.defaults);
  expect(reply.meshes.find((m) => m.name === "a").reads).toEqual(["art", "r"]);
  expect(reply.meshes.find((m) => m.name === "b").reads).toEqual(["art"]);
});

test("resolveParams with a sink records gate, build and derived reads", () => {
  const part = { defaults: { a: 1, b: 2, on: true }, derive: { g: (p) => ({ twice: p.b * 2 }) } };
  const sink = newReadSink();
  const { p, d } = resolveParams(part, {}, undefined, sink);
  void p.on; void d.twice;
  expect(expandReads(sink)).toEqual(["b", "on"]);
});
