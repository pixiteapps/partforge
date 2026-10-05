// test/lattice-box.test.js
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel, verify } from "../src/testing.js";
import { handle } from "../src/framework/jobs.js";
import { lintPart } from "../src/framework/lint/index.js";
import part from "../src/parts/lattice-box.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

test("one sub-part per piece, every printed piece in the print view", () => {
  expect(Object.keys(part.parts).sort()).toEqual(["body", "lid", "mesh", "pin", "plate"]);
  for (const [name, sp] of Object.entries(part.parts)) {
    if (sp.exportable === false) continue;
    expect(Object.keys(sp.views), name).toContain("print");
  }
});

test("lidAngle animates without a rebuild (no animation-track-rebuilds note)", () => {
  const notes = (lintPart(part).notes ?? []).map((n) => n.rule);
  expect(notes).not.toContain("animation-track-rebuilds");
});

test("verify passes: the assembly has no overlaps", () => {
  const v = verify(k, part);
  expect(v.ok).toBe(true);
});

test("the 3MF of every printed piece lays them out apart", async () => {
  const posts = [];
  await handle(k, part, { type: "export-3mf", parts: ["body", "lid", "mesh", "plate"], params: {}, jobId: 1, view: "assembly" }, (m) => posts.push(m));
  expect(posts.find((m) => m.type === "error")).toBeUndefined();
  expect(posts.find((m) => m.type === "download")).toBeTruthy();
});
