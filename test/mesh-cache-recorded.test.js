import { beforeAll, expect, test, vi } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { handle } from "../src/framework/jobs.js";
import { createMeshCache } from "../src/framework/mesh-cache.js";
import { guarded } from "./fixtures/guarded-part.js";

const makeCache = (params, { caching = true } = {}) => {
  let version = 0, view = "v";
  const cache = createMeshCache({ hasSubMesh: () => true }, {
    params, getView: () => view, getParamsVersion: () => version, isCaching: () => caching,
  });
  return { cache, bump: () => { version++; }, setView: (v) => { view = v; } };
};

test("a recorded key's change makes the mesh stale (#158: this used to stay current)", () => {
  const params = { ...guarded.defaults };
  const { cache, bump } = makeCache(params);
  cache.record("insert", ["cellR", "size"]);
  expect(cache.isCurrent("insert")).toBe(true);
  params.cellR = 3; bump();
  expect(cache.isCurrent("insert")).toBe(false);
});

test("an unrecorded key never invalidates", () => {
  const params = { ...guarded.defaults };
  const { cache, bump } = makeCache(params);
  cache.record("insert", ["cellR", "size"]);
  params.unused = 99; bump();
  expect(cache.isCurrent("insert")).toBe(true);
});

test("no reads (old worker / synthetic reply) stamps every param", () => {
  const params = { ...guarded.defaults };
  const { cache, bump } = makeCache(params);
  cache.record("insert", undefined);
  expect(cache.readsOf("insert")).toBe(null);
  params.unused = 99; bump();
  expect(cache.isCurrent("insert")).toBe(false);
});

test("the stamp is per view: a tab switch is never current off another view's stamp", () => {
  const { cache, setView } = makeCache({ ...guarded.defaults });
  cache.record("insert", ["size"]);
  setView("other");
  expect(cache.isCurrent("insert")).toBe(false);
});

test("readsOf and forget", () => {
  const { cache } = makeCache({ ...guarded.defaults });
  cache.record("insert", ["size", "size"]);
  expect([...cache.readsOf("insert")]).toEqual(["size"]);
  cache.forget("insert");
  expect(cache.readsOf("insert")).toBe(null);
  expect(cache.isCurrent("insert")).toBe(false);
});

test("caching off: any edit invalidates", () => {
  const params = { ...guarded.defaults };
  const { cache, bump } = makeCache(params, { caching: false });
  cache.record("insert", ["size"]);
  params.unused = 2; bump();
  expect(cache.isCurrent("insert")).toBe(false);
});

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });
test("#158 end to end over the real worker", async () => {
  const params = { ...guarded.defaults };
  const { cache, bump } = makeCache(params);
  const post = vi.fn();
  await handle(k, guarded, { type: "generate", subparts: ["insert"], view: "v", params }, post);
  cache.record("insert", post.mock.calls.map(([m]) => m).find((m) => m.type === "meshes").meshes[0].reads);
  params.cellR = 4; bump();
  expect(cache.isCurrent("insert")).toBe(false);
});

test("record stamps the view it is given (the dispatched one), not the live one", () => {
  const params = { ...guarded.defaults };
  const { cache, setView } = makeCache(params);
  setView("w");                         // the tab moved while the job was in flight
  cache.record("insert", ["size"], "v"); // the job was sent for "v"
  expect(cache.isCurrent("insert")).toBe(false);
  setView("v");
  expect(cache.isCurrent("insert")).toBe(true);
});

test("hasStamp tells an every-param stamp from no stamp; readsOf is null for both", () => {
  const { cache } = makeCache({ ...guarded.defaults });
  expect(cache.hasStamp("insert")).toBe(false);
  cache.record("insert", undefined);
  expect(cache.hasStamp("insert")).toBe(true);
  expect(cache.readsOf("insert")).toBe(null);
  cache.forget("insert");
  expect(cache.hasStamp("insert")).toBe(false);
});

test("a canonical stamp stays current when a place-only param changes", () => {
  const params = { w: 60, openAngle: 0 };
  const { cache, bump } = makeCache(params);
  cache.record("insert", ["w"], "v", "canonical");
  expect(cache.frameOf("insert")).toBe("canonical");
  params.openAngle = 90; bump();
  expect(cache.isCurrent("insert")).toBe(true);
});

test("frame defaults to posed (an older worker's reply), and is null with no stamp", () => {
  const { cache } = makeCache({ a: 1 });
  expect(cache.frameOf("x")).toBe(null);
  cache.record("x", ["a"]);
  expect(cache.frameOf("x")).toBe("posed");
  cache.forget("x");
  expect(cache.frameOf("x")).toBe(null);
});
