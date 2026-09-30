// The Materials section is the agent's only view of the library (partforge-cloud
// regenerates its prompts from this doc), so it must list every id the code knows.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { PRESETS } from "../../src/framework/materials/presets.js";
import { ENVIRONMENTS } from "../../src/framework/materials/environments.js";
import { OVERRIDE_RANGES } from "../../src/framework/materials/resolve.js";
import { STOCK_LOOKS, DEFAULT_STOCK_LOOK } from "../../src/framework/materials/sheet-look.js";

const docs = readFileSync(fileURLToPath(new URL("../../docs/AUTHORING-PARTS.md", import.meta.url)), "utf8");
const section = docs.slice(docs.indexOf("## Materials and appearance"), docs.indexOf("\n## ", docs.indexOf("## Materials and appearance") + 5));

test("the docs carry a Materials and appearance section", () => {
  expect(docs).toContain("## Materials and appearance");
});
test("every listed preset appears in the section, with its tintable mark", () => {
  for (const p of Object.values(PRESETS)) {
    expect(section, p.id).toContain(`\`${p.id}\``);
  }
});
test("every environment and override (with its range) appears", () => {
  for (const id of Object.keys(ENVIRONMENTS)) expect(section, id).toContain(`\`${id}\``);
  for (const [k, [lo, hi]] of Object.entries(OVERRIDE_RANGES)) expect(section, k).toContain(`\`${k}\` (${lo}–${hi})`);
});

test("the sheet-default table lists every stock word and look", () => {
  expect(section).toContain("**Sheet parts default to their stock.**");
  for (const { look, words } of STOCK_LOOKS) {
    expect(section, look).toContain(`\`${look}\``);
    for (const w of words) expect(section, w).toContain(`\`${w}\``);
  }
  expect(section).toContain(`\`${DEFAULT_STOCK_LOOK}\``);
});

test("the Laser-cut wood paragraph says who burns, that nothing is set, and when it does not", () => {
  const i = section.indexOf("**Laser-cut wood.**");
  expect(i).toBeGreaterThan(-1);
  const para = section.slice(i, section.indexOf("\n\n", i));
  for (const s of ["`sheetPart`", "`plywood`", "`oak`", "`walnut`", "realistic", "nothing to set", "custom `build`", "own `place`", "CAD"]) {
    expect(para, s).toContain(s);
  }
});

// The PLA fallback has one exception — a laser sheet part takes its stock's look — and the
// lint hint says so. Every place the guide states the fallback must say it too, or the agent
// reads two contradictory answers for one panel (the `linting` topic is served on its own).
const items = docs.split(/\n\s*\n/).flatMap((block) => block.split(/\n(?=\s*- )/)).map((item) => item.replace(/\s+/g, " "));
test("every statement of the PLA fallback names the laser-sheet exception", () => {
  const stated = items.filter((item) => /PLA print/.test(item) && !item.trimStart().startsWith("|"));
  expect(stated.length).toBeGreaterThanOrEqual(4); // the display bullet, the stock paragraph, declaresMaterials, the catalog
  for (const item of stated) expect(item, item.trim().slice(0, 90)).toMatch(/sheet/);
});
test("the unknown-material catalog entry says what the lint hint says, both ways", () => {
  const entry = items.find((item) => item.includes("`unknown-material` ("));
  expect(entry).toBeDefined();
  expect(entry).toContain("a PLA print in realistic mode"); // the hint on an ordinary sub-part
  expect(entry).toMatch(/laser sheet part its stock's look/); // the hint on a laser sheet
});
