// @vitest-environment happy-dom
//
// happy-dom is needed for the two MPF/decoder tests below: three's UltraHDRLoader
// uses DOMParser to read XMP metadata, and happy-dom's is what vitest wires up
// globally under this pragma (see test/vector-thumb.test.js for the same pattern).
//
// File paths are built with node:path rather than `new URL(relative, base)`: happy-dom
// installs its own browser-faithful URL global that refuses to resolve a relative
// string against a file: base when that resolution happens at MODULE TOP LEVEL (it
// works fine once inside a running test, after environment setup has settled) —
// `node:path` has no such timing hazard.
import { statSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { ENVIRONMENTS } from "../../src/framework/materials/environments.js";
import { PATTERN_TEXTURES } from "../../src/framework/materials/assets.js";
import { UltraHDRLoader } from "three/addons/loaders/UltraHDRLoader.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src/framework/materials/assets/");
const assetPath = (name) => path.join(dir, name);
const files = () => {
  const out = new Set(Object.values(PATTERN_TEXTURES));
  for (const e of Object.values(ENVIRONMENTS)) {
    out.add(e.hdr); out.add(e.ground.texture);
    if (e.ground.roughnessTexture) out.add(e.ground.roughnessTexture);
  }
  return [...out];
};

test("every referenced asset exists", () => {
  for (const f of files()) expect(existsSync(assetPath(f)), f).toBe(true);
});

test("assets stay inside their size budgets", () => {
  for (const f of files()) {
    const size = statSync(assetPath(f)).size;
    const budget = f.startsWith("env-") ? 1_500_000 : 400_000;
    expect(size, `${f} is ${size} bytes`).toBeLessThanOrEqual(budget);
  }
});

test("every asset has a recorded source and licence", () => {
  const sources = readFileSync(assetPath("SOURCES.md"), "utf8");
  for (const f of files()) expect(sources, f).toContain(f);
  expect(sources).toContain("CC0");
});

test("environment files are UltraHDR (gainmap) JPEGs", () => {
  for (const e of Object.values(ENVIRONMENTS)) {
    const bytes = readFileSync(assetPath(e.hdr));
    expect(bytes[0] === 0xff && bytes[1] === 0xd8, e.hdr).toBe(true);
    expect(bytes.includes(Buffer.from("hdrgm")), `${e.hdr} carries no gainmap metadata`).toBe(true);
  }
});

// Re-merging ultrahdr_app's SDR+gainmap output with a freshly-written MPF/XMP block
// (see SOURCES.md) can leave ultrahdr_app's OWN, now-stale MPF segment sitting later
// in the file — and three's UltraHDRLoader keeps whichever MPF segment it sees LAST,
// so a stale one silently wins and slices the wrong bytes. Guard against that class
// of bug directly, both structurally (exactly one MPF segment) and behaviourally (the
// real loader's own slicing produces whole, valid JPEGs).
test("environment files carry exactly one MPF (Multi-Picture Format) segment", () => {
  const mpfSignature = Buffer.from([0x4d, 0x50, 0x46, 0x00]); // "MPF\0"
  for (const e of Object.values(ENVIRONMENTS)) {
    const bytes = readFileSync(assetPath(e.hdr));
    let mpfCount = 0;
    let offset = 2; // past SOI
    while (offset < bytes.length - 1) {
      expect(bytes[offset], `${e.hdr}: expected a marker at byte ${offset}`).toBe(0xff);
      const marker = bytes[offset + 1];
      if (marker === 0xda) break; // SOS: header segments are over
      const len = bytes.readUInt16BE(offset + 2);
      if (marker === 0xe2 && bytes.subarray(offset + 4, offset + 8).equals(mpfSignature)) mpfCount++;
      offset += 2 + len;
    }
    expect(mpfCount, `${e.hdr} should carry exactly one MPF segment, found ${mpfCount}`).toBe(1);
  }
});

test("UltraHDRLoader slices each environment file into two whole, valid JPEGs", () => {
  for (const e of Object.values(ENVIRONMENTS)) {
    const bytes = readFileSync(assetPath(e.hdr));
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    const loader = new UltraHDRLoader();
    let slices = null;
    // Stop short of the GPU decode step (createImageBitmap/WebGL isn't available in
    // Node) — everything up to here, including the MPF-driven slicing, is real.
    loader._applyGainmapToSDR = (metadata, primaryImage, gainmapImage) => {
      slices = { primaryImage, gainmapImage };
    };
    loader.parse(arrayBuffer, () => {
      throw new Error(`${e.hdr}: onLoad fired — _applyGainmapToSDR was not intercepted`);
    });

    expect(slices, `${e.hdr}: UltraHDRLoader did not find both a primary and a gain-map image`).not.toBeNull();
    const { primaryImage, gainmapImage } = slices;
    const startsWithSoi = (buf) => buf[0] === 0xff && buf[1] === 0xd8;
    const endsWithEoi = (buf) => buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
    expect(startsWithSoi(primaryImage), `${e.hdr}: primary slice does not start with SOI`).toBe(true);
    expect(endsWithEoi(primaryImage), `${e.hdr}: primary slice does not end with EOI (length ${primaryImage.length})`).toBe(true);
    expect(startsWithSoi(gainmapImage), `${e.hdr}: gainmap slice does not start with SOI`).toBe(true);
    expect(endsWithEoi(gainmapImage), `${e.hdr}: gainmap slice does not end with EOI (length ${gainmapImage.length})`).toBe(true);
  }
});

// The outdoor rig is lit by a bright overcast sky: an untinted concrete map
// (sRGB ~185) rendered near-white and blue. Its ground is tinted down to a warm
// mid-grey so it reads as concrete; this pins the direction, not the shade.
test("the outdoor ground is tinted down to a warm grey", async () => {
  const { ENVIRONMENTS } = await import("../../src/framework/materials/environments.js");
  const t = ENVIRONMENTS.outdoor.ground.tint;
  const [r, g, b] = [(t >> 16) & 255, (t >> 8) & 255, t & 255];
  expect(Math.max(r, g, b)).toBeLessThanOrEqual(0xb0);
  expect(r).toBeGreaterThanOrEqual(b);
});
