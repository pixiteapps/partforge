// The guide's "Routed parts" section: self-contained (one heading, the example inline,
// no pointers into other sections — it lifts into a prompt module later), capped like
// "Sheet parts" because read_docs returns it whole. It also names every lint rule and
// verify metric of the process whose docId is "routed-parts" (test/sheet-docs.test.js
// leaves those to this section).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { PROCESSES } from "../src/framework/process/registry.js";

const guide = readFileSync(fileURLToPath(new URL("../docs/AUTHORING-PARTS.md", import.meta.url)), "utf8");
function sectionOf(heading) {
  const start = guide.indexOf(`\n## ${heading}\n`);
  expect(start, `no "## ${heading}"`).toBeGreaterThanOrEqual(0);
  const end = guide.indexOf("\n## ", start + 1);
  return guide.slice(start + 1, end === -1 ? undefined : end);
}

test("Routed parts follows Sheet parts and precedes Convex hull", () => {
  expect(guide.indexOf("\n## Routed parts\n")).toBeGreaterThan(guide.indexOf("\n## Sheet parts\n"));
  expect(guide.indexOf("\n## Routed parts\n")).toBeLessThan(guide.indexOf("\n## Convex hull\n"));
});

test("the section is self-contained and under 12,000 characters", () => {
  const s = sectionOf("Routed parts");
  expect(s.length).toBeLessThanOrEqual(12000);
  for (const must of ["routedPart(", "pockets", "drills", "extra", "footprint", "method", "reference", "POCKET_", "DRILL_D", "SECONDARY", "cnc-router", "routed-drill-depth", "routedOutside", "face", "FAR_", "flip", "twoSided", "routedBreakthrough"]) {
    expect(s, must).toContain(must);
  }
  expect(s).not.toMatch(/\bsee ["“]?Sheet parts["”]? (above|below)/i);
  expect(s).toContain("```js");
});

test("sheetPart's unknown-process line names routedPart", () => {
  expect(sectionOf("Sheet parts")).toContain("`process` (default `\"laser\"`; `\"cnc-router\"` is `routedPart`, below)");
});

test("the section names every lint rule and verify metric of the routed process", () => {
  const routed = PROCESSES.filter((d) => d.docId === "routed-parts");
  expect(routed.length).toBeGreaterThan(0);
  const s = sectionOf("Routed parts");
  for (const d of routed) {
    for (const { id } of d.lintRules ?? []) expect(s, id).toContain(id);
    for (const key of Object.keys(d.metrics ?? {})) expect(s, key).toContain(key);
  }
});
