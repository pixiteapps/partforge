// The guide's "Sheet parts" section is what an agent reads to build laser-cut parts,
// and partforge-cloud serves it whole as one topic. Pinned here:
//   - where it sits, and that it fits the 16,000-character topic cap,
//   - its first paragraph carries the words people type when they want a laser part,
//   - its subsections come in the promised order ("The kit" arrives with the kit),
//   - its worked example IS src/parts/laser-box.js, byte for byte,
//   - "What lint and verify check" names every sheet rule and metric,
//   - every sheet verify hint stands alone in at most 500 characters (cloud's
//     sanitizers cut message and hint there; the section id rides `pattern`).
// The lint hints' lengths are test/lint-sheet.test.js's.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { SHEET_RULES } from "../src/framework/lint/rules-sheet.js";
import { SHEET_METRICS } from "../src/framework/process/registry.js";
import { SHEET_CHECKS_NOTICE, SHEET_READ_ERROR_HINT } from "../src/framework/oracle/verify.js";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const guide = read("../docs/AUTHORING-PARTS.md");
const start = guide.indexOf("\n## Sheet parts\n");
const end = guide.indexOf("\n## ", start + 1);
const section = guide.slice(start + 1, end);
const subsection = (title) => {
  const i = section.indexOf(`\n### ${title}\n`);
  if (i < 0) return "";
  const j = section.indexOf("\n### ", i + 1);
  return section.slice(i, j < 0 ? undefined : j);
};

test("one Sheet parts section, after Editing profiles and before Convex hull", () => {
  expect(start).toBeGreaterThan(guide.indexOf("\n## Editing profiles\n"));
  expect(guide.indexOf("\n## Sheet parts\n", start + 1)).toBe(-1);
  expect(guide.slice(end + 1).startsWith("## Convex hull\n")).toBe(true);
});

test("the section fits the 16,000-character topic cap, leaving 650 for the kit", () => {
  expect(section.length).toBeLessThanOrEqual(16000);
  // Contract §10: everything but P2b's "### The kit" stays within 15,350, so the kit
  // subsection (≤ 600, P2b's own test) always fits. Measured with the kit subsection cut
  // out, so this holds before AND after P2b inserts it.
  expect(section.length - subsection("The kit").length).toBeLessThanOrEqual(15350);
});

test("the first paragraph carries the words people type", () => {
  const first = section.split("\n\n")[1].toLowerCase();
  for (const word of ["laser cutter", "plywood", "acrylic", "mdf", "flat-pack", "finger", "box joint", "tab and slot",
    "t-slot", "kerf", "svg", "dxf", "lightburn", "xtool", "glowforge", "sendcutsend"]) {
    expect(first, word).toContain(word);
  }
});

test("the subsections come in the promised order", () => {
  const titles = [...section.matchAll(/^### (.+)$/gm)].map((m) => m[1]).filter((t) => t !== "The kit");
  expect(titles).toEqual([
    "When a sub-part is a sheet part", "sheetPart", "Cut, score and engrave", "Thickness, clearance and kerf",
    "Placing panels: pose and worldToSheet", "Joinery helpers", "Printed parts that key into sheets",
    "What lint and verify check", "Limits", "Worked example: laser-box.js",
  ]);
});

test("the worked example is src/parts/laser-box.js, byte for byte", () => {
  const blocks = [...subsection("Worked example: laser-box.js").matchAll(/```js\n([\s\S]*?)\n```/g)];
  expect(blocks).toHaveLength(1);
  expect(blocks[0][1]).toBe(read("../src/parts/laser-box.js").trimEnd());
});

test("What lint and verify check names every sheet rule and metric, and the budget notice", () => {
  const text = subsection("What lint and verify check");
  for (const id of [...SHEET_RULES.map((r) => r.id), ...Object.keys(SHEET_METRICS), SHEET_CHECKS_NOTICE.metric]) {
    expect(text, id).toContain(`\`${id}\``);
  }
});

test("every sheet verify hint stands alone in at most 500 characters", () => {
  for (const [name, m] of Object.entries(SHEET_METRICS)) expect(m.hint.length, name).toBeLessThanOrEqual(500);
  expect(SHEET_CHECKS_NOTICE.hint.length).toBeLessThanOrEqual(500);
  expect(SHEET_CHECKS_NOTICE.pattern).toBe("sheet-parts");
  expect(SHEET_READ_ERROR_HINT.length).toBeLessThanOrEqual(500);
});

// A read error on a valid profile is the checker's limit, not the author's contour: the
// hint used to call "an overlapping or self-touching contour, or a sliver" the usual cause
// and ask for the profile to be simplified there, which sent an agent to reshape a clean
// rounded plate. It says the part still builds, not to reshape it, and when a contour fix
// really is the answer. One text, exported: the kit's README repeats it.
test("the read-error hint blames the checker, not a valid profile", () => {
  expect(SHEET_READ_ERROR_HINT).toMatch(/limit of the checker/);
  expect(SHEET_READ_ERROR_HINT).toMatch(/do not reshape the part/);
  expect(SHEET_READ_ERROR_HINT).toMatch(/the part still builds/);
  expect(SHEET_READ_ERROR_HINT).not.toMatch(/is the usual cause/);
});

// The notice names what the checks actually spend time on. Asking for "fewer … rounded
// corners" sent an agent after corners that cost milliseconds to check (a radius equal to
// the stock); only corners rounded tighter than the stock, and round holes crowded
// together, are what price a profile out.
test("the budget notice says what costs, not to strip rounded corners", () => {
  expect(SHEET_CHECKS_NOTICE.hint).toMatch(/tighter than about the sheet thickness/);
  expect(SHEET_CHECKS_NOTICE.hint).not.toMatch(/rounded corners make them fit/);
});

test("Profiles & patterns points at the section (P1a's pointer)", () => {
  const i = guide.indexOf("\n## Profiles & patterns\n");
  expect(guide.slice(i, guide.indexOf("\n## ", i + 1))).toContain("[Sheet parts](#sheet-parts)");
});

// The section recommends an author `place` for an angled panel; that place also takes the
// laser burns off the panel in realistic mode (materials/sheet-look.js burnsFor), and this
// topic is served on its own, so it has to say so where it recommends one.
test("Limits' angled-panel advice says a views entry costs the realistic laser burns", () => {
  const bullet = subsection("Limits").split("\n- ").find((b) => b.includes("`views` entry"));
  expect(bullet).toBeDefined();
  expect(bullet.replace(/\s+/g, " ")).toContain("no laser burns");
});
