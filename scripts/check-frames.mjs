// Browser check for the capture-frame runtime additions (0.204.0): start a dev server,
// open hinged-box.html in real Chromium and drive the handle the way a host rendering
// video frames would. What it proves needs a real GPU canvas and real pointer events,
// which happy-dom cannot model:
//
//   1. runtime.renderCurrent({ width: 640, height: 360 }) is a 640 × 360 canvas with
//      more than one distinct pixel colour.
//   2. Inside an runtime.onRendered callback, drawImage of the live canvas into a 2-D
//      canvas gives more than one distinct colour (outside it the live canvas reads
//      blank: the recorder rests on this).
//   3. On the `assemble` animation (step cameras iso → left → iso): after
//      seek(0.6, { camera: true }) getCameraCue() differs from its value after
//      seek(0, { camera: true }); after setCamera(known pose) and seek(0.6) alone the
//      camera does not move.
//   4. Thirty frames of seek(i / 29, { camera: true }) → await whenSettled() (each true)
//      → renderCurrent({ width: 1080, height: 1080 }) complete; the total milliseconds
//      are printed (a planning number, not a threshold).
//   5. With runtime.picking.setEnabled(false) a click on the model at the canvas centre
//      calls no onPick (the app counts them in `window.__pfPicks`); enabled again, it does.
//
// hinged-box.html is the page because its animations carry camera cues, it builds on
// Manifold (fast), and its app exposes `window.__pfRuntime` and counts onPick.
//
//   node scripts/check-frames.mjs [--keep]
//
// Set CHECK_PORT to run on a port other than 5192. Requires Playwright + Chromium:
// `npm i -D playwright && npx playwright install chromium`.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.CHECK_PORT) || 5192;
const keepServer = process.argv.includes("--keep");
const root = fileURLToPath(new URL("..", import.meta.url));
const viteBin = join(root, "node_modules/vite/bin/vite.js");
const ENTRY = "hinged-box.html";
const VIEWER_CANVAS = "#app > canvas:not(.pf-ink-canvas)";
const ANIMATION = "assemble";
const FRAMES = 30;
// Degrees: two cues closer than this on every angle (and distance within 1%) are one pose.
const ANGLE_TOLERANCE = 0.5;

let vite;
let viteState = null;
let viteFailure = null;
let viteLogDir;
let viteStderrPath;

function startVite() {
  viteLogDir = mkdtempSync(join(tmpdir(), "partforge-check-frames-"));
  const stdoutFd = openSync(join(viteLogDir, "vite.stdout.log"), "w");
  viteStderrPath = join(viteLogDir, "vite.stderr.log");
  const stderrFd = openSync(viteStderrPath, "w");
  try {
    vite = spawn(process.execPath, [viteBin, "--port", String(PORT), "--strictPort"], {
      cwd: root, detached: true, stdio: ["ignore", stdoutFd, stderrFd],
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  vite.on("error", (error) => { viteFailure = error; });
  vite.on("exit", (code, signal) => { viteState = { code, signal }; });
  vite.unref();
}

function viteStderr() {
  if (!viteStderrPath || !existsSync(viteStderrPath)) return "";
  return readFileSync(viteStderrPath, "utf8").slice(-4000).trim().replace(/\s+/g, " ");
}

async function waitForVite(url) {
  for (let i = 0; i < 80; i++) {
    if (viteFailure) throw viteFailure;
    if (viteState) throw new Error(`dev server stopped before startup: ${viteStderr()}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(250) });
      if (response.ok) { await sleep(250); if (!viteState) return; }
    } catch { /* still starting */ }
    await sleep(250);
  }
  throw new Error(`dev server did not start: ${viteStderr()}`);
}

async function stopVite() {
  if (!vite?.pid) return;
  const alive = () => { try { process.kill(-vite.pid, 0); return true; } catch { return false; } };
  if (!alive()) return;
  process.kill(-vite.pid, "SIGTERM");
  for (let i = 0; i < 40 && alive(); i++) await sleep(50);
  if (alive()) process.kill(-vite.pid, "SIGKILL");
}

// Runs in the page before the app: a helper that counts the distinct colours of a
// canvas (any kind) by drawing it into a 2-D canvas, sampling a grid.
function instrument() {
  window.__pfColours = (source, w, h) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const seen = new Set();
    const step = Math.max(1, Math.floor(Math.min(w, h) / 64));
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        seen.add((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]);
      }
    }
    return seen.size;
  };
}

class AssertionFailed extends Error {}
function check(n, ok, message, detail) {
  if (!ok) throw new AssertionFailed(`assertion ${n} failed: ${message}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function sameCue(a, b) {
  if (a == null || b == null) return a === b;
  if (typeof a === "string" || typeof b === "string") return a === b;
  const near = (x, y) => Math.abs((x ?? 0) - (y ?? 0)) <= ANGLE_TOLERANCE;
  const angleNear = (x, y) => { const d = Math.abs(((x ?? 0) - (y ?? 0)) % 360); return Math.min(d, 360 - d) <= ANGLE_TOLERANCE; };
  const distNear = a.distance == null || b.distance == null
    ? a.distance === b.distance
    : Math.abs(a.distance - b.distance) <= 0.01 * Math.max(Math.abs(a.distance), Math.abs(b.distance), 1);
  return angleNear(a.azimuth, b.azimuth) && near(a.elevation, b.elevation) && distNear;
}

const samePose = (a, b) => ["pos", "target"].every((k) =>
  a?.[k]?.length === 3 && b?.[k]?.length === 3 && a[k].every((v, i) => Math.abs(v - b[k][i]) < 1e-6));

async function run(page) {
  await page.goto(`http://localhost:${PORT}/${ENTRY}`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => document.getElementById("download")?.disabled === false, { timeout: 60000 });
  const settledAtStart = await page.evaluate(async () => {
    window.__pfRuntime.animation.stop(); // the `cycle` autoplay would move params under the checks
    return window.__pfRuntime.whenSettled();
  });
  if (settledAtStart !== true) throw new Error(`whenSettled() after the first build was ${settledAtStart}`);
  const summary = {};

  // 1. renderCurrent at an exact size.
  const r1 = await page.evaluate(() => {
    const c = window.__pfRuntime.renderCurrent({ width: 640, height: 360 });
    if (!c) return null;
    return { tag: c.tagName, width: c.width, height: c.height, colours: window.__pfColours(c, c.width, c.height) };
  });
  check(1, r1 != null, "renderCurrent({ width: 640, height: 360 }) returned null");
  check(1, r1.tag === "CANVAS" && r1.width === 640 && r1.height === 360, "not a 640 × 360 canvas", r1);
  check(1, r1.colours > 1, "the canvas has one colour", r1);
  summary.renderCurrent = r1;

  // 2. The live canvas read inside onRendered.
  const r2 = await page.evaluate((sel) => new Promise((resolve) => {
    const rt = window.__pfRuntime;
    const live = document.querySelector(sel);
    let off = null;
    const timer = setTimeout(() => { off?.(); resolve({ fired: false }); }, 5000);
    off = rt.onRendered(() => {
      off();
      clearTimeout(timer);
      const w = Math.min(live.width, 640);
      const h = Math.max(1, Math.round((live.height * w) / live.width));
      resolve({ fired: true, colours: window.__pfColours(live, w, h) });
    });
    rt.setCameraCue("iso"); // kicks a live frame
  }), VIEWER_CANVAS);
  check(2, r2.fired, "onRendered did not fire within 5 s of a camera jump");
  check(2, r2.colours > 1, "drawImage of the live canvas inside onRendered gives one colour", r2);
  summary.onRendered = r2;

  // 3. seek with and without the camera.
  const r3 = await page.evaluate(async (name) => {
    const rt = window.__pfRuntime;
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    // play() selects the animation; the seek right after pauses it and, with
    // { camera: true }, cancels the cue tween play started.
    rt.animation.play(name);
    rt.animation.seek(0, { camera: true });
    const at0 = rt.getCameraCue()?.cue ?? null;
    rt.animation.seek(0.6, { camera: true });
    const at06 = rt.getCameraCue()?.cue ?? null;
    rt.animation.seek(0); // still selected and paused, with no tween running
    await frames();
    const known = { pos: [180, -220, 160], target: [0, 0, 20] };
    const setOk = rt.setCamera(known);
    await frames();
    const before = rt.getViewerState().camera;
    rt.animation.seek(0.6);
    await frames();
    const after = rt.getViewerState().camera;
    const state = rt.animation.state();
    rt.animation.stop();
    return { at0, at06, setOk, before, after, state };
  }, ANIMATION);
  check(3, r3.state.animation === ANIMATION, `the ${ANIMATION} animation is not selected`, r3.state);
  check(3, r3.state.duration > 0, "animation.state().duration is not positive", r3.state);
  check(3, r3.at0 != null && r3.at06 != null, "getCameraCue() is null after a seek", r3);
  check(3, !sameCue(r3.at0, r3.at06), "seek(0.6, { camera: true }) left the camera at seek(0)'s cue", r3);
  check(3, r3.setOk === true, "setCamera(known pose) returned false", r3);
  check(3, samePose(r3.before, r3.after), "seek(0.6) without camera moved the camera", r3);
  summary.seek = { at0: r3.at0, at06: r3.at06, duration: r3.state.duration };

  // 4. Thirty frames at 1080 × 1080.
  const r4 = await page.evaluate(async ({ name, frames }) => {
    const rt = window.__pfRuntime;
    const saved = rt.getViewerState().camera;
    rt.animation.play(name);
    const started = performance.now();
    let rendered = 0;
    const unsettled = [];
    let bad = null;
    for (let i = 0; i < frames; i++) {
      rt.animation.seek(i / (frames - 1), { camera: true });
      const settled = await rt.whenSettled();
      if (settled !== true) unsettled.push(i);
      const c = rt.renderCurrent({ width: 1080, height: 1080 });
      if (!c || c.width !== 1080 || c.height !== 1080) { bad = { i, width: c?.width ?? null, height: c?.height ?? null }; break; }
      rendered++;
    }
    const ms = performance.now() - started;
    rt.animation.stop();
    rt.setCamera(saved);
    const gl = document.createElement("canvas").getContext("webgl2");
    return { ms, rendered, unsettled, bad, maxTexture: gl?.getParameter(gl.MAX_TEXTURE_SIZE) ?? null };
  }, { name: ANIMATION, frames: FRAMES });
  check(4, r4.bad == null, "renderCurrent({ width: 1080, height: 1080 }) gave no 1080 × 1080 canvas", r4);
  check(4, r4.unsettled.length === 0, "whenSettled() was not true for every frame", r4);
  check(4, r4.rendered === FRAMES, `rendered ${r4.rendered} of ${FRAMES} frames`, r4);
  console.log(`  ${FRAMES} frames of seek → whenSettled → renderCurrent(1080 × 1080): ${Math.round(r4.ms)} ms total (${(r4.ms / FRAMES).toFixed(1)} ms/frame)`);
  summary.frames = { ms: Math.round(r4.ms), rendered: r4.rendered };

  // 5. The picking switch, through a real click on the model.
  await page.evaluate(() => window.__pfRuntime.setCameraCue("iso"));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const box = await page.locator(VIEWER_CANVAS).boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const clickAndCount = async () => {
    const before = await page.evaluate(() => window.__pfPicks.length);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.up();
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await sleep(300);
    return (await page.evaluate(() => window.__pfPicks.length)) - before;
  };
  const enabledAtStart = await page.evaluate(() => window.__pfRuntime.picking.isEnabled());
  check(5, enabledAtStart === true, "picking.isEnabled() is not true with onPick");
  await page.evaluate(() => window.__pfRuntime.picking.setEnabled(false));
  const offState = await page.evaluate(() => window.__pfRuntime.picking.isEnabled());
  const picksOff = await clickAndCount();
  await page.evaluate(() => window.__pfRuntime.picking.setEnabled(true));
  // Move away and back so the second press is not read as part of the first.
  await page.mouse.move(cx + 40, cy + 40);
  const picksOn = await clickAndCount();
  check(5, offState === false, "picking.isEnabled() is not false after setEnabled(false)");
  check(5, picksOff === 0, `a click with picking off called onPick ${picksOff} time(s)`);
  check(5, picksOn >= 1, "a click on the model at the canvas centre with picking on called no onPick");
  summary.picking = { picksOff, picksOn };
  return summary;
}

let failed = false;
let browser;
try {
  startVite();
  await waitForVite(`http://localhost:${PORT}/${ENTRY}`);
  browser = await chromium.launch();
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(instrument);
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + (e?.message ?? e)));
  page.on("worker", (w) => w.on("console", (m) => { if (m.type() === "error") errors.push("worker: " + m.text()); }));
  console.log(`check-frames http://localhost:${PORT}/${ENTRY}`);
  let summary = null;
  try {
    summary = await run(page);
  } catch (error) {
    errors.push((error instanceof AssertionFailed ? "" : "check: ") + (error?.message ?? error));
  }
  await page.close();
  if (summary) console.log(`  ${JSON.stringify(summary)}`);
  console.log(`  errors: ${errors.length}`);
  for (const e of errors.slice(0, 12)) console.log("    - " + String(e).split("\n")[0]);
  if (errors.length) failed = true;
} catch (error) {
  console.log(`check-frames: ${error?.message ?? error}`);
  failed = true;
} finally {
  try { await browser?.close(); } catch { /* best effort */ }
  if (!keepServer) await stopVite();
  else if (vite?.pid) console.log(`  vite: kept running (pid ${vite.pid})`);
  if (viteLogDir) rmSync(viteLogDir, { recursive: true, force: true });
}
console.log(failed ? "check-frames: FAIL" : "check-frames: PASS");
process.exit(failed ? 1 : 0);
