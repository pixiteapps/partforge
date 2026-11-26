// The worker's job loop loads the mesh field builder (a k.implicit `solid` leaf's, which
// imports the oracle's BVH) only for a part that has a solid leaf: at the first one, after
// which it runs the job again (jobs.js handle, NEEDS_MESH_FIELD), the way it loads the
// native core's full build (test/core-split-jobs.test.js).
//
// Each test starts a fresh module graph (vi.resetModules() plus dynamic imports), so the
// builder is not loaded when it starts: the slot that holds it is module state.
import { expect, test, vi } from "vitest";

const IMPLICIT = "../src/framework/geometry/implicit";
const fresh = async () => {
  vi.resetModules();
  const { handle } = await import("../src/framework/jobs.js");
  const { bootManifoldKernel } = await import("../src/testing/manifold.js");
  const slot = await import(`${IMPLICIT}/mesh-field-slot.js`);
  return { handle, k: await bootManifoldKernel(), loaded: slot.meshFieldBuilderLoaded };
};
// The cut & print kit needs a sheet part beside the solid one.
const withSheet = async () => {
  const { sheetPart } = await import("../src/framework/geometry/polygon.js");
  const part = withSolid();
  part.parts.panel = sheetPart({ label: "Panel", views: ["v"], material: "birch plywood", thickness: 3,
    profile: (kk) => kk.shape2d([[0, 0], [60, 0], [60, 30], [0, 30]]) });
  return part;
};

let size = 10;
const withSolid = () => {
  const s = (size += 0.5);
  return {
    views: { v: { label: "V" } },
    parts: {
      plate: { views: ["v"], build: (kk) => kk.box({ size: [20, 20, 2] }) },
      boss: { views: ["v"], build: (kk) => kk.implicit({ preview: 1, root: { kind: "union", k: 2, children: [
        { kind: "solid", solid: kk.box({ size: [s, s, 4] }) }, { kind: "sphere", r: 3, at: [0, 0, 3] }] } }) },
    },
  };
};
const noSolid = () => ({
  views: { v: { label: "V" } },
  parts: { grip: { views: ["v"], build: (kk) => kk.implicit({ root: { kind: "sphere", r: (size += 0.5) }, preview: 1 }) } },
});

test("a part with no solid leaf never loads the builder", async () => {
  const { handle, k, loaded } = await fresh();
  const post = vi.fn();
  await handle(k, noSolid(), { type: "generate", subparts: ["grip"], view: "v", params: {} }, post);
  const posts = post.mock.calls.map(([m]) => m);
  expect(posts.filter((m) => m.type === "error")).toEqual([]);
  expect(posts.filter((m) => m.type === "meshes")).toHaveLength(1);
  expect(loaded()).toBe(false);
});

// Every job family that builds: the first solid leaf throws NEEDS_MESH_FIELD, the loop
// loads the builder and runs the job again, and the host sees one ordinary result.
const JOBS = {
  generate: [{ type: "generate", subparts: ["plate", "boss"], view: "v", params: {} }, "meshes"],
  "capture-generate": [{ type: "capture-generate", subparts: ["plate", "boss"], view: "v", params: {}, jobId: "c1" }, "capture-meshes"],
  "export-stl": [{ type: "export-stl", view: "v", params: {}, jobId: "e1" }, "download-parts"],
  "export-3mf": [{ type: "export-3mf", view: "v", params: {}, jobId: "e2" }, "download"],
  "mesh-subparts": [{ type: "mesh-subparts", parts: ["boss"], view: "v", params: {}, quality: "print", jobId: "m1" }, "subpart-meshes"],
  "export-kit": [{ type: "export-kit", sections: { "3d": { parts: ["plate", "boss"], options: { format: "stl" } } }, view: "v", params: {}, name: "solid", jobId: "k1" }, "kit"],
  "export-bundle": [{ type: "export-bundle", jobId: "b1", parts: ["panel", "boss"], view: "v", params: {}, name: "solid", quality: "preview", options: { destination: "service", printFormat: "stl" } }, "download", withSheet],
  inspect: [{ type: "inspect", view: "v", params: {}, jobId: "i1" }, "report"],
};
for (const [name, [msg, reply, partOf = withSolid]] of Object.entries(JOBS)) {
  test(`${name}: a part with a solid leaf loads the builder and the job runs again`, async () => {
    const { handle, k, loaded } = await fresh();
    expect(loaded()).toBe(false);
    const post = vi.fn();
    await handle(k, await partOf(), msg, post);
    const posts = post.mock.calls.map(([m]) => m);
    expect(posts.filter((m) => m.type === "error").map((m) => m.message)).toEqual([]);
    expect(posts.filter((m) => m.type === reply)).toHaveLength(1);
    expect(JSON.stringify(posts)).not.toMatch(/mesh field builder/);
    expect(loaded()).toBe(true);
  }, 60000);
}

test("a builder that cannot load fails the job with one error, and runs it no third time", async () => {
  const { handle, k, loaded } = await fresh();
  vi.doMock(`${IMPLICIT}/mesh-field-build.js`, () => { throw new Error("no builder here"); });
  try {
    const post = vi.fn();
    let builds = 0;
    const part = withSolid();
    const build = part.parts.boss.build;
    part.parts.boss.build = (kk) => { builds++; return build(kk); };
    await handle(k, part, { type: "generate", subparts: ["plate", "boss"], view: "v", params: {}, jobId: "g1" }, post);
    const errors = post.mock.calls.map(([m]) => m).filter((m) => m.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/^implicit: the mesh field builder could not be loaded: /);
    expect(errors[0].jobId).toBe("g1");
    expect(builds).toBe(1);
    expect(loaded()).toBe(false);
  } finally { vi.doUnmock(`${IMPLICIT}/mesh-field-build.js`); }
});
