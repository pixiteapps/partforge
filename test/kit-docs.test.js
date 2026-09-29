// The guide's half of the kit (spec F.2 item 9). "Sheet parts" is what the authoring
// agent reads — partforge-cloud regenerates its prompt corpus from this file, and the
// section is capped at 16,000 characters because read_docs returns it whole — so "The
// kit" there says only what an AUTHOR acts on, in at most 600 characters. The host's
// half (the ZIP's layout, the options, the main-entry exports) lives in the uncapped
// headless-export docs, where a host already looks.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const guide = readFileSync(fileURLToPath(new URL("../docs/AUTHORING-PARTS.md", import.meta.url)), "utf8");

function sectionOf(heading) {
  const start = guide.indexOf(`\n## ${heading}\n`);
  expect(start, `the guide has no "## ${heading}"`).toBeGreaterThanOrEqual(0);
  const end = guide.indexOf("\n## ", start + 1);
  return guide.slice(start + 1, end === -1 ? undefined : end);
}

// "### The kit" up to the next "### ", heading included.
function kitSubsection() {
  const s = sectionOf("Sheet parts");
  const i = s.indexOf("\n### The kit\n");
  expect(i, 'Sheet parts has no "### The kit"').toBeGreaterThanOrEqual(0);
  const j = s.indexOf("\n### ", i + 1);
  return s.slice(i + 1, j === -1 ? undefined : j);
}

test('"The kit" sits after the lint/verify subsection and before Limits', () => {
  const s = sectionOf("Sheet parts");
  const at = (h) => s.indexOf(`\n### ${h}\n`);
  expect(at("What lint and verify check")).toBeGreaterThan(0);
  expect(at("The kit")).toBeGreaterThan(at("What lint and verify check"));
  expect(at("Limits")).toBeGreaterThan(at("The kit"));
});

test("Sheet parts stays within 16,000 characters with the kit in it", () => {
  expect(sectionOf("Sheet parts").length).toBeLessThanOrEqual(16000);
});

test("the kit subsection says what an author acts on, in at most 600 characters", () => {
  const kit = kitSubsection();
  expect(kit.length).toBeLessThanOrEqual(600);
  for (const needle of [
    'format: "bundle"', '"own-laser"', '"service"', "cut kit options:", "README.txt", "parts.csv",
    "sheets/", "parts/", "print/", "-marks.dxf", "export: { name }", "`thickness`",
  ]) expect(kit, `"The kit" never mentions ${needle}`).toContain(needle);
});

test("the headless-export docs carry the host's half of the kit", () => {
  const s = sectionOf("Wiring a part into a runnable app");
  for (const needle of [
    "listExportFormats()", '"bundle"', "sheet: { process, material, thickness, group }", "options?",
    "<title>-kit.zip", "README.txt", "-marks.dxf", "stock: [{ group, size: [w, h] }]",
    "EXPORT_FORMATS", "KIT_DEFAULTS", "validateKitOptions", "KIT_OPTIONS_ERROR", "cut kit options:",
  ]) expect(s, `headless export never mentions ${needle}`).toContain(needle);
});
