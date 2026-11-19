// The worker's job loop loads the native core's full build (the k.implicit engine) only
// for a part that calls k.implicit: at the first such call, after which it runs the job
// again (jobs.js handle, NEEDS_FULL_CORE).
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { handle } from "../src/framework/jobs.js";
import { core, fullCoreLoaded, setFullCoreForTesting } from "../src/framework/core/core.js";
import { fullCoreRequired } from "../src/framework/core/core-status.js";
import demo from "../src/parts/demo.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });
afterAll(() => setFullCoreForTesting(true));

// A fresh radius per part: the kernel caches solids, and a cached k.implicit body
// never reaches the engine (so it needs no core at all).
let radius = 6;
const organic = () => ({
  defaults: { r: (radius += 0.25) },
  views: { v: { label: "V" } },
  parts: {
    plate: { views: ["v"], build: (kk) => kk.box({ size: [20, 20, 2] }) },
    grip: { views: ["v"], build: (kk, p) => kk.implicit({ root: { kind: "sphere", r: p.r }, preview: 1 }).translate([0, 0, 8]) },
  },
});
const generate = async (part, subparts, view) => {
  const post = vi.fn();
  await handle(k, part, { type: "generate", subparts, view, params: {} }, post);
  return post.mock.calls.map(([m]) => m);
};

test("a part with no k.implicit never loads the full build", async () => {
  await setFullCoreForTesting(false);
  const posts = await generate(demo, ["spacer"], "spacer");
  expect(posts.some((m) => m.type === "meshes")).toBe(true);
  expect(fullCoreLoaded()).toBe(false);
  expect(core().full).toBe(false);
});

// Every job family that builds: the first k.implicit call throws NEEDS_FULL_CORE, the
// loop loads the build and runs the job again, and the host sees one ordinary result.
const JOBS = {
  generate: [{ type: "generate", subparts: ["plate", "grip"], view: "v", params: {} }, "meshes"],
  "capture-generate": [{ type: "capture-generate", subparts: ["plate", "grip"], view: "v", params: {}, jobId: "c1" }, "capture-meshes"],
  "export-stl": [{ type: "export-stl", view: "v", params: {}, jobId: "e1" }, "download-parts"],
  "export-3mf": [{ type: "export-3mf", view: "v", params: {}, jobId: "e2" }, "download"],
  "mesh-subparts": [{ type: "mesh-subparts", parts: ["grip"], view: "v", params: {}, quality: "print", jobId: "m1" }, "subpart-meshes"],
  "export-kit": [{ type: "export-kit", sections: { "3d": { parts: ["plate", "grip"], options: { format: "stl" } } }, view: "v", params: {}, name: "organic", jobId: "k1" }, "kit"],
  inspect: [{ type: "inspect", view: "v", params: {}, jobId: "i1" }, "report"],
};
for (const [name, [msg, reply]] of Object.entries(JOBS)) {
  test(`${name}: an organic part loads the full build and the job runs again natively`, async () => {
    await setFullCoreForTesting(false);
    const post = vi.fn();
    await handle(k, organic(), msg, post);
    const posts = post.mock.calls.map(([m]) => m);
    expect(posts.filter((m) => m.type === "error").map((m) => m.message)).toEqual([]);
    expect(posts.filter((m) => m.type === reply)).toHaveLength(1);
    expect(JSON.stringify(posts)).not.toMatch(/full build is not loaded/);
    expect(fullCoreLoaded()).toBe(true);
    expect(core().full).toBe(true);
    expect(fullCoreRequired()).toBe(false); // the requirement lasts only as long as the job
  });
}

test("a realm whose full build cannot load builds the organic part in JS, with no retry loop", async () => {
  await setFullCoreForTesting("failed");
  const posts = await generate(organic(), ["plate", "grip"], "v");
  expect(posts.filter((m) => m.type === "error")).toEqual([]);
  expect(posts.filter((m) => m.type === "meshes")).toHaveLength(1);
  expect(fullCoreLoaded()).toBe(false);
});
