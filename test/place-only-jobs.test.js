import { beforeAll, expect, test, vi } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { handle } from "../src/framework/jobs.js";
import { resolveParams } from "../src/framework/part-model.js";
import lattice from "./fixtures/lattice-lid-part.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const gen = async (part, subparts, params, view = "assembly") => {
  const post = vi.fn();
  await handle(k, part, { type: "generate", subparts, view, params }, post);
  return post.mock.calls.map(([m]) => m).find((m) => m.type === "meshes");
};

test("a rigid place() behind a querying build delivers the canonical mesh with build-only reads", async () => {
  const params = { ...lattice.defaults, openAngle: 60 };
  const reply = await gen(lattice, ["insert"], params);
  const m = reply.meshes[0];
  expect(m.frame).toBe("canonical");
  expect(m.reads).not.toContain("openAngle");
  expect(m.reads).not.toContain("lift");
  expect(m.reads).toEqual(expect.arrayContaining(["w", "d", "h", "lidH", "wall", "frame", "cellR", "web", "fit"]));
  const { p, d } = resolveParams(lattice, params);
  const canonical = lattice.parts.insert.build(k, p, d).toMesh({ quality: "preview" });
  expect(Array.from(m.positions)).toEqual(Array.from(canonical.positions));
});

test("no place() delivers canonical too, with an identity pose implied", async () => {
  const reply = await gen(lattice, ["body"], lattice.defaults);
  expect(reply.meshes[0].frame).toBe("canonical");
});

test("a place() that queries the solid delivers posed, with place reads included (today's path)", async () => {
  const part = {
    defaults: { r: 3, lift: 7 },
    views: { v: { label: "V" } },
    parts: { a: { views: ["v"], build: (k, p) => k.cylinder({ r: p.r, h: 2 }),
      place: (s, { p }) => s.translate([0, 0, p.lift + s.boundingBox().size[2]]) } },
  };
  const m = (await gen(part, ["a"], part.defaults, "v")).meshes[0];
  expect(m.frame).toBe("posed");
  expect(m.reads).toEqual(["lift", "r"]);
});

test("a place() that reshapes delivers posed", async () => {
  const part = {
    defaults: { r: 3 },
    views: { v: { label: "V" } },
    parts: { a: { views: ["v"], build: (k, p) => k.cylinder({ r: p.r, h: 2 }), place: (s) => s.scale(2) } },
  };
  expect((await gen(part, ["a"], part.defaults, "v")).meshes[0].frame).toBe("posed");
});
