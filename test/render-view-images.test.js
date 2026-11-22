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

test("the thumbnail style defaults to its own 4:3 size; an explicit size is honoured", async () => {
  const [def] = await renderViewImages(k, demo, "spacer", { views: ["iso"], style: "thumbnail", supersample: 1 });
  const p = PNG.sync.read(def.png);
  expect([p.width, p.height]).toEqual([640, 480]);
  const [explicit] = await renderViewImages(k, demo, "spacer", { views: ["iso"], style: "thumbnail", size: [100, 100], supersample: 1 });
  const e = PNG.sync.read(explicit.png);
  expect([e.width, e.height]).toEqual([100, 100]);
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

// The reference compare view on the CPU renderer: a plate against a reference of the
// plate plus a boss. Drawn as the comparison, the boss is Missing (blue) and the
// plate Matches (grey), whatever the reference's ghost display says.
const plateWithReference = () => ({
  meta: { title: "plate" },
  defaults: {},
  views: { main: {} },
  parts: {
    plate: { views: ["main"], reference: "scan", build: (kk) => kk.box({ size: [40, 40, 4] }) },
    scan: {
      views: ["main"],
      display: { opacity: 0.4, color: 0xff8800 },
      build: (kk) => kk.box({ size: [40, 40, 4] }).union(kk.box({ size: [10, 10, 10] }).at([0, 0, 4])),
    },
  },
});
const pixel = (png, x, y) => { const i = (y * png.width + x) * 4; return [png.data[i], png.data[i + 1], png.data[i + 2]]; };
const renderTop = async (kernel, part) => PNG.sync.read((await renderViewImages(kernel, part, "main", { views: ["top"], size: [96, 96], edges: false }))[0].png);

test("a view with a pair renders the comparison: the boss is Missing, the plate Matches", async () => {
  const png = await renderTop(k, plateWithReference());
  const boss = pixel(png, 48, 48);
  expect(boss[2]).toBeGreaterThan(boss[0] + 60); // the missing blue (#3b82f6), shaded
  expect(boss[2]).toBeGreaterThan(boss[1] + 20);
  const plate = pixel(png, 48, 14);
  const bg = hex(RENDER_STYLES.cad.background);
  expect(plate.every((v, i) => Math.abs(v - bg[i]) <= 3)).toBe(false); // on the part, not the background
  expect(Math.max(...plate) - Math.min(...plate)).toBeLessThan(30); // the common grey (#9ca3af): no orange ghost
  expect(plate[2]).toBeGreaterThanOrEqual(plate[0]);
});

test("a refused comparison renders the part and its ghost as before", async () => {
  const refused = { ...k, _compareSolids: () => ({ skipped: "too-large" }) };
  const without = { ...k, _compareSolids: undefined };
  const a = await renderTop(refused, plateWithReference());
  const b = await renderTop(without, plateWithReference());
  expect(Buffer.compare(PNG.sync.write(a), PNG.sync.write(b))).toBe(0);
  const boss = pixel(a, 48, 48);
  expect(boss[0]).toBeGreaterThan(boss[2]); // the warm ghost over the plate, no blue
});

test("a comparison that throws renders the part and its ghost, never fails the render", async () => {
  const throwing = { ...k, _compareSolids: () => { throw new Error("kernel trap"); } };
  const refused = { ...k, _compareSolids: () => ({ skipped: "too-large" }) };
  const a = await renderTop(throwing, plateWithReference());
  const b = await renderTop(refused, plateWithReference());
  expect(Buffer.compare(PNG.sync.write(a), PNG.sync.write(b))).toBe(0);
  // ...and a piece whose mesh cannot be read falls back the same way.
  const badMesh = { ...k, _compareSolids: () => ({ common: { toMesh: () => { throw new Error("mesh"); } }, missing: null, excess: null }) };
  const c = await renderTop(badMesh, plateWithReference());
  expect(Buffer.compare(PNG.sync.write(c), PNG.sync.write(b))).toBe(0);
});

test("a view with no pair renders byte-for-byte as without a comparison kernel", async () => {
  const spy = { ...k, _compareSolids: () => { throw new Error("no pair: never asked"); } };
  const [a] = await renderViewImages(spy, demo, "spacer", { views: ["iso"], size: [64, 64] });
  const [b] = await renderViewImages(k, demo, "spacer", { views: ["iso"], size: [64, 64] });
  expect(Buffer.compare(a.png, b.png)).toBe(0);
});

// A card thumbnail is the product shot of the part as authored (the browser's
// captureView draws no comparison), so the thumbnail style never compares: the
// server-made thumbnail matches the browser's. The agent's renders keep it.
test("the thumbnail style never draws the comparison", async () => {
  const without = { ...k, _compareSolids: undefined };
  const opts = { views: ["top"], size: [96, 96], edges: false, style: "thumbnail" };
  const [a] = await renderViewImages(k, plateWithReference(), "main", opts);
  const [b] = await renderViewImages(without, plateWithReference(), "main", opts);
  expect(Buffer.compare(a.png, b.png)).toBe(0);
});
