import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";

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
