import { statSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { ENVIRONMENTS } from "../../src/framework/materials/environments.js";
import { PATTERN_TEXTURES } from "../../src/framework/materials/assets.js";

const dir = new URL("../../src/framework/materials/assets/", import.meta.url);
const files = () => {
  const out = new Set(Object.values(PATTERN_TEXTURES));
  for (const e of Object.values(ENVIRONMENTS)) {
    out.add(e.hdr); out.add(e.ground.texture);
    if (e.ground.roughnessTexture) out.add(e.ground.roughnessTexture);
  }
  return [...out];
};

test("every referenced asset exists", () => {
  for (const f of files()) expect(existsSync(fileURLToPath(new URL(f, dir))), f).toBe(true);
});

test("assets stay inside their size budgets", () => {
  for (const f of files()) {
    const size = statSync(fileURLToPath(new URL(f, dir))).size;
    const budget = f.startsWith("env-") ? 1_500_000 : 400_000;
    expect(size, `${f} is ${size} bytes`).toBeLessThanOrEqual(budget);
  }
});

test("every asset has a recorded source and licence", () => {
  const sources = readFileSync(fileURLToPath(new URL("SOURCES.md", dir)), "utf8");
  for (const f of files()) expect(sources, f).toContain(f);
  expect(sources).toContain("CC0");
});

test("environment files are UltraHDR (gainmap) JPEGs", () => {
  for (const e of Object.values(ENVIRONMENTS)) {
    const bytes = readFileSync(fileURLToPath(new URL(e.hdr, dir)));
    expect(bytes[0] === 0xff && bytes[1] === 0xd8, e.hdr).toBe(true);
    expect(bytes.includes(Buffer.from("hdrgm")), `${e.hdr} carries no gainmap metadata`).toBe(true);
  }
});
