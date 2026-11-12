// The pin hinge in docs/AUTHORING-PARTS.md "A hinge that opens" is test/fixtures/pin-hinge.js,
// copied from its `const W` line to the end. This holds the guide's copy equal to the
// fixture, and the fixture to what the guide says it does: lint clean, the swing clear at
// clearance 0, verify true.
import { readFileSync } from "node:fs";
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { measure } from "../src/framework/oracle/measure.js";
import { verify } from "../src/framework/oracle/verify.js";
import { lintPart } from "../src/framework/lint/index.js";
import part from "./fixtures/pin-hinge.js";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

test("the guide carries the fixture verbatim, from its `const W` line to the end", () => {
  const src = read("./fixtures/pin-hinge.js");
  const snippet = src.slice(src.indexOf("const W = ")).trimEnd();
  expect(read("../docs/AUTHORING-PARTS.md")).toContain("```js\n" + snippet + "\n```");
});

test("the pin hinge lints clean, with no motion-unswept", () => {
  const r = lintPart(part);
  expect(r.errors).toEqual([]);
  expect(r.warnings).toEqual([]);
});

test("the pin hinge swings clear at clearance 0 and verifies true", () => {
  const [row] = measure(k, part, "assembly").sweeps;
  expect(row).toMatchObject({ name: "open", clear: true, contacts: [] });
  expect(row.minClearance.distance).toBeGreaterThan(0.15);
  const v = verify(k, part);
  expect(v.ok).toBe(true);
  expect(v.unevaluated).toEqual([]);
});
