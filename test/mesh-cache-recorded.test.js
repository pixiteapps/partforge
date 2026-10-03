import { beforeAll, expect, test, vi } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { handle } from "../src/framework/jobs.js";
import { createMeshCache } from "../src/framework/mesh-cache.js";
import { guarded } from "./fixtures/guarded-part.js";

const makeCache = (params, { caching = true } = {}) => {
  let version = 0, view = "v";
  const cache = createMeshCache(guarded, { hasSubMesh: () => true }, {
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
