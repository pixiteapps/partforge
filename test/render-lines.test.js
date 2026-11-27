import { beforeAll, expect, test, vi } from "vitest";
import { PNG } from "pngjs";
import { bootManifoldKernel, renderViewImages } from "../src/testing.js";
import { LINE_COLOR } from "../src/framework/lines/tube.js";
import capstan from "../src/parts/capstan-joint.js";
import demo from "../src/parts/demo.js";

vi.mock("../src/framework/lines/meshes.js", async (orig) => {
  const real = await orig();
  return { ...real, lineMeshes: vi.fn(real.lineMeshes) };
});
const { lineMeshes } = await import("../src/framework/lines/meshes.js");

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const OPTS = { views: ["front"], size: [160, 120], supersample: 1 };
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
// Pixels of the rope's hue: LINE_COLOR is warm (red above blue) where the part, the
// background and the shadow are blue-grey, and shading only scales its brightness.
const warm = (png) => {
  const [r, , b] = rgb(LINE_COLOR);
  const ratio = (r - b) / r;
  let n = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const R = png.data[i], B = png.data[i + 2];
    if (R > 60 && Math.abs((R - B) / R - ratio) <= 0.05) n++;
  }
  return n;
};

test("a declared rope is drawn as a tube in the render", async () => {
  const [withLines] = await renderViewImages(k, capstan, "assembly", OPTS);
  const [without] = await renderViewImages(k, { ...capstan, lines: undefined }, "assembly", OPTS);
  expect(Buffer.compare(withLines.png, without.png)).not.toBe(0);
  expect(warm(PNG.sync.read(withLines.png))).toBeGreaterThan(10);
  expect(warm(PNG.sync.read(without.png))).toBe(0);
});

test("a part with no lines never reaches lineMeshes", async () => {
  const plain = await renderViewImages(k, demo, "spacer", OPTS);
  lineMeshes.mockClear();
  lineMeshes.mockImplementation(() => { throw new Error("lineMeshes must not be called"); });
  const again = await renderViewImages(k, demo, "spacer", OPTS);
  expect(lineMeshes).not.toHaveBeenCalled();
  expect(Buffer.compare(again[0].png, plain[0].png)).toBe(0);
});
