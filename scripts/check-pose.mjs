// Browser check for Pose mode (spec 2026-10-30 inverse kinematics §4): start a dev
// server, open each pose page in real Chromium, turn Pose mode on and drag a handle
// with real pointer events — the arbitration with orbit, pointer capture, the
// rAF-coalesced drag and the regen hold are things happy-dom cannot model.
//
//   node scripts/check-pose.mjs [--keep]
//
// Pages. A `required` page must exist (a missing one fails the check); the others are
// checked when their file exists and skipped with a message otherwise:
//   pose-smoke.html — the ghost path. A sub-part built from the pose (a bead chain
//     whose build reads p.aCurl) must fade to 0.35 during the drag, no `generate` job
//     may be posted until release, exactly one is posted after it, and the new mesh
//     and opacity 1 must reach the screen in the same frame (sampled every frame:
//     never the new geometry still ghosted, never the old geometry back at full).
//   robot-arm.html, hand.html (both required) — the reference parts. A 20-move drag of the first
//     handle posts no `generate` job, commits exactly once on release, the committed
//     values differ from the part's defaults, and the console stays clean.
//
// What it observes, and how:
//   - worker traffic: an init script wraps window.Worker before the app loads, logging
//     every posted message's `type` (and `subparts`) and every `meshes` reply;
//   - commits: the page's app pushes each onParamsCommit to `window.__pfCommits` and
//     exposes its part as `window.__pfPart` (for defaults) — a pose page's app must;
//   - handle positions: `runtime.pose.handlePoints()` (CSS px on the canvas);
//   - opacity / geometry: `runtime.pose.__subPart(name)` (a test hook), sampled once
//     per animation frame by an in-page rAF loop.
//
// Set CHECK_PORT to run on a port other than 5191. Requires Playwright + Chromium:
// `npm i -D playwright && npx playwright install chromium`.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.CHECK_PORT) || 5191;
const keepServer = process.argv.includes("--keep");
const root = fileURLToPath(new URL("..", import.meta.url));
const viteBin = join(root, "node_modules/vite/bin/vite.js");
const VIEWER_CANVAS = "#app > canvas:not(.pf-ink-canvas)";
const GHOST = 0.35;
const DRAG_MOVES = 20;

// The smoke page's sub-part that cannot move by matrix (test/fixtures/ik-hand-smoke.js).
const SMOKE_REBUILT = "fingerA";

let vite;
let viteState = null;
let viteFailure = null;
let viteLogDir;
let viteStderrPath;

function startVite() {
  viteLogDir = mkdtempSync(join(tmpdir(), "partforge-check-pose-"));
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

// Runs in the page before any app script: log worker traffic and sample sub-parts.
function instrument() {
  window.__pfWorkerLog = [];
  const Native = window.Worker;
  window.Worker = class extends Native {
    constructor(...args) {
      super(...args);
      this.addEventListener("message", (e) => {
        const t = e.data?.type;
        if (t === "meshes" || t === "meshes-partial") {
          window.__pfWorkerLog.push({ dir: "in", type: t, at: performance.now(), names: (e.data.meshes ?? []).map((m) => m.name) });
        }
      });
    }
    postMessage(msg, ...rest) {
      window.__pfWorkerLog.push({ dir: "out", type: msg?.type, at: performance.now(), subparts: msg?.subparts ?? null });
      return super.postMessage(msg, ...rest);
    }
  };
  // Per-frame samples of one sub-part's opacity and geometry identity.
  window.__pfSample = (name) => {
    window.__pfSamples = [];
    window.__pfSampling = true;
    const tick = () => {
      if (!window.__pfSampling) return;
      const s = window.__pfRuntime?.pose?.__subPart?.(name);
      if (s) window.__pfSamples.push({ at: performance.now(), ...s });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
}

const generates = (log, since = -Infinity) => log.filter((e) => e.dir === "out" && e.type === "generate" && e.at > since);

/** Load a page, wait for its first build, turn Pose mode on. Returns the canvas box. */
async function openPoseApp(page, url) {
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => document.getElementById("download")?.disabled === false, { timeout: 60000 });
  const button = page.locator("#pose");
  if (!(await button.count())) throw new Error("no #pose button");
  await button.click();
  if ((await button.getAttribute("aria-pressed")) !== "true") throw new Error("#pose did not turn on");
  await sleep(150); // a frame or two: the overlay is built on enable
  return page.locator(VIEWER_CANVAS).boundingBox();
}

/** The first handle point inside the canvas that the canvas itself receives a press on. */
async function pickHandle(page, box, preferId) {
  const points = await page.evaluate(() => window.__pfRuntime.pose.handlePoints());
  const ordered = preferId ? [...points.filter((p) => p.handleId === preferId), ...points.filter((p) => p.handleId !== preferId)] : points;
  for (const p of ordered) {
    const x = box.x + p.x, y = box.y + p.y;
    if (p.x < 30 || p.y < 30 || p.x > box.width - 30 || p.y > box.height - 30) continue;
    const onCanvas = await page.evaluate(([cx, cy, sel]) => document.elementFromPoint(cx, cy) === document.querySelector(sel), [x, y, VIEWER_CANVAS]);
    if (onCanvas) return { ...p, px: x, py: y };
  }
  throw new Error(`no handle point is pressable on the canvas (handlePoints: ${JSON.stringify(points)})`);
}

/** Press on the handle and move DRAG_MOVES times, a frame apart. Does not release. */
async function dragFrom(page, h, box, onMidDrag) {
  // Head for the canvas centre, ~120 px of travel: some direction the handle can move.
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const len = Math.hypot(cx - h.px, cy - h.py) || 1;
  const dx = ((cx - h.px) / len) * 6, dy = ((cy - h.py) / len) * 6 - 2;
  await page.mouse.move(h.px, h.py);
  await sleep(50);
  await page.mouse.down();
  for (let i = 1; i <= DRAG_MOVES; i++) {
    await page.mouse.move(h.px + dx * i, h.py + dy * i);
    await sleep(20); // let the rAF-coalesced frame run
    if (i === Math.floor(DRAG_MOVES / 2)) await onMidDrag?.();
  }
  await sleep(80);
}

async function checkSmoke(page, url, errors) {
  const box = await openPoseApp(page, url);
  const h = await pickHandle(page, box, "a");
  const before = await page.evaluate((n) => window.__pfRuntime.pose.__subPart(n), SMOKE_REBUILT);
  if (!before) throw new Error(`no sub-part "${SMOKE_REBUILT}" on screen`);
  if (Math.abs(before.opacity - 1) > 1e-6) errors.push(`${SMOKE_REBUILT} opacity before the drag is ${before.opacity}, not 1`);
  const t0 = await page.evaluate(() => performance.now());
  await page.evaluate((n) => window.__pfSample(n), SMOKE_REBUILT);

  let midOpacity = null;
  await dragFrom(page, h, box, async () => {
    midOpacity = (await page.evaluate((n) => window.__pfRuntime.pose.__subPart(n), SMOKE_REBUILT))?.opacity;
  });
  const endOfDrag = await page.evaluate((n) => window.__pfRuntime.pose.__subPart(n), SMOKE_REBUILT);
  const tRelease = await page.evaluate(() => performance.now());
  const duringDrag = generates(await page.evaluate(() => window.__pfWorkerLog), t0);
  if (duringDrag.length) errors.push(`${duringDrag.length} generate job(s) posted during the drag`);
  if (midOpacity == null || Math.abs(midOpacity - GHOST) > 1e-3) errors.push(`${SMOKE_REBUILT} opacity mid-drag is ${midOpacity}, not ${GHOST}`);
  if (endOfDrag?.geometry !== before.geometry) errors.push(`${SMOKE_REBUILT} geometry changed during the drag (it must stay put, ghosted)`);
  await page.mouse.up();

  // Release: exactly one build, then the new mesh at full opacity.
  await page.waitForFunction(([name, g]) => {
    const s = window.__pfRuntime.pose.__subPart(name);
    return s && s.geometry !== g && document.getElementById("download")?.disabled === false;
  }, [SMOKE_REBUILT, before.geometry], { timeout: 30000 }).catch(() => errors.push(`${SMOKE_REBUILT} was not rebuilt after release`));
  await sleep(600); // past the 180 ms regen debounce: a second job would be posted by now
  const result = await page.evaluate(([name, tr]) => {
    window.__pfSampling = false;
    return {
      after: window.__pfRuntime.pose.__subPart(name),
      jobs: window.__pfWorkerLog.filter((e) => e.dir === "out" && e.type === "generate" && e.at > tr),
      samples: window.__pfSamples.filter((s) => s.at > tr),
      commits: window.__pfCommits ?? null,
      defaults: window.__pfPart?.defaults ?? null,
    };
  }, [SMOKE_REBUILT, tRelease]);
  if (result.jobs.length !== 1) errors.push(`${result.jobs.length} generate jobs after release, expected exactly 1`);
  else if (!result.jobs[0].subparts?.includes(SMOKE_REBUILT)) errors.push(`the release job did not rebuild ${SMOKE_REBUILT} (subparts ${JSON.stringify(result.jobs[0].subparts)})`);
  if (!result.after || Math.abs(result.after.opacity - 1) > 1e-6) errors.push(`${SMOKE_REBUILT} opacity after its mesh landed is ${result.after?.opacity}, not 1`);
  // Same-frame landing: once released, every frame shows either the old mesh still
  // ghosted or the new mesh at full opacity — never a mix.
  const flash = result.samples.find((s) => (s.geometry === before.geometry) !== (s.opacity < 1 - 1e-6));
  if (flash) errors.push(`a frame showed ${flash.geometry === before.geometry ? "the old mesh at full opacity" : "the new mesh still ghosted"} (opacity ${flash.opacity})`);
  checkCommits(result, errors);

  // A click (no drag) on a tip pins it: viewer state, so no job and no commit.
  const tip = await pickHandle(page, box, "b");
  const tClick = await page.evaluate(() => performance.now());
  await page.mouse.click(tip.px, tip.py);
  await sleep(300);
  const pinned = await page.evaluate((tc) => ({
    pins: window.__pfRuntime.getViewerState().pose?.pins ?? null,
    jobs: window.__pfWorkerLog.filter((e) => e.dir === "out" && e.type === "generate" && e.at > tc).length,
    commits: window.__pfCommits.length,
  }), tClick);
  const want = `${tip.handleId}:${tip.at}`;
  if (JSON.stringify(pinned.pins) !== JSON.stringify([want])) errors.push(`a click on ${want} left pins ${JSON.stringify(pinned.pins)}`);
  if (pinned.jobs) errors.push(`a pin click posted ${pinned.jobs} generate job(s)`);
  if (pinned.commits !== 1) errors.push(`a pin click committed (${pinned.commits} commits in all)`);
  return { midOpacity, jobs: result.jobs.length, after: result.after?.opacity, commits: result.commits?.length ?? null, frames: result.samples.length, pins: pinned.pins };
}

function checkCommits({ commits, defaults }, errors) {
  if (!Array.isArray(commits)) { errors.push("the page exposes no window.__pfCommits (its app must count onParamsCommit)"); return; }
  if (commits.length !== 1) { errors.push(`${commits.length} onParamsCommit calls on release, expected exactly 1`); return; }
  const { changed, params } = commits[0];
  if (!Array.isArray(changed) || changed.length === 0) { errors.push("the commit lists no changed keys"); return; }
  if (!defaults) { errors.push("the page exposes no window.__pfPart (its app must, for defaults)"); return; }
  const same = changed.filter((k) => Object.is(params[k], defaults[k]));
  if (same.length === changed.length) errors.push(`no committed value differs from the defaults (${changed.join(", ")})`);
}

async function checkReference(page, url, errors) {
  const box = await openPoseApp(page, url);
  const h = await pickHandle(page, box);
  const t0 = await page.evaluate(() => performance.now());
  await dragFrom(page, h, box);
  const duringDrag = generates(await page.evaluate(() => window.__pfWorkerLog), t0);
  if (duringDrag.length) errors.push(`${duringDrag.length} generate job(s) posted during the drag`);
  await page.mouse.up();
  await sleep(600);
  const result = await page.evaluate(() => ({ commits: window.__pfCommits ?? null, defaults: window.__pfPart?.defaults ?? null }));
  checkCommits(result, errors);
  return { handle: `${h.handleId}:${h.at}`, generatesDuringDrag: duringDrag.length, commits: result.commits?.length ?? null };
}

const PAGES = [
  { entry: "pose-smoke.html", run: checkSmoke, required: true },
  { entry: "robot-arm.html", run: checkReference, required: true },
  { entry: "hand.html", run: checkReference, required: true },
];

let failed = false;
let browser;
try {
  const present = PAGES.filter((p) => existsSync(join(root, p.entry)));
  for (const p of PAGES) {
    if (present.includes(p)) continue;
    if (p.required) { console.log(`check-pose: ${p.entry} is missing (required)`); failed = true; }
    else console.log(`skip ${p.entry}: the page does not exist yet`);
  }
  if (present.length) {
    startVite();
    await waitForVite(`http://localhost:${PORT}/${present[0].entry}`);
    browser = await chromium.launch();
    for (const { entry, run } of present) {
      const url = `http://localhost:${PORT}/${entry}`;
      const errors = [];
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.addInitScript(instrument);
      page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
      page.on("pageerror", (e) => errors.push("pageerror: " + (e?.message ?? e)));
      page.on("worker", (w) => w.on("console", (m) => { if (m.type() === "error") errors.push("worker: " + m.text()); }));
      let summary = null;
      try {
        summary = await run(page, url, errors);
      } catch (error) {
        errors.push("check: " + (error?.message ?? error));
      }
      await page.close();
      console.log(`check-pose ${url}`);
      if (summary) console.log(`  ${JSON.stringify(summary)}`);
      console.log(`  errors: ${errors.length}`);
      for (const e of errors.slice(0, 12)) console.log("    - " + String(e).split("\n")[0]);
      if (errors.length) failed = true;
    }
  }
} catch (error) {
  console.log(`check-pose: ${error?.message ?? error}`);
  failed = true;
} finally {
  try { await browser?.close(); } catch { /* best effort */ }
  if (!keepServer) await stopVite();
  else if (vite?.pid) console.log(`  vite: kept running (pid ${vite.pid})`);
  if (viteLogDir) rmSync(viteLogDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
