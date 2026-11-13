// The pin hinge in docs/AUTHORING-PARTS.md "A hinge that opens" is test/fixtures/pin-hinge.js,
// copied from its first `// Interfaces:` line to the end. This holds the guide's copy equal
// to the fixture, and the fixture to what the guide says it does: lint clean, the swing clear
// at clearance 0, every fit inside its band, the pin lying on the bed and held by its head and
// a press fit, and verify true under fdm-pla with no cost.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { measure } from "../src/framework/oracle/measure.js";
import { verify } from "../src/framework/oracle/verify.js";
import { lintPart } from "../src/framework/lint/index.js";
import part from "./fixtures/pin-hinge.js";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const SLOW = 120_000;

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

test("the guide carries the fixture verbatim, from its first `// Interfaces:` line to the end", () => {
  const src = read("./fixtures/pin-hinge.js");
  const snippet = src.slice(src.indexOf("// Interfaces: ")).trimEnd();
  expect(read("../docs/AUTHORING-PARTS.md")).toContain("```js\n" + snippet + "\n```");
});

test("the pin hinge lints clean, with no motion-unswept", () => {
  const r = lintPart(part);
  expect(r.errors).toEqual([]);
  expect(r.warnings).toEqual([]);
});

test("the pin hinge is three pieces, the pin its own, printed under fdm-pla", () => {
  expect(Object.keys(part.parts)).toEqual(["base", "lid", "pin"]);
  // the pin prints lying down: longer along X than it stands tall
  const [pin] = measure(k, part, "print").subparts.filter((s) => s.name === "pin");
  expect(pin.bbox[0]).toBeGreaterThan(5 * pin.bbox[2]);
  expect(part.verify.process).toBe("fdm-pla");
  expect(Object.keys(part.views)).toEqual(["assembly", "print"]);
}, SLOW);

test("the pin hinge swings clear at clearance 0 and verifies true under fdm-pla, with no cost", () => {
  const [row] = measure(k, part, "assembly").sweeps;
  expect(row).toMatchObject({ name: "open", clear: true, contacts: [], freeRange: [0, 180] });
  expect(row.minClearance.distance).toBeGreaterThan(0.15);
  const v = verify(k, part);
  expect(v.ok).toBe(true);
  expect(v.unevaluated).toEqual([]);
  expect(v.failures).toEqual([]);
  expect(v.costs.filter((c) => c.status === "cost")).toEqual([]);
  const pairs = Object.fromEntries(v.cases[0].checks.filter((c) => c.metric === "clearance" || c.metric === "contact").map((c) => [`${c.metric} ${c.subpart}`, c.status]));
  expect(pairs).toEqual({ "clearance lid×pin": "pass", "clearance base×lid": "pass", "contact base×pin": "pass" });
}, SLOW);

test("the CLI prints the line the guide quotes", () => {
  const out = execFileSync(process.execPath, ["bin/cli.js", "measure", "test/fixtures/pin-hinge.js"], { encoding: "utf8" });
  expect(out.split("\n").find((l) => l.startsWith("  sweeps:"))).toBe("  sweeps: open clear (min 0.20mm base×lid)");
  expect(read("../docs/AUTHORING-PARTS.md")).toContain("`sweeps: open clear (min 0.20mm base×lid)`");
  expect(out).toContain("result: all gates passed");
}, SLOW);
