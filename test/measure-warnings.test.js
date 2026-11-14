// measure() reports the kernel's build warnings (takeBuildWarnings), per sub-part, the
// way the app's generate job does — so the CLI and the cloud agent see them too.
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { measure } from "../src/oracle.js";
import { buildView } from "../src/framework/oracle/build.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const partWith = (build) => ({
  meta: { title: "T", backend: "manifold" },
  defaults: {},
  parts: { body: { views: ["main"], build } },
  views: { main: { label: "Main" } },
});

test("a thin feature's build warning reaches measure, attributed to its sub-part", () => {
  const part = partWith((kk) => kk.implicit({ preview: 1.5, root: { kind: "union", children: [
    { kind: "sphere", r: 10 }, { kind: "box", size: [20, 20, 0.5], at: [0, 0, 12] },
  ] } }));
  const { warnings } = measure(k, part, "main");
  expect(warnings).toHaveLength(1);
  expect(warnings[0].part).toBe("body");
  expect(warnings[0].message).toMatch(/thinnest feature/);
});

test("a part with nothing to warn about reports an empty list", () => {
  expect(measure(k, partWith((kk) => kk.box({ size: [10, 10, 10] })), "main").warnings).toEqual([]);
});

test("a kernel without takeBuildWarnings gives every entry an empty list", () => {
  const { takeBuildWarnings, ...rest } = k;
  const bare = Object.assign(Object.create(Object.getPrototypeOf(k)), rest);
  expect(typeof takeBuildWarnings).toBe("function");
  const built = buildView(bare, partWith((kk) => kk.box({ size: [10, 10, 10] })), "main");
  expect(built.map((b) => b.warnings)).toEqual([[]]);
});
