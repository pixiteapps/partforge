import { beforeAll, afterAll, expect, test } from "vitest";
import { rmSync, readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { bootOcctKernel } from "../src/testing/occt.js";
import { renderViews } from "../src/testing/render.js";
import part from "../src/parts/filleted-box.js";
import { RENDER_STYLES } from "../src/framework/renderStyles.js";
const CAD_BG = [(RENDER_STYLES.cad.background >> 16) & 255, (RENDER_STYLES.cad.background >> 8) & 255, RENDER_STYLES.cad.background & 255];

let k;
const OUT = "test/.render-occt";
beforeAll(async () => { k = await bootOcctKernel(); });
afterAll(() => rmSync(OUT, { recursive: true, force: true }));

// OCCT meshes are INDEXED (unlike Manifold's non-indexed soup) and carry real
// analytic per-vertex normals. A rasterizer that assumes the wrong layout (or
// mishandles the indices) produces a black, scrambled image. This asserts the
// part renders AND is actually lit (mean brightness of the rendered pixels is
// high) — a plain non-blank check passes on the black garbage.
test("renders an OCCT (indexed) part as a lit, non-blank image", async () => {
  const files = await renderViews(k, part, "box", { views: ["iso"], out: OUT, size: [240, 180] });
  expect(files).toHaveLength(1);
  const png = PNG.sync.read(readFileSync(files[0]));
  const bg = CAD_BG;
  let nonBg = 0, brightnessSum = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    if (Math.abs(r - bg[0]) > 8 || Math.abs(g - bg[1]) > 8 || Math.abs(b - bg[2]) > 8) {
      nonBg++; brightnessSum += (r + g + b) / 3;
    }
  }
  expect(nonBg).toBeGreaterThan(300);            // the box actually rendered
  expect(brightnessSum / nonBg).toBeGreaterThan(50); // and it's lit, not a black scramble
});
