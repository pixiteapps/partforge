import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";
import { sheetPart } from "../src/framework/sheet/part.js";

const goodPart = () => ({
  meta: { title: "Test", units: "mm" },
  defaults: { h: 10 },
  parts: { body: { label: "Body", views: ["main"], build: (k, p) => k.box({ size: [p.h, p.h, p.h] }) } },
  views: { main: { label: "Main" } },
});
const warnIds = (part) => lintPart(part).warnings.map((f) => f.rule);

test("a known preset, tint, override and environment produce no material findings", () => {
  const part = goodPart();
  part.parts.body.display = { material: "anodized-aluminum", color: 0xb3261e, roughness: 0.3 };
  part.meta.environment = "workshop";
  const ids = warnIds(part);
  for (const id of ["unknown-material", "unknown-environment", "material-key-unknown", "material-override-clamped"]) {
    expect(ids).not.toContain(id);
  }
  expect(lintPart(part).ok).toBe(true);
});

test("an unknown preset is a warning with the path and a suggestion", () => {
  const part = goodPart();
  part.parts.body.display = { material: "brushed-aluminium" };
  const f = lintPart(part).warnings.find((w) => w.rule === "unknown-material");
  expect(f.path).toBe("parts.body.display.material");
  expect(f.hint).toContain("brushed-aluminum");
  expect(lintPart(part).ok).toBe(true); // warnings never fail
});

test("an unknown environment is a warning", () => {
  const part = goodPart();
  part.meta.environment = "moon";
  expect(warnIds(part)).toContain("unknown-environment");
});

test("an unknown display key is a warning", () => {
  const part = goodPart();
  part.parts.body.display = { material: "brass", sheen: 1 };
  const f = lintPart(part).warnings.find((w) => w.rule === "material-key-unknown");
  expect(f.path).toBe("parts.body.display.sheen");
});

test("an out-of-range override is a warning naming the clamped value", () => {
  const part = goodPart();
  part.parts.body.display = { material: "brass", roughness: 2 };
  const f = lintPart(part).warnings.find((w) => w.rule === "material-override-clamped");
  expect(f.message).toContain("1");
  expect(f.path).toBe("parts.body.display.roughness");
});

test("a legacy color/opacity display produces no material findings", () => {
  const part = goodPart();
  part.parts.body.display = { color: 0x1e88e5, opacity: 0.3 };
  expect(warnIds(part).filter((id) => id.includes("material"))).toEqual([]);
});

test("an unknown material on a laser sheet names the stock's look the viewer falls back to", () => {
  const part = goodPart();
  part.parts.body = sheetPart({ label: "Body", views: ["main"], display: { material: "birch" }, material: "birch plywood",
    thickness: 3, profile: (k) => k.shape2d([[0, 0], [30, 0], [30, 30], [0, 30]]) });
  const f = lintPart(part).warnings.find((w) => w.rule === "unknown-material");
  expect(f.hint).toContain("`plywood`");
  expect(f.hint).not.toContain("PLA print");
  // an ordinary sub-part keeps the PLA wording
  const plain = goodPart();
  plain.parts.body.display = { material: "birch" };
  expect(lintPart(plain).warnings.find((w) => w.rule === "unknown-material").hint).toContain("a PLA print in realistic mode");
});

// A stock label written as a function is never read (sheet-look.js stockLook), so the hint
// must not credit the look to the label: `(p) => "clear acrylic"` still falls back to plywood.
test("an unknown material on a sheet whose stock label is a function says the label was not read", () => {
  const part = goodPart();
  part.parts.body = sheetPart({ label: "Body", views: ["main"], display: { material: "birch" }, material: () => "clear acrylic",
    thickness: 3, profile: (k) => k.shape2d([[0, 0], [30, 0], [30, 30], [0, 30]]) });
  const f = lintPart(part).warnings.find((w) => w.rule === "unknown-material");
  expect(f.hint).toContain("`plywood`");
  expect(f.hint).not.toContain("from its stock label");
  expect(f.hint).toContain("its stock label is a function");
});

// Cloud's sanitizers cut a hint at 500 characters: the longest suggestion with every
// fallback wording still has to fit whole.
test("every unknown-material hint fits in 500 characters, longest suggestion included", async () => {
  const { PRESETS } = await import("../src/framework/materials/presets.js");
  const longest = Object.keys(PRESETS).reduce((a, b) => (b.length > a.length ? b : a));
  const typo = `${longest}x`;
  const sheet = (material) => sheetPart({ label: "Body", views: ["main"], display: { material: typo }, material,
    thickness: 3, profile: (k) => k.shape2d([[0, 0], [30, 0], [30, 30], [0, 30]]) });
  const plain = goodPart();
  plain.parts.body.display = { material: typo };
  const parts = [plain, ...["birch plywood", "clear acrylic", () => "birch plywood"].map((m) => {
    const part = goodPart();
    part.parts.body = sheet(m);
    return part;
  })];
  for (const part of parts) {
    const f = lintPart(part).warnings.find((w) => w.rule === "unknown-material");
    expect(f.hint).toContain(`Did you mean "${longest}"?`);
    expect(f.hint.length, f.hint).toBeLessThanOrEqual(500);
  }
});
