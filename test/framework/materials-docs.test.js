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

// Row for row, not mere presence: every look is also in the preset table, so a bare
// "contains `plywood`" would pass with the stock table saying anything at all.
test("the sheet-default table is STOCK_LOOKS, row for row, then the default", () => {
  const i = section.indexOf("**Sheet parts default to their stock.**");
  expect(i).toBeGreaterThan(-1);
  const table = section.slice(i).split("\n\n").find((block) => block.startsWith("| "));
  const cells = (row) => row.split("|").slice(1, -1).map((c) => c.trim());
  const rows = table.split("\n").slice(2).map(cells);          // past the header and its rule
  expect(rows).toHaveLength(STOCK_LOOKS.length + 1);
  STOCK_LOOKS.forEach(({ look, words }, n) => {
    expect(rows[n][0], look).toBe(words.map((w) => `\`${w}\``).join(", "));
    expect(rows[n][1], look).toBe(`\`${look}\``);
  });
  expect(rows.at(-1)[0]).toMatch(/^anything else/);
  expect(rows.at(-1)[1]).toBe(`\`${DEFAULT_STOCK_LOOK}\``);
});

test("the Laser-cut wood paragraph says who burns, that nothing is set, and when it does not", () => {
  const i = section.indexOf("**Laser-cut wood.**");
  expect(i).toBeGreaterThan(-1);
  const para = section.slice(i, section.indexOf("\n\n", i));
  for (const s of ["`sheetPart`", "`plywood`", "`oak`", "`walnut`", "realistic", "nothing to set", "custom `build`", "`views` pose", "CAD"]) {
    expect(para, s).toContain(s);
  }
  // A sheet that names no material burns too, as its stock's look (realisticDisplay).
  expect(para.replace(/\s+/g, " ")).toContain("names no material burns too");
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
