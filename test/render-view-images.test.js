import { beforeAll, expect, test } from "vitest";
import { PNG } from "pngjs";
import { bootManifoldKernel, renderViewImages, RENDER_STYLES } from "../src/testing.js";
import demo from "../src/parts/demo.js";
import hinged from "../src/parts/hinged-box.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const hex = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];

test("renders in memory: one PNG buffer per angle, the cad light background", async () => {
  const imgs = await renderViewImages(k, demo, "spacer", { views: ["iso", "top"], size: [200, 150] });
  expect(imgs.map((i) => i.angle)).toEqual(["iso", "top"]);
  const png = PNG.sync.read(imgs[0].png);
  expect([png.width, png.height]).toEqual([200, 150]);
  const bg = hex(RENDER_STYLES.cad.background);
  expect([png.data[0], png.data[1], png.data[2]].every((v, i) => Math.abs(v - bg[i]) <= 1)).toBe(true);
});

test("the thumbnail style renders the product shot", async () => {
  const [img] = await renderViewImages(k, demo, "spacer", { views: ["iso"], size: [160, 160], style: "thumbnail" });
  const png = PNG.sync.read(img.png);
  const bg = hex(RENDER_STYLES.thumbnail.background);
  expect([png.data[0], png.data[1], png.data[2]].every((v, i) => Math.abs(v - bg[i]) <= 1)).toBe(true);
});

test("sub-part display materials reach the CPU render (hinged box is walnut)", async () => {
  const [img] = await renderViewImages(k, hinged, "box", { views: ["front"], size: [64, 64], edges: false });
  const png = PNG.sync.read(img.png);
  const c = (32 * 64 + 32) * 4;
  expect(png.data[c]).toBeGreaterThan(png.data[c + 2] + 10); // warm, not the default blue-grey
});

test("an unknown angle keeps its old message", async () => {
  await expect(renderViewImages(k, demo, "spacer", { views: ["sideways"] })).rejects.toThrow(/unknown angle "sideways"/);
});

test("an unknown style fails before the kernel is touched", async () => {
  const kernel = new Proxy({}, { get() { throw new Error("kernel touched"); } });
  await expect(renderViewImages(kernel, demo, "spacer", { style: "nope" })).rejects.toThrow(/unknown render style "nope"/);
});

test("a non-positive or non-finite supersample is refused", async () => {
  for (const supersample of [0, -1, NaN, Infinity]) {
    await expect(renderViewImages(k, demo, "spacer", { views: ["iso"], size: [32, 32], supersample }))
      .rejects.toThrow("renderStyled: supersample must be a positive integer");
  }
});
