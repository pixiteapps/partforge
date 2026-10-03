#!/usr/bin/env node
// Dev tool, not a CI gate: renders the same part, view and style with BOTH
// renderers — the browser's three.js offscreen capture (window.__pfRuntime.
// captureView on the dev pages) and the CPU renderer (renderViewImages, under
// plain Node) — and compares them: silhouette IoU, mean colour difference
// over the part, and windowed luma SSIM. A drift in framing, lighting,
// colour space, edges or the contact shadow between the two shows up here.
// Each page also compares the runtime's captureViews(["iso"]) — the agent's
// live-scene capture — against a CPU cad render in the page's theme colours.
//
//   node scripts/check-softrender-parity.mjs [--out <dir>]
//
// With --out, writes <page>-<style|live-cad>-{browser,cpu,diff}.png per comparison
// (diff = |a − b| × 4). Exits 1 if any comparison misses THRESHOLDS or a page
// logged a console error. CHECK_PORT picks the Vite port (default 5192).
// Needs Playwright's Chromium (`npx playwright install chromium`).
import { chromium } from "playwright";
import sharp from "sharp";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bootManifoldKernel, renderViewImages } from "../src/testing.js";
import { RENDER_STYLES, CAD_LIGHT_THEME, CAD_DARK_THEME } from "../src/framework/renderStyles.js";

// Measured 2026-10-02, after both styles moved to the fitted framing (512², iso;
// browser = headless Chromium on SwiftShader, JPEG quality 1; the live-cad rows
// are 1024² at the runtime's own quality 0.9): worst IoU 0.9845 (propeller
// thumbnail — thin blades, so antialiased silhouette pixels weigh heavily),
// worst meanDiff 2.74 and worst SSIM 0.9752 (propeller cad). Each set at the
// worst value with a margin: IoU −0.005, meanDiff +2, SSIM −0.03. The live-cad
// rows land inside the same bounds, so they share them. Re-run 2026-10-02 with the
// thumbnail captured 4:3 (512×384): thumbnail worst IoU 0.9861, meanDiff 2.21,
// SSIM 0.9801 (propeller) — inside the same bounds, so they are unchanged.
const THRESHOLDS = { iou: 0.979, meanDiff: 4.7, ssim: 0.945 };

const FIXTURES = [
  { page: "demo.html", part: "src/parts/demo.js" },
  { page: "hinged-box.html", part: "src/parts/hinged-box.js" },
  { page: "propeller.html", part: "src/parts/propeller.js" },
];
const STYLES = ["cad", "thumbnail"];
const SIZE = 512;

const argv = process.argv.slice(2);
const outIdx = argv.indexOf("--out");
const out = outIdx === -1 ? null : argv[outIdx + 1];
if (out) mkdirSync(out, { recursive: true });
const PORT = Number(process.env.CHECK_PORT) || 5192;
const root = fileURLToPath(new URL("..", import.meta.url));
const viteBin = join(root, "node_modules/vite/bin/vite.js");

// silhouette = pixels further than 12 (max channel) from the style background
function silhouette(rgb, bg) {
  const m = new Uint8Array(rgb.length / 3);
  for (let i = 0; i < m.length; i++) {
    const d = Math.max(Math.abs(rgb[i * 3] - bg[0]), Math.abs(rgb[i * 3 + 1] - bg[1]), Math.abs(rgb[i * 3 + 2] - bg[2]));
    m[i] = d > 12 ? 1 : 0;
  }
  return m;
}
const iou = (a, b) => { let i = 0, u = 0; for (let k = 0; k < a.length; k++) { i += a[k] & b[k]; u += a[k] | b[k]; } return u ? i / u : 1; };
// mean absolute difference (0-255) over the union of both silhouettes
function meanDiff(a, b, ma, mb) {
  let s = 0, n = 0;
  for (let k = 0; k < ma.length; k++) if (ma[k] | mb[k]) { for (let c = 0; c < 3; c++) s += Math.abs(a[k * 3 + c] - b[k * 3 + c]); n += 3; }
  return n ? s / n : 0;
}
// windowed SSIM on luma, 8×8 windows, stride 4, over windows touching the union
function ssim(a, b, w, h, ma, mb) {
  const L = (p, k) => 0.2126 * p[k * 3] + 0.7152 * p[k * 3 + 1] + 0.0722 * p[k * 3 + 2];
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  let total = 0, count = 0;
  for (let y = 0; y + 8 <= h; y += 4) for (let x = 0; x + 8 <= w; x += 4) {
    let touched = false, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
      const k = (y + j) * w + x + i;
      touched ||= !!(ma[k] | mb[k]);
      const va = L(a, k), vb = L(b, k);
      sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
    }
    if (!touched) continue;
    const n = 64, mua = sa / n, mub = sb / n;
    const va = saa / n - mua * mua, vb = sbb / n - mub * mub, cov = sab / n - mua * mub;
    total += ((2 * mua * mub + C1) * (2 * cov + C2)) / ((mua * mua + mub * mub + C1) * (va + vb + C2));
    count++;
  }
  return count ? total / count : 1;
}

// Sizes are [width, height]: the thumbnail is captured 4:3, the cad looks square.
async function decode(buf, [w, h] = [SIZE, SIZE]) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== w || info.height !== h) throw new Error(`expected ${w}×${h} but decoded ${info.width}×${info.height}`);
  return data;
}
const png = (rgb, file, [w, h]) => sharp(Buffer.from(rgb), { raw: { width: w, height: h, channels: 3 } }).png().toFile(file);
// What each style's capture returns for a long edge of `long` px.
const sizeFor = (style, long) => [long, Math.round(long / (RENDER_STYLES[style].camera.aspect ?? 1))];
const rgbOf = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];

const errors = [];
const failures = [];
async function compare(label, a, b, bg, size, limits) {
  const ma = silhouette(a, bg), mb = silhouette(b, bg);
  const r = { iou: iou(ma, mb), meanDiff: meanDiff(a, b, ma, mb), ssim: ssim(a, b, size[0], size[1], ma, mb) };
  const miss = [r.iou < limits.iou && "iou", r.meanDiff > limits.meanDiff && "meanDiff", r.ssim < limits.ssim && "ssim"].filter(Boolean);
  console.log(`${label}: iou ${r.iou.toFixed(4)}  meanDiff ${r.meanDiff.toFixed(2)}  ssim ${r.ssim.toFixed(4)}${miss.length ? `  MISS ${miss.join(",")}` : ""}`);
  if (miss.length) failures.push(`${label}: ${miss.join(", ")}`);
  if (out) {
    const stem = join(out, label.replace(/\.html/, "").replace(/ /g, "-"));
    const d = Buffer.alloc(a.length);
    for (let i = 0; i < d.length; i++) d[i] = Math.min(255, Math.abs(a[i] - b[i]) * 4);
    await png(a, `${stem}-browser.png`, size);
    await png(b, `${stem}-cpu.png`, size);
    await png(d, `${stem}-diff.png`, size);
  }
}
const kernel = await bootManifoldKernel();
const vite = spawn(process.execPath, [viteBin, "--port", String(PORT), "--strictPort"], { cwd: root, detached: true, stdio: "ignore" });
let browser;
try {
  for (let tries = 0; ; tries++) {
    try { if ((await fetch(`http://localhost:${PORT}/${FIXTURES[0].page}`)).ok) break; } catch { /* not listening yet */ }
    if (tries > 240) throw new Error(`vite never answered on port ${PORT}`);
    await sleep(250);
  }
  browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader"] });
  for (const { page: pageName, part: partPath } of FIXTURES) {
    const part = (await import(pathToFileURL(join(root, partPath)).href)).default;
    const view = Object.keys(part.views)[0];
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("console", (m) => { if (m.type() === "error") errors.push(`${pageName}: ${m.text()}`); });
    page.on("pageerror", (e) => errors.push(`${pageName}: ${e}`));
    await page.goto(`http://localhost:${PORT}/${pageName}`);
    await page.waitForFunction(() => window.__pfRuntime, null, { timeout: 60_000 });
    // An autoplay animation (the hinged box's looping `cycle`) moves the live
    // params captureView builds at; stop() resets them to the part's defaults,
    // which is what the CPU side renders.
    await page.evaluate(async () => { await window.__pfRuntime.ready; window.__pfRuntime.animation?.stop(); });
    for (const style of STYLES) {
      // The part builds asynchronously: captureView resolves null until it can.
      let dataUrl = null;
      for (let tries = 0; !dataUrl; tries++) {
        dataUrl = await page.evaluate(({ view, style, size }) => window.__pfRuntime.captureView(view, { size, quality: 1, style, angle: "iso" }), { view, style, size: SIZE });
        if (!dataUrl) {
          if (tries > 120) throw new Error(`${pageName}: captureView never produced a ${style} image`);
          await sleep(500);
        }
      }
      const a = await decode(Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"), sizeFor(style, SIZE));
      const cpuSize = sizeFor(style, SIZE);
      const [{ png: cpuPng }] = await renderViewImages(kernel, part, view, { views: ["iso"], size: cpuSize, style });
      const b = await decode(cpuPng, cpuSize);
      await compare(`${pageName} ${style}`, a, b, rgbOf(RENDER_STYLES[style].background), cpuSize, THRESHOLDS);
    }
    // The LIVE-scene agent capture (captureViews → captureCanonicalViews), which
    // frames, lights and draws the part's own edges in the live scene rather
    // than captureView's throwaway one. It follows the page theme, so the CPU
    // side renders a cad variant in that theme's background and edge colour
    // (read off the capture's corner pixel); everything else is plain cad.
    let shots = [];
    for (let tries = 0; !shots?.length; tries++) {
      shots = await page.evaluate(() => window.__pfRuntime.captureViews(["iso"]));
      if (!shots?.length) {
        if (tries > 120) throw new Error(`${pageName}: captureViews never produced an image`);
        await sleep(500);
      }
    }
    const url = shots[0].dataUrl;
    const meta = await sharp(Buffer.from(url.slice(url.indexOf(",") + 1), "base64")).metadata();
    const liveSize = [meta.width, meta.height];
    const a = await decode(Buffer.from(url.slice(url.indexOf(",") + 1), "base64"), liveSize);
    const theme = [CAD_LIGHT_THEME, CAD_DARK_THEME]
      .map((t) => ({ t, d: rgbOf(t.bg).reduce((s, c, i) => s + Math.abs(c - a[i]), 0) }))
      .sort((x, y) => x.d - y.d)[0].t;
    const live = { ...RENDER_STYLES.cad, background: theme.bg, edges: { ...RENDER_STYLES.cad.edges, color: theme.line } };
    const [{ png: livePng }] = await renderViewImages(kernel, part, view, { views: ["iso"], size: liveSize, style: live });
    const b = await decode(livePng, liveSize);
    await compare(`${pageName} live-cad`, a, b, rgbOf(theme.bg), liveSize, THRESHOLDS);
    await page.close();
  }
} finally {
  await browser?.close();
  try { process.kill(-vite.pid, "SIGTERM"); } catch { /* already gone */ }
}
if (errors.length || failures.length) {
  console.error(`failed:\n${[...failures, ...errors].join("\n")}`);
  process.exit(1);
}
