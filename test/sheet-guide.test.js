// The authoring guide's "## Sheet parts" section — the authoring half this release
// ships (subsections 1–7). partforge-cloud regenerates its agent prompts from this
// file and the agent reads the section on demand, so its placement, its first
// paragraph (the words users actually type) and its coverage of every public helper
// are contract. The lint/verify, kit, limits and worked-example subsections, the 16k
// section cap and the byte pin to laser-box.js are pinned in test/sheet-docs.test.js.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import * as joinery from "../src/framework/sheet/joinery.js";

const guide = readFileSync(fileURLToPath(new URL("../docs/AUTHORING-PARTS.md", import.meta.url)), "utf8");
const h2 = [...guide.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
const start = guide.indexOf("\n## Sheet parts\n");
const end = guide.indexOf("\n## ", start + 1);
const section = guide.slice(start + 1, end);

test("## Sheet parts sits once, right after Editing profiles and before Convex hull", () => {
  expect(h2.filter((h) => h === "Sheet parts")).toHaveLength(1);
  const i = h2.indexOf("Sheet parts");
  expect(h2[i - 1]).toBe("Editing profiles");
  expect(h2[i + 1]).toBe("Convex hull");
});

const AUTHORING = [
  "When a sub-part is a sheet part",
  "sheetPart",
  "Cut, score and engrave",
  "Thickness, clearance and kerf",
  "Placing panels: pose and worldToSheet",
  "Joinery helpers",
  "Printed parts that key into sheets",
];

test("the authoring subsections come first, in order", () => {
  const h3 = [...section.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
  expect(h3.slice(0, AUTHORING.length)).toEqual(AUTHORING);
});

test("the first paragraph carries the words users type", () => {
  const first = section.split("\n\n")[1];
  for (const word of ["laser cutter", "plywood", "acrylic", "MDF", "flat-pack", "finger/box joint",
    "tab and slot", "T-slot", "kerf", "SVG", "DXF", "LightBurn", "xTool", "Glowforge", "SendCutSend"])
    expect(first, word).toContain(word);
});

test("every public sheet helper is named in the section", () => {
  const names = ["sheetPart", "sheetToWorld", "worldToSheet", ...Object.keys(joinery)];
  for (const name of names) expect(section, name).toContain(`\`${name}`);
});

test("Profiles & patterns points laser-cut stock at the section", () => {
  const profiles = guide.slice(guide.indexOf("\n## Profiles & patterns\n"), guide.indexOf("\n## 2-D booleans\n"));
  expect(profiles).toContain("[Sheet parts](#sheet-parts)");
});

test("the authoring half stays within its share of the section's 16k budget", () => {
  // The whole section is capped at 16,000 characters (read_docs returns it whole);
  // the byte-pinned worked example alone is ~6.4k, and the lint/verify, kit and limits
  // subsections need the rest. So the intro plus subsections 1–7 get 6,000.
  const last = section.indexOf("### Printed parts that key into sheets");
  const next = section.indexOf("\n### ", last + 1);
  const authoring = section.slice(0, next === -1 ? section.length : next);
  expect(authoring.length).toBeLessThanOrEqual(6000);
});
