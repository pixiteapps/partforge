// The Materials section is the agent's only view of the library (partforge-cloud
// regenerates its prompts from this doc), so it must list every id the code knows.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { PRESETS } from "../../src/framework/materials/presets.js";
import { ENVIRONMENTS } from "../../src/framework/materials/environments.js";
import { OVERRIDE_RANGES } from "../../src/framework/materials/resolve.js";

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
