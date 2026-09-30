#!/usr/bin/env node
// Dev tool, not a test: render the materials contact sheet (materials.html) in realistic
// mode, in every environment, so a preset or shader change can be judged by eye. Given two
// part views — by default "Laser-cut" and its "unburnt" twin, which hold the same swatches
// in the same places and differ ONLY by the laser burn — it also writes, per environment
// and angle, an amplified |a − b| image: the burn's footprint, pixel for pixel, with the
// lighting cancelled (the same geometry lit the same way). Cut walls, engravings and
// scores should light up; faces, the acrylic sheet and the non-sheet block stay black.
//
//   node scripts/capture-contact-sheet.mjs --out <dir> [--views laser,unburnt]
//     [--envs studio,workshop,print-bed,outdoor] [--angles iso,top]
//
// Writes <env>-<view>-<angle>.jpg per capture and <env>-<angle>-diff.png per pair of views.
// Exits 1 if the page logged a console error — a shader that fails to compile surfaces
// here — or a view never finished building. CHECK_PORT picks the Vite port (default
// 5191). Needs Playwright's Chromium, like scripts/check-app.mjs.
import { chromium } from "playwright";
import sharp from "sharp";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i === -1 ? fallback : argv[i + 1]; };
const out = opt("out", null);
if (!out) {
  console.error("usage: node scripts/capture-contact-sheet.mjs --out <dir> [--views a,b] [--envs …] [--angles …]");
  process.exit(2);
}
const views = opt("views", "laser,unburnt").split(",");
const envs = opt("envs", "studio,workshop,print-bed,outdoor").split(",");
const angles = opt("angles", "iso,top").split(",");
const PORT = Number(process.env.CHECK_PORT) || 5191;
const url = `http://localhost:${PORT}/materials.html`;
const viteBin = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
mkdirSync(out, { recursive: true });

// |a − b| per channel, times 4, and the share of pixels the burn visibly moved (any channel
// by more than 8/255 before amplifying).
async function diff(a, b, file) {
  const A = await sharp(a).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const B = await sharp(b).removeAlpha().raw().toBuffer();
  const { width, height, channels } = A.info;
  const d = Buffer.alloc(A.data.length);
  let moved = 0;
  for (let i = 0; i < d.length; i += channels) {
    let most = 0;
    for (let c = 0; c < channels; c++) {
      const delta = Math.abs(A.data[i + c] - B[i + c]);
      most = Math.max(most, delta);
      d[i + c] = Math.min(255, delta * 4);
    }
    if (most > 8) moved++;
  }
  await sharp(d, { raw: { width, height, channels } }).png().toFile(file);
  console.log(`${file}: the burn moved ${(100 * moved / (width * height)).toFixed(1)}% of pixels`);
}

const errors = [];
const vite = spawn(process.execPath, [viteBin, "--port", String(PORT), "--strictPort"], { detached: true, stdio: "ignore" });
let browser;
try {
  for (let tries = 0; ; tries++) {
    try { if ((await fetch(url)).ok) break; } catch { /* not listening yet */ }
    if (tries > 240) throw new Error(`vite never answered on ${url}`);
    await sleep(250);
  }
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url);
  await page.waitForFunction(() => window.__pfRuntime, null, { timeout: 60_000 });
  await page.evaluate(() => window.__pfRuntime.ready);
  const pairs = new Map(); // "<env>-<angle>" -> one file per view, in --views order
  for (const env of envs) {
    await page.evaluate((id) => window.__pfRuntime.environment.set(id), env);
    for (const view of views) {
      if (!await page.evaluate((v) => window.__pfRuntime.setView(v) !== false, view)) throw new Error(`no view "${view}"`);
      // A view switch disables the export buttons synchronously until its sub-parts are
      // built and current (mount's refreshView), so this waits out the build.
      await page.waitForFunction(() => document.querySelector("#download")?.disabled === false, null, { timeout: 180_000 });
      const shots = await page.evaluate((a) => window.__pfRuntime.renderViews(a, { renderMode: "realistic" }), angles);
      for (const { view: angle, dataUrl } of shots) {
        const file = join(out, `${env}-${view}-${angle}.jpg`);
        writeFileSync(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"));
        const key = `${env}-${angle}`;
        if (!pairs.has(key)) pairs.set(key, []);
        pairs.get(key).push(file);
        console.log(file);
      }
    }
  }
  if (views.length === 2) for (const [key, [a, b]] of pairs) await diff(a, b, join(out, `${key}-diff.png`));
} finally {
  await browser?.close();
  try { process.kill(-vite.pid, "SIGTERM"); } catch { /* already gone */ }
}
if (errors.length) {
  console.error(`console errors:\n${errors.join("\n")}`);
  process.exit(1);
}
