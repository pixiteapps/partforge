// The Manifold half of a hybrid STEP export: mesh-subparts builds each named sub-part in
// its export pose at print quality and answers with JS-owned mesh arrays.
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { handle } from "../src/framework/jobs.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const part = {
  meta: { title: "T", backend: "manifold" }, defaults: {},
  parts: {
    // An export pose: place() with purpose "export" moves it to x = 100.
    grip: {
      views: ["all"],
      build: (kk) => kk.implicit({ root: { kind: "sphere", r: 5 }, resolution: 1 }),
      place: (s, { purpose }) => (purpose === "export" ? s.translate([100, 0, 0]) : s),
    },
    broken: { views: ["all"], build: () => { throw new Error("boom"); } },
  },
  views: { all: { label: "All" } },
};

async function run(msg) {
  const posts = [];
  await handle(k, part, { type: "mesh-subparts", view: "all", params: {}, jobId: "mesh-1-1", quality: "print", ...msg }, (m, transfer) => posts.push({ m, transfer }));
  return posts;
}

test("answers with each sub-part's closed export mesh, transferred", async () => {
  const posts = await run({ parts: ["grip"] });
  const reply = posts.find((p) => p.m.type === "subpart-meshes");
  expect(reply, JSON.stringify(posts.map((p) => p.m))).toBeTruthy();
  const { positions, indices } = reply.m.meshes.grip;
  expect(positions).toBeInstanceOf(Float32Array);
  expect(indices.length % 3).toBe(0);
  expect(reply.transfer).toContain(positions.buffer);
  // Every edge is shared by exactly two triangles: a closed mesh.
  const edges = new Map();
  for (let t = 0; t < indices.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = indices[t + e], b = indices[t + (e + 1) % 3], key = a < b ? `${a},${b}` : `${b},${a}`;
    edges.set(key, (edges.get(key) ?? 0) + 1);
  }
  expect([...edges.values()].every((n) => n === 2)).toBe(true);
  // The export pose is applied: the sphere sits at x = 100.
  let minX = Infinity;
  for (let i = 0; i < positions.length; i += 3) minX = Math.min(minX, positions[i]);
  expect(minX).toBeCloseTo(95, 0);
});

test("a sub-part that throws fails the job naming it", async () => {
  const posts = await run({ parts: ["grip", "broken"] });
  const err = posts.find((p) => p.m.type === "error");
  expect(err?.m.message).toMatch(/broken/);
  expect(posts.find((p) => p.m.type === "subpart-meshes")).toBeUndefined();
});
