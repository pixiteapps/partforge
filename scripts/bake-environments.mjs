#!/usr/bin/env node
// One-shot DEV tool (outputs are committed; nothing runs this at build time).
//
//   node scripts/bake-environments.mjs <in.hdr> <out-name.jpg> [--size WxH]
//     HDR -> UltraHDR (gainmap) JPEG, default 2048x1024.
//   node scripts/bake-environments.mjs --texture <in.jpg|png> <out-name.jpg> [--gray] [--tint r,g,b] [--size N]
//     Any raster -> square JPEG q82, default 1024x1024.
//   node scripts/bake-environments.mjs --carbon <out-name.jpg> [--size N]
//     Procedural 2x2 twill weave tile (no source asset) -> square JPEG q82, default 256x256.
//   node scripts/bake-environments.mjs --speckle <out-name.jpg> [--tint r,g,b] [--size N]
//     Procedural fine-grain colour speckle (no source asset) -> square JPEG q82, default 1024x1024.
//
// Environments become gainmap JPEGs (an SDR base + an HDR gain map in one file) that
// three's UltraHDRLoader decodes: a few hundred KB instead of a multi-MB .hdr.
//
// @monogrid/gainmap-js's `encode()` (and `findTextureMinMax()`, which it depends on
// internally) render through a THREE.WebGLRenderer/QuadRenderer pipeline — every path
// through it, including the "pure computation" helper, ends up constructing a
// WebGLRenderer if one isn't supplied. There is no WebGL context in plain Node (no
// canvas, no headless-gl in this tree), so that whole surface is impractical here per
// the task's own escape hatch. Instead this script decodes the .hdr with three's own
// HDRLoader (pure JS, no GL) into a raw RGBA half-float buffer and hands that to
// Google's `ultrahdr_app` CLI (libultrahdr, installed via `brew install libultrahdr`),
// which derives the SDR rendition and computes+encodes the gain map itself, appending
// it as a second embedded JPEG (MPF-style). ultrahdr_app 2.0.2 only writes the newer
// ISO 21496-1 binary-box gainmap metadata, not the legacy Adobe XMP ("hdrgm"-prefixed)
// block that older decoders (and this project's own asset test) look for, so this
// script splits the two embedded JPEG streams back out and re-merges them with
// `@monogrid/gainmap-js`'s `encodeJPEGMetadata` (pure JS, no WebGL — it only writes
// JPEG markers) to add that legacy XMP block. The boost values it writes are read back
// off ultrahdr_app's own probe (`-P`) of its ISO output, so the two encoders agree; a
// re-probe of the merged file (`ultrahdr_app -m 1 -j <file> -P`) round-trips the same
// numbers back out, confirming the legacy block is self-consistent.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { encodeJPEGMetadata } from "@monogrid/gainmap-js/libultrahdr";

const outPath = (name) =>
  new URL(`../src/framework/materials/assets/${name}`, import.meta.url);

// APP2 segment payload signatures to strip (see the call sites for why).
const MPF_SIGNATURE = Buffer.from([0x4d, 0x50, 0x46, 0x00]); // "MPF\0"
const ISO_GAINMAP_SIGNATURE = Buffer.from("urn:iso:std:iso:ts:21496:-1\0", "latin1");

// Removes top-level APPn segments (0xE0-0xEF) from a single JPEG (SOI...EOI) whose
// payload starts with one of `signatures`, leaving every other byte — including the
// entropy-coded scan data after SOS, which this never inspects — untouched. Segments
// are only ever defined between SOI and SOS, so once SOS is reached the remainder of
// the buffer is copied through verbatim.
function stripAppSegments(jpeg, signatures) {
  const out = [jpeg.subarray(0, 2)]; // SOI
  let offset = 2;
  while (offset < jpeg.length) {
    if (jpeg[offset] !== 0xff) throw new Error(`bake-environments: expected a marker at byte ${offset}`);
    const marker = jpeg[offset + 1];
    if (marker === 0xda) { // SOS: header segments are over; copy the rest as-is.
      out.push(jpeg.subarray(offset));
      break;
    }
    const length = jpeg.readUInt16BE(offset + 2);
    const segment = jpeg.subarray(offset, offset + 2 + length);
    const isApp = marker >= 0xe0 && marker <= 0xef;
    const payload = segment.subarray(4); // after marker (2) + length (2)
    const drop = isApp && signatures.some((sig) => payload.subarray(0, sig.length).equals(sig));
    if (!drop) out.push(segment);
    offset += 2 + length;
  }
  return Buffer.concat(out);
}

function parseSize(argv, fallback) {
  const i = argv.indexOf("--size");
  if (i === -1) return fallback;
  const raw = argv[i + 1];
  if (raw.includes("x")) {
    const [w, h] = raw.split("x").map(Number);
    return [w, h];
  }
  const n = Number(raw);
  return [n, n];
}

async function bakeTexture(argv) {
  const [input, name] = argv;
  const gray = argv.includes("--gray");
  const [size] = parseSize(argv, [1024]);
  const tintFlag = argv.indexOf("--tint");

  let img = sharp(input).resize(size, size, { fit: "cover" });
  if (tintFlag !== -1) {
    const [r, g, b] = argv[tintFlag + 1].split(",").map(Number);
    img = img.tint({ r, g, b });
  }
  if (gray) img = img.grayscale();
  const buffer = await img.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  writeFileSync(outPath(name), buffer);
  console.log(`${name}: ${buffer.length} bytes`);
}

const clamp8 = (v) => Math.max(0, Math.min(255, Math.round(v)));

// A fine, per-pixel granular speckle around a base tint — a textured-PEI build-plate
// look (think Prusa/Bambu "textured" sheets: a warm matte base flecked with small
// bright/dark grains, not a smooth gradient or large blobs). No CC0 source on
// ambientCG had this at fine-enough grain in its COLOUR map (Plastic010's colour map
// is itself near-uniform, stdev < 1/channel — the grain there lives only in its
// roughness map), so this is generated the same way pattern-carbon.jpg is: procedurally,
// no external source. Per-pixel noise (irwin-hall/triangular, so most pixels sit near
// the base tone with fewer extreme flecks than uniform noise would give) then a small
// blur to turn single-pixel noise into soft grains instead of a harsh salt-and-pepper
// pattern.
async function bakeSpeckle(argv) {
  const [name] = argv;
  const [size] = parseSize(argv, [1024]);
  const tintFlag = argv.indexOf("--tint");
  const [baseR, baseG, baseB] = tintFlag !== -1
    ? argv[tintFlag + 1].split(",").map(Number)
    : [196, 154, 82];
  const amplitude = 34;

  const data = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    // Sum of three uniforms in [-0.5, 0.5] approximates a triangular distribution:
    // most grains are subtle, a few are strongly bright/dark flecks.
    const n = (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
    const delta = n * amplitude;
    const p = i * 3;
    data[p] = clamp8(baseR + delta);
    data[p + 1] = clamp8(baseG + delta * 0.88);
    data[p + 2] = clamp8(baseB + delta * 0.62);
  }
  const buffer = await sharp(data, { raw: { width: size, height: size, channels: 3 } })
    .blur(0.5)
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  writeFileSync(outPath(name), buffer);
  console.log(`${name}: ${buffer.length} bytes (procedural speckle, ${size}x${size})`);
}

// A 2x2 twill weave: two interleaved sets of diagonal bands (warp/weft), each band a
// dark/light carbon-fiber grey, offset by a phase step every two threads so the classic
// "broken diagonal" twill pattern falls out. Rendered as raw RGB then handed to sharp.
async function bakeCarbon(argv) {
  const [name] = argv;
  const [size] = parseSize(argv, [256]);
  const threadPx = Math.max(1, Math.round(size / 32)); // 32 threads/tile
  const data = Buffer.alloc(size * size * 3);
  const dark = [28, 28, 32];
  const light = [58, 58, 64];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tx = Math.floor(x / threadPx);
      const ty = Math.floor(y / threadPx);
      // 2x2 twill: weft thread is "up" (light) when (tx - ty) mod 4 is 0 or 1.
      const phase = ((tx - ty) % 4 + 4) % 4;
      const up = phase < 2;
      const [r, g, b] = up ? light : dark;
      const i = (y * size + x) * 3;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }
  const buffer = await sharp(data, { raw: { width: size, height: size, channels: 3 } })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  writeFileSync(outPath(name), buffer);
  console.log(`${name}: ${buffer.length} bytes (procedural twill, ${size}x${size})`);
}

async function bakeEnvironment(argv) {
  const [input, name] = argv;
  const [width, height] = parseSize(argv, [2048, 1024]);

  const bytes = readFileSync(input);
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const hdr = new HDRLoader().parse(arrayBuffer);
  // hdr.data is a Uint16Array of RGBA half-floats (three's default HDRLoader.type is
  // HalfFloatType), interleaved, alpha always 1 — exactly ultrahdr_app's `-a 4`
  // (rgbahalffloat) raw input format.
  let raw = hdr.data;
  let srcW = hdr.width;
  let srcH = hdr.height;
  if (srcW !== width || srcH !== height) {
    raw = resizeHalfFloatRGBA(raw, srcW, srcH, width, height);
  }

  const workDir = mkdtempSync(join(tmpdir(), "pf-bake-"));
  const rawPath = join(workDir, "in.raw");
  const outJpg = join(workDir, "out.jpg");
  writeFileSync(rawPath, Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength));

  execFileSync(
    "ultrahdr_app",
    [
      "-m", "0",
      "-p", rawPath,
      "-a", "4", // rgbahalffloat
      "-t", "0", // linear transfer (required pairing with rgbahalffloat)
      "-w", String(width),
      "-h", String(height),
      "-q", "80", // sdr jpeg quality
      "-Q", "80", // gainmap jpeg quality
      "-s", "2", // gainmap downsample factor, halves gainmap resolution
      "-z", outJpg,
    ],
    { stdio: "inherit" },
  );

  // Read back the boost values ultrahdr_app itself computed, so the legacy XMP block
  // this script writes agrees with the ISO box ultrahdr_app wrote.
  const probe = execFileSync("ultrahdr_app", ["-m", "1", "-j", outJpg, "-P"], {
    encoding: "utf8",
  });
  const num = (flag) => Number(probe.match(new RegExp(`--${flag} (\\S+)`))[1]);
  const maxContentBoost = num("maxContentBoost");
  const minContentBoost = num("minContentBoost");
  const gamma = num("gamma");
  const offsetSdr = num("offsetSdr");
  const offsetHdr = num("offsetHdr");
  const gainMapMinLog2 = Math.log2(minContentBoost);
  const gainMapMaxLog2 = Math.log2(maxContentBoost);

  // ultrahdr_app's scenario-0 output is the primary (SDR) JPEG immediately followed by
  // a second, complete JPEG stream holding the gain map (MPF-style concatenation) —
  // split on the second SOI marker.
  const merged = readFileSync(outJpg);
  const secondSoi = merged.indexOf(Buffer.from([0xff, 0xd8, 0xff]), 3);
  // Strip ultrahdr_app's own APP2 MPF and ISO 21496-1 metadata segments from both
  // halves before handing them to encodeJPEGMetadata. It writes its OWN MPF segment
  // (with offsets recomputed for the new, larger file it assembles) and its own legacy
  // XMP gain-map metadata, but it does not touch anything already inside the sdr/
  // gainMap JPEG bytes it's given — so ultrahdr_app's original MPF and ISO boxes would
  // otherwise survive alongside the new ones. Three's UltraHDRLoader walks every
  // top-level JPEG section across the *whole* concatenated file (it has no notion of
  // "this file's images end here") and keeps whichever MPF/ISO segment it sees LAST,
  // overwriting metadata it already parsed from ours — so a leftover stale MPF (wrong
  // offsets: verified it slices a primary image that doesn't even end on a real EOI)
  // silently wins, and a leftover stale ISO box silently overwrites the correct
  // gain-map numbers our new XMP carries. Both must go.
  const sdrBytes = stripAppSegments(merged.subarray(0, secondSoi), [MPF_SIGNATURE, ISO_GAINMAP_SIGNATURE]);
  const gainMapBytes = stripAppSegments(merged.subarray(secondSoi), [MPF_SIGNATURE, ISO_GAINMAP_SIGNATURE]);
  const sdrMeta = await sharp(sdrBytes).metadata();
  const gainMapMeta = await sharp(gainMapBytes).metadata();

  const jpeg = Buffer.from(
    encodeJPEGMetadata({
      sdr: { data: sdrBytes, mimeType: "image/jpeg", width: sdrMeta.width, height: sdrMeta.height },
      gainMap: { data: gainMapBytes, mimeType: "image/jpeg", width: gainMapMeta.width, height: gainMapMeta.height },
      gamma: [gamma, gamma, gamma],
      offsetSdr: [offsetSdr, offsetSdr, offsetSdr],
      offsetHdr: [offsetHdr, offsetHdr, offsetHdr],
      hdrCapacityMin: gainMapMinLog2,
      hdrCapacityMax: gainMapMaxLog2,
      gainMapMin: [gainMapMinLog2, gainMapMinLog2, gainMapMinLog2],
      gainMapMax: [gainMapMaxLog2, gainMapMaxLog2, gainMapMaxLog2],
    }),
  );

  writeFileSync(outPath(name), jpeg);
  rmSync(workDir, { recursive: true, force: true });
  console.log(`${name}: ${jpeg.length} bytes (${width}x${height} UltraHDR, legacy XMP gainmap)`);
}

// Half-float RGBA <-> Float32 helpers (Node has no Float16Array), then a simple
// box-filter downsample. Environment maps only ever get scaled DOWN here (the re-bake
// escape hatch for an over-budget file), so a box filter is enough — no need for
// anything fancier than area averaging.
function halfToFloat(h) {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * 2 ** -14 * (f / 1024);
  if (e === 0x1f) return f ? NaN : (s ? -1 : 1) * Infinity;
  return (s ? -1 : 1) * 2 ** (e - 15) * (1 + f / 1024);
}

function floatToHalf(v) {
  if (Number.isNaN(v)) return 0x7e00;
  const sign = v < 0 ? 1 : 0;
  v = Math.abs(v);
  if (v === 0) return sign << 15;
  if (v === Infinity) return (sign << 15) | 0x7c00;
  let e = Math.floor(Math.log2(v));
  let m = v / 2 ** e - 1;
  e += 15;
  if (e <= 0) {
    // subnormal
    m = v / 2 ** -14;
    return (sign << 15) | Math.round(m * 1024) & 0x3ff;
  }
  if (e >= 0x1f) return (sign << 15) | 0x7c00; // overflow -> inf
  return (sign << 15) | (e << 10) | (Math.round(m * 1024) & 0x3ff);
}

function resizeHalfFloatRGBA(src, srcW, srcH, dstW, dstH) {
  const dst = new Uint16Array(dstW * dstH * 4);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    const sy0 = Math.floor(dy * yRatio);
    const sy1 = Math.max(sy0 + 1, Math.floor((dy + 1) * yRatio));
    for (let dx = 0; dx < dstW; dx++) {
      const sx0 = Math.floor(dx * xRatio);
      const sx1 = Math.max(sx0 + 1, Math.floor((dx + 1) * xRatio));
      let r = 0, g = 0, b = 0, count = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * srcW + sx) * 4;
          r += halfToFloat(src[i]);
          g += halfToFloat(src[i + 1]);
          b += halfToFloat(src[i + 2]);
          count++;
        }
      }
      const di = (dy * dstW + dx) * 4;
      dst[di] = floatToHalf(r / count);
      dst[di + 1] = floatToHalf(g / count);
      dst[di + 2] = floatToHalf(b / count);
      dst[di + 3] = floatToHalf(1);
    }
  }
  return dst;
}

const argv = process.argv.slice(2);
if (argv[0] === "--texture") {
  await bakeTexture(argv.slice(1));
} else if (argv[0] === "--carbon") {
  await bakeCarbon(argv.slice(1));
} else if (argv[0] === "--speckle") {
  await bakeSpeckle(argv.slice(1));
} else {
  await bakeEnvironment(argv);
}
