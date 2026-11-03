// Browser check for posing (spec 2026-10-30 inverse kinematics §4): start a dev
// server, open each pose page in real Chromium, hover near a limb (posing is always on
// in the normal click mode — there is no toggle) and drag a handle with real pointer
// events — the arbitration with orbit and click-to-pick, pointer capture, the
// rAF-coalesced drag and the regen hold are things happy-dom cannot model.
//
//   node scripts/check-pose.mjs [--keep]
//
// Pages. A `required` page must exist (a missing one fails the check); the others are
// checked when their file exists and skipped with a message otherwise:
//   pose-smoke.html — the ghost path. A sub-part built from the pose (a bead chain
//     whose build reads p.aCurl, deliberately slower than mount's LIVE_REBUILD_MS, so
//     it does not rebuild live) must fade to 0.35 during the drag, no `generate` job
//     may be posted and no onBuild fire until release, exactly one of each after it,
//     and the new mesh and opacity 1 must reach the screen in the same frame (sampled
//     every frame: never the new geometry still ghosted, never the old geometry back
//     at full).
//     Then the pick arbitration (its app counts onPick in `window.__pfPicks`): a click
//     on a tip dot pins it and picks nothing, a drag picks nothing, a plain click on the
//     model away from the handles still picks; and turning measure on hides posing
//     (isLive false, no handle points, a press where a tip was is not a drag) until it
//     goes off again.
//   robot-arm.html, hand.html (both required) — the reference parts. A 20-move drag of the first
//     handle posts no `generate` job, commits exactly once on release, the committed
//     values differ from the part's defaults, and the console stays clean. robot-arm.html
//     then drags its tool's aim gizmo: hovering the tool point shows it
//     (runtime.pose.__aimGizmo(), a test hook), hovering a ring highlights that ring with a
//     grab cursor, and a drag round the ring writes that aim angle — one commit, no
//     `generate` job. Then a JOINT RING on each reference part (robot-arm: the elbow;
//     hand: the wrist pitch, on the palm limb): hovering the joint's dot shows its ring
//     (runtime.pose.__jointRings() / __jointGizmo(), test hooks), hovering the ring
//     highlights it with a grab cursor, and a drag round it writes that joint's parameter —
//     one commit, no `generate` job; on robot-arm the commit also moves the tool goal (the
//     goal follows the turned joint). Last on robot-arm, a JOINT PIN: a click on the elbow
//     dot pins it (pinCount 1, a badge at the elbow — runtime.pose.__pinPoints(), a test
//     hook — no commit); a tool drag then holds the elbow within 0.5 mm while the tool
//     moves, one commit; a second click unpins. Then the REALISTIC FLOOR: in realistic
//     mode a far sideways tool drag leaves the ground's x/z and scale exactly where they
//     were (runtime.pose.__ground(), a test hook), during the drag and after its release;
//     its height may only go down. CHECK_POSE_SHOTS=<dir> saves screenshots of it.
//   hand.html, after its joint ring — VIEW-SPECIFIC HANDLES (checkViewSwitch): pin a fingertip,
//     hover it, switch to the print view with the pointer still on it: no handle points,
//     badges, overlay objects (runtime.pose.__drawn(), a test hook), gizmo, chip, grab cursor
//     or hover claim, over a sweep of the canvas too, and a press where the dot was does not
//     drag. Back in the assembly view the handles and the pin return.
//   gearbox.html (required) — generic rotary handles (spec 2026-11-02 generic handles):
//     the output gear's rim dot dragged one full turn round its rim writes the wrapped
//     driveAngle 0 -> ~720, past 360 with no backwards frame and no `generate` job, one
//     commit (checkGearbox).
//   drawer-box.html (required, dev-only) — motion and shape on one part: a drawer's pull
//     along its rail is matrix-only (no `generate` job, the other drawers stay); the
//     cabinet's corner across its top plane is a shape drag on a CHEAP part, so it
//     rebuilds live — `generate` jobs during the drag — while the host sees no onBuild
//     until release and exactly one after (checkDrawerBox).
//
// What it observes, and how:
//   - worker traffic: an init script wraps window.Worker before the app loads, logging
//     every posted message's `type` (and `subparts`) and every `meshes` reply;
//   - commits: the page's app pushes each onParamsCommit to `window.__pfCommits` and
//     exposes its part as `window.__pfPart` (for defaults) — a pose page's app must;
//   - builds: pose-smoke's and drawer-box's apps push each onBuild to `window.__pfBuilds`;
//   - which way a generic handle moves on screen: its handlePoints() entry read at a few
//     param values set through runtime.setParams (handleAt), never the camera;
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
          window.__pfWorkerLog.push({ dir: "in", type: t, at: performance.now(), ms: e.data.ms ?? null, names: (e.data.meshes ?? []).map((m) => m.name) });
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
  // Per-frame samples of one handle's point on the canvas (CSS px).
  window.__pfSampleHandle = (id) => {
    window.__pfHandleSamples = [];
    window.__pfHandleSampling = true;
    const tick = () => {
      if (!window.__pfHandleSampling) return;
      const h = window.__pfRuntime?.pose?.handlePoints?.().find((p) => p.handleId === id);
      if (h) window.__pfHandleSamples.push({ at: performance.now(), x: h.x, y: h.y });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
}

const generates = (log, since = -Infinity) => log.filter((e) => e.dir === "out" && e.type === "generate" && e.at > since);
/** The worker's own time for the last whole build it answered (a `meshes` reply's ms), or null. */
const lastBuildTime = (log) => log.filter((e) => e.dir === "in" && e.type === "meshes" && Number.isFinite(e.ms)).at(-1)?.ms ?? null;

/** Load a page and wait for its first build; posing must be live with no toggle. Returns the canvas box. */
async function openPoseApp(page, url) {
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => document.getElementById("download")?.disabled === false, { timeout: 60000 });
  if (await page.locator("#pose:visible").count()) throw new Error("a visible #pose toggle: posing has no toggle");
  if (!(await page.evaluate(() => window.__pfRuntime.pose.isLive()))) throw new Error("posing is not live after the first build");
  // Framing settles over a few frames after the first build: wait until every handle point
  // is where it was two animation frames ago (and there is one), so a pick is not stale.
  await page.waitForFunction(() => new Promise((resolve) => {
    const read = () => JSON.stringify(window.__pfRuntime.pose.handlePoints().map((p) => [p.handleId, Math.round(p.x * 10), Math.round(p.y * 10)]));
    const a = read();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const pts = window.__pfRuntime.pose.handlePoints();
      resolve(pts.length > 0 && read() === a);
    }));
  }), null, { timeout: 15000, polling: 50 });
  return page.locator(VIEWER_CANVAS).boundingBox();
}

const canvasCursor = (page) => page.evaluate((sel) => document.querySelector(sel).style.cursor, VIEWER_CANVAS);

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
  // Hover in from the side: near the limb its dots show, on the dot the cursor is a grab.
  await page.mouse.move(h.px + 18, h.py, { steps: 3 });
  await page.mouse.move(h.px, h.py, { steps: 3 });
  await sleep(50);
  const cursor = await canvasCursor(page);
  if (cursor !== "grab") throw new Error(`hovering handle ${h.handleId}:${h.at} shows cursor "${cursor}", not "grab"`);
  await page.mouse.down();
  for (let i = 1; i <= DRAG_MOVES; i++) {
    await page.mouse.move(h.px + dx * i, h.py + dy * i);
    await sleep(20); // let the rAF-coalesced frame run
    if (i === Math.floor(DRAG_MOVES / 2)) {
      if (!(await page.evaluate(() => window.__pfRuntime.pose.__isDragging()))) {
        await page.mouse.up();
        throw new Error(`a drag from handle ${h.handleId}:${h.at} never started (pose.isDragging() false mid-drag)`);
      }
      await onMidDrag?.();
    }
  }
  await sleep(80);
}

async function checkSmoke(page, url, errors) {
  const box = await openPoseApp(page, url);
  const h = await pickHandle(page, box, "a");
  // The ghost path needs a part slower than mount's LIVE_REBUILD_MS (the fixture's bead
  // chains are, on purpose): a cheap one rebuilds live (checkDrawerBox).
  const lastBuildMs = lastBuildTime(await page.evaluate(() => window.__pfWorkerLog));
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
  if (duringDrag.length) errors.push(`${duringDrag.length} generate job(s) posted during the drag (is the fixture's build still slower than LIVE_REBUILD_MS? last build ${lastBuildMs} ms)`);
  const buildsDuring = await page.evaluate((t) => (window.__pfBuilds ?? []).filter((b) => b.at > t).length, t0);
  if (buildsDuring) errors.push(`onBuild fired ${buildsDuring} time(s) during the drag`);
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
      builds: (window.__pfBuilds ?? []).filter((b) => b.at > tr).length,
      samples: window.__pfSamples.filter((s) => s.at > tr),
      commits: window.__pfCommits ?? null,
      defaults: window.__pfPart?.defaults ?? null,
    };
  }, [SMOKE_REBUILT, tRelease]);
  if (result.jobs.length !== 1) errors.push(`${result.jobs.length} generate jobs after release, expected exactly 1`);
  else if (!result.jobs[0].subparts?.includes(SMOKE_REBUILT)) errors.push(`the release job did not rebuild ${SMOKE_REBUILT} (subparts ${JSON.stringify(result.jobs[0].subparts)})`);
  if (result.builds !== 1) errors.push(`onBuild fired ${result.builds} time(s) after release, expected exactly 1`);
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
  const picks = await checkPicks(page, box, errors);
  const measure = await checkMeasureHides(page, box, errors);
  return { lastBuildMs, midOpacity, jobs: result.jobs.length, builds: result.builds, after: result.after?.opacity, commits: result.commits?.length ?? null, frames: result.samples.length, pins: pinned.pins, ...picks, ...measure };
}

/**
 * Pick arbitration, after the drag and the pin click above: neither picked; a plain
 * click on the model, away from every handle, does. The candidate points are a grid
 * over the canvas, nearest the centre first, more than 60 px from every handle point
 * and showing no grab cursor; the first one whose click picks passes.
 */
async function checkPicks(page, box, errors) {
  const picksAfterPose = await page.evaluate(() => window.__pfPicks?.length ?? null);
  if (picksAfterPose === null) { errors.push("the page exposes no window.__pfPicks (its app must count onPick)"); return {}; }
  if (picksAfterPose !== 0) errors.push(`a pose drag or pin click opened ${picksAfterPose} pick(s)`);
  const pinsBefore = await page.evaluate(() => JSON.stringify(window.__pfRuntime.getViewerState().pose?.pins ?? null));
  const handles = await page.evaluate(() => window.__pfRuntime.pose.handlePoints());
  const cands = [];
  for (let gx = 0.2; gx <= 0.8; gx += 0.05) {
    for (let gy = 0.2; gy <= 0.8; gy += 0.05) {
      const x = box.width * gx, y = box.height * gy;
      if (handles.every((p) => Math.hypot(p.x - x, p.y - y) > 60)) cands.push({ x, y });
    }
  }
  cands.sort((a, b) => Math.hypot(a.x - box.width / 2, a.y - box.height / 2) - Math.hypot(b.x - box.width / 2, b.y - box.height / 2));
  let picked = null;
  for (const c of cands.slice(0, 40)) {
    await page.mouse.move(box.x + c.x, box.y + c.y, { steps: 2 });
    await sleep(30);
    if ((await canvasCursor(page)) === "grab") continue;
    await page.mouse.click(box.x + c.x, box.y + c.y);
    await sleep(120);
    const n = await page.evaluate(() => window.__pfPicks.length);
    if (n > picksAfterPose) { picked = { ...c, n: n - picksAfterPose }; break; }
  }
  if (!picked) errors.push("no plain click on the model away from the handles picked");
  else if (picked.n !== 1) errors.push(`a plain click picked ${picked.n} times`);
  const pinsAfter = await page.evaluate(() => JSON.stringify(window.__pfRuntime.getViewerState().pose?.pins ?? null));
  if (pinsAfter !== pinsBefore) errors.push(`a plain click changed the pins (${pinsBefore} -> ${pinsAfter})`);
  return { plainClickPicked: !!picked };
}

/** Measure on hides posing (handles, Release pins) and a press where a tip was orbits; off restores it. */
async function checkMeasureHides(page, box, errors) {
  const button = page.locator("#measure");
  if (!(await button.count())) { errors.push("no #measure button to check posing stands down"); return {}; }
  const tip = await pickHandle(page, box, "a");
  const releaseShown = () => page.evaluate(() => { const a = document.querySelector(".pf-pose-actions"); return !!a && !a.hidden; });
  const pinsShowRelease = (await page.evaluate(() => window.__pfRuntime.pose.pinCount())) > 0;
  if (pinsShowRelease && !(await releaseShown())) errors.push("Release pins is hidden while pins exist and posing is live");
  await button.click();
  await sleep(150);
  const off = await page.evaluate(() => ({ live: window.__pfRuntime.pose.isLive(), points: window.__pfRuntime.pose.handlePoints().length }));
  if (off.live) errors.push("posing is still live with measure on");
  if (off.points) errors.push(`${off.points} handle point(s) with measure on`);
  if (await releaseShown()) errors.push("Release pins shows with measure on");
  const commits = await page.evaluate(() => window.__pfCommits.length);
  await page.mouse.move(tip.px, tip.py, { steps: 2 });
  if ((await canvasCursor(page)) === "grab") errors.push("a pose grab cursor with measure on");
  await page.mouse.down();
  await page.mouse.move(tip.px + 30, tip.py + 30, { steps: 6 });
  await page.mouse.up();
  await sleep(300);
  if ((await page.evaluate(() => window.__pfCommits.length)) !== commits) errors.push("a drag from a tip committed with measure on");
  await button.click();
  await sleep(150);
  if (!(await page.evaluate(() => window.__pfRuntime.pose.isLive()))) errors.push("posing did not come back when measure went off");
  if (pinsShowRelease && !(await releaseShown())) errors.push("Release pins did not come back when measure went off");
  return { measureHides: !off.live && !off.points };
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

/** The reference drag, then a ring of the tool's aim gizmo (pitch, else the first ring). */
async function checkRobotArm(page, url, errors) {
  const summary = await checkReference(page, url, errors);
  const box = await page.locator(VIEWER_CANVAS).boundingBox();
  const h = await pickHandle(page, box);
  await page.mouse.move(h.px + 18, h.py, { steps: 3 });
  await page.mouse.move(h.px, h.py, { steps: 3 });
  await sleep(50);
  const g = await page.evaluate(() => window.__pfRuntime.pose.__aimGizmo());
  if (!g) { errors.push("hovering the tool point shows no aim gizmo"); return summary; }
  if (g.hovered !== "ball") errors.push(`hovering the tool point hovers "${g.hovered}", not the ball`);
  const name = g.rings.pitch ? "pitch" : Object.keys(g.rings)[0];
  const ring = g.rings[name];
  if (!ring?.ahead) { errors.push(`no grabbable point on the aim gizmo's rings (${JSON.stringify(g.rings)})`); return summary; }
  const at = (p) => ({ x: box.x + p.x, y: box.y + p.y });
  const from = at(ring), to = at(ring.ahead);
  await page.mouse.move(from.x, from.y, { steps: 4 });
  await sleep(50);
  const hov = await page.evaluate(() => window.__pfRuntime.pose.__aimGizmo()?.hovered ?? null);
  if (hov !== name) errors.push(`hovering the ${name} ring hovers "${hov}"`);
  const cursor = await canvasCursor(page);
  if (cursor !== "grab") errors.push(`hovering the ${name} ring shows cursor "${cursor}", not "grab"`);
  const commits0 = await page.evaluate(() => window.__pfCommits.length);
  const t0 = await page.evaluate(() => performance.now());
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12);
    await sleep(20);
  }
  const during = await page.evaluate(() => ({ hovered: window.__pfRuntime.pose.__aimGizmo()?.hovered ?? null }));
  const grabbing = await canvasCursor(page);
  await sleep(80);
  const ringGenerates = generates(await page.evaluate(() => window.__pfWorkerLog), t0);
  await page.mouse.up();
  await sleep(600);
  if (during.hovered !== name) errors.push(`dragging the ${name} ring left "${during.hovered}" highlighted`);
  if (grabbing !== "grabbing") errors.push(`dragging the ${name} ring shows cursor "${grabbing}", not "grabbing"`);
  if (ringGenerates.length) errors.push(`${ringGenerates.length} generate job(s) posted during the ring drag`);
  const commits = await page.evaluate(() => window.__pfCommits);
  const added = commits.slice(commits0);
  const aimParam = await page.evaluate((i) => window.__pfPart?.handles?.tool?.params?.aim?.[i] ?? null, ["pitch", "yaw", "roll"].indexOf(name));
  if (added.length !== 1) errors.push(`${added.length} onParamsCommit calls after the ${name} ring drag, expected exactly 1`);
  else if (!aimParam || !added[0].changed?.includes(aimParam)) errors.push(`the ${name} ring drag committed ${JSON.stringify(added[0].changed)}, not ${aimParam}`);
  const joint = await checkJointRing(page, box, { limb: "arm", joint: "elbow", param: "elbow", alsoMoves: ["toolX", "toolY", "toolZ"] }, errors);
  const pin = await checkJointPin(page, box, errors);
  const floor = await checkRealisticFloor(page, box, errors);
  return { ...summary, ring: name, ringCommit: added[0]?.changed ?? null, ringValue: aimParam ? added[0]?.params?.[aimParam] : null, joint, pin, floor };
}

/**
 * The realistic floor belongs to the part's base, not its pose: in realistic mode, drag
 * the tool far sideways — the ground's x/z and scale (so its texture) stay put during the
 * drag and after the release's delivery; its height may only go down. With
 * CHECK_POSE_SHOTS=<dir>, screenshots before, mid-drag and after land there.
 */
async function checkRealisticFloor(page, box, errors) {
  const shots = process.env.CHECK_POSE_SHOTS;
  const shot = async (name) => { if (shots) await page.screenshot({ path: join(shots, `robot-arm-floor-${name}.png`) }); };
  await page.evaluate(() => window.__pfRuntime.renderMode.set("realistic"));
  await page.waitForFunction(() => window.__pfRuntime.renderMode.get() === "realistic" && window.__pfRuntime.pose.__ground() != null, null, { timeout: 30000 });
  await sleep(400);
  const ground = () => page.evaluate(() => window.__pfRuntime.pose.__ground());
  const g0 = await ground();
  await shot("before");
  const h = await pickHandle(page, box, "tool");
  await page.mouse.move(h.px + 18, h.py, { steps: 3 });
  await page.mouse.move(h.px, h.py, { steps: 3 });
  await sleep(50);
  // Far sideways: toward whichever canvas edge is further, ~40% of the width.
  const dir = h.px - box.x < box.width / 2 ? 1 : -1;
  const travel = box.width * 0.4 * dir;
  const commits0 = await page.evaluate(() => window.__pfCommits.length);
  const tool0 = { x: h.x, y: h.y };
  await page.mouse.down();
  const samples = [];
  for (let i = 1; i <= DRAG_MOVES; i++) {
    await page.mouse.move(h.px + (travel * i) / DRAG_MOVES, h.py);
    await sleep(20);
    samples.push(await ground());
    if (i === Math.floor(DRAG_MOVES / 2)) await shot("mid-drag");
  }
  await sleep(80);
  await shot("end-of-drag");
  await page.mouse.up();
  await sleep(1200); // the release's build, if any, lands
  const g1 = await ground();
  await shot("after");
  const tool1 = await page.evaluate(() => window.__pfRuntime.pose.handlePoints().find((p) => p.handleId === "tool") ?? null);
  const toolMoved = tool1 ? Math.hypot(tool1.x - tool0.x, tool1.y - tool0.y) : 0;
  if (!(toolMoved > 40)) errors.push(`the realistic floor check's tool drag moved the tool only ${toolMoved.toFixed(1)} px`);
  if ((await page.evaluate(() => window.__pfCommits.length)) - commits0 !== 1) errors.push("the realistic floor drag did not commit exactly once");
  let slide = 0, rescale = 0, rose = 0;
  for (const g of [...samples, g1]) {
    if (!g) { errors.push("the realistic floor vanished during the drag"); break; }
    slide = Math.max(slide, Math.hypot(g.position[0] - g0.position[0], g.position[2] - g0.position[2]));
    rescale = Math.max(rescale, ...g.scale.map((v, i) => Math.abs(v - g0.scale[i])));
    rose = Math.max(rose, g.position[1] - g0.position[1]);
  }
  if (slide > 1e-6) errors.push(`posing slid the realistic floor ${slide.toFixed(3)} mm sideways`);
  if (rescale > 1e-6) errors.push(`posing rescaled the realistic floor by ${rescale.toFixed(4)}`);
  if (rose > 1e-6) errors.push(`posing lifted the realistic floor ${rose.toFixed(3)} mm`);
  await page.evaluate(() => window.__pfRuntime.renderMode.set("cad"));
  return { toolMovedPx: Number(toolMoved.toFixed(1)), floorSlideMm: slide, floorRescale: rescale, floorAt: g0.position.map((v) => Number(v.toFixed(2))) };
}

/**
 * Pin the arm's elbow by clicking its dot (a goal handle's ring-only joint): one pin, a
 * badge at the elbow, no commit. Then drag the tool: the elbow holds (within 0.5 mm), the
 * tool moves, one commit. A second click unpins.
 */
async function checkJointPin(page, box, errors) {
  const at = (p) => ({ x: box.x + p.x, y: box.y + p.y });
  const elbowDot = async () => (await page.evaluate(() => window.__pfRuntime.pose.__jointRings())).find((p) => p.limb === "arm" && p.joint === "elbow");
  const dot = await elbowDot();
  if (!dot) { errors.push("no elbow dot to pin"); return null; }
  const d = at(dot);
  await page.mouse.move(d.x + 18, d.y, { steps: 3 });
  await page.mouse.move(d.x, d.y, { steps: 3 });
  await sleep(50);
  const cursor = await canvasCursor(page);
  if (cursor !== "pointer") errors.push(`hovering the elbow dot shows cursor "${cursor}", not "pointer"`);
  const commits0 = await page.evaluate(() => window.__pfCommits.length);
  await page.mouse.down();
  await page.mouse.up();
  await sleep(100);
  const state = await page.evaluate(() => ({
    count: window.__pfRuntime.pose.pinCount(),
    pins: window.__pfRuntime.getViewerState().pose?.pins ?? null,
    badges: window.__pfRuntime.pose.__pinPoints(),
    commits: window.__pfCommits.length,
  }));
  if (state.count !== 1) errors.push(`clicking the elbow dot left pinCount ${state.count}, expected 1`);
  if (!state.pins?.includes("tool:elbow")) errors.push(`clicking the elbow dot pinned ${JSON.stringify(state.pins)}, not tool:elbow`);
  const badge = state.badges.find((b) => b.limb === "arm" && b.at === "elbow");
  if (!badge) errors.push(`no pin badge at the elbow (${JSON.stringify(state.badges)})`);
  else if (Math.hypot(badge.x - dot.x, badge.y - dot.y) > 1) errors.push(`the elbow's pin badge sits ${Math.hypot(badge.x - dot.x, badge.y - dot.y).toFixed(1)} px off the elbow`);
  if (state.commits !== commits0) errors.push("pinning the elbow committed params");
  if (!badge) return null;
  // drag the tool with the elbow pinned
  const h = await pickHandle(page, box, "tool");
  const tool0 = { x: h.x, y: h.y };
  await dragFrom(page, h, box);
  const mid = await page.evaluate(() => window.__pfRuntime.pose.__pinPoints().find((b) => b.at === "elbow")?.point ?? null);
  await page.mouse.up();
  await sleep(600);
  const after = await page.evaluate(() => ({
    elbow: window.__pfRuntime.pose.__pinPoints().find((b) => b.at === "elbow")?.point ?? null,
    tool: window.__pfRuntime.pose.handlePoints().find((p) => p.handleId === "tool") ?? null,
    commits: window.__pfCommits.length,
  }));
  const off = (p) => (p ? Math.hypot(p[0] - badge.point[0], p[1] - badge.point[1], p[2] - badge.point[2]) : Infinity);
  if (!(off(mid) <= 0.5)) errors.push(`mid-drag the pinned elbow moved ${off(mid).toFixed(2)} mm`);
  if (!(off(after.elbow) <= 0.5)) errors.push(`after the tool drag the pinned elbow moved ${off(after.elbow).toFixed(2)} mm`);
  const toolMoved = after.tool ? Math.hypot(after.tool.x - tool0.x, after.tool.y - tool0.y) : 0;
  if (!(toolMoved > 5)) errors.push(`the tool moved only ${toolMoved.toFixed(1)} px with the elbow pinned`);
  if (after.commits - commits0 !== 1) errors.push(`${after.commits - commits0} commits after the pinned tool drag, expected 1`);
  // unpin: click the elbow again
  const again = await elbowDot();
  if (again) {
    const e = at(again);
    await page.mouse.move(e.x + 18, e.y, { steps: 3 });
    await page.mouse.move(e.x, e.y, { steps: 3 });
    await sleep(50);
    await page.mouse.down();
    await page.mouse.up();
    await sleep(100);
  }
  const left = await page.evaluate(() => window.__pfRuntime.pose.pinCount());
  if (left !== 0) errors.push(`clicking the pinned elbow again left pinCount ${left}`);
  return { elbowHeldMm: Number(Math.max(off(mid), off(after.elbow)).toFixed(3)), toolMovedPx: Number(toolMoved.toFixed(1)) };
}

/**
 * Hover a joint's dot, then drag its ring: the ring shows and highlights, one commit writes
 * `param` (and moves each of `alsoMoves`), no generate job during the drag.
 */
async function checkJointRing(page, box, { limb, joint, param, alsoMoves = [] }, errors) {
  const label = `${limb}.${joint}`;
  const points = await page.evaluate(() => window.__pfRuntime.pose.__jointRings());
  const dot = points.find((p) => p.limb === limb && p.joint === joint);
  if (!dot) { errors.push(`no joint ring on ${label} (__jointRings: ${JSON.stringify(points)})`); return null; }
  const at = (p) => ({ x: box.x + p.x, y: box.y + p.y });
  const d = at(dot);
  await page.mouse.move(d.x + 18, d.y, { steps: 3 });
  await page.mouse.move(d.x, d.y, { steps: 3 });
  await sleep(50);
  const g = await page.evaluate(() => window.__pfRuntime.pose.__jointGizmo());
  if (!g || g.limb !== limb || g.joint !== joint) { errors.push(`hovering ${label} shows ${g ? `${g.limb}.${g.joint}'s` : "no"} joint ring`); return null; }
  if (await page.evaluate(() => window.__pfRuntime.pose.__aimGizmo())) errors.push(`hovering ${label} also shows the aim gizmo`);
  const name = Object.keys(g.rings)[0];
  const ring = g.rings[name];
  if (!ring?.ahead) { errors.push(`no grabbable point on ${label}'s ring (${JSON.stringify(g.rings)})`); return null; }
  const from = at(ring), to = at(ring.ahead);
  await page.mouse.move(from.x, from.y, { steps: 4 });
  await sleep(50);
  const hov = await page.evaluate(() => window.__pfRuntime.pose.__jointGizmo()?.hovered ?? null);
  if (hov !== name) errors.push(`hovering ${label}'s ${name} ring hovers "${hov}"`);
  const cursor = await canvasCursor(page);
  if (cursor !== "grab") errors.push(`hovering ${label}'s ring shows cursor "${cursor}", not "grab"`);
  const commits0 = await page.evaluate(() => window.__pfCommits.length);
  // the params now: the last commit's (every drag before this one committed), else the defaults
  const before = await page.evaluate(() => ({ ...window.__pfPart?.defaults, ...window.__pfCommits.at(-1)?.params }));
  const t0 = await page.evaluate(() => performance.now());
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12);
    await sleep(20);
  }
  const during = await page.evaluate(() => window.__pfRuntime.pose.__jointGizmo()?.hovered ?? null);
  const grabbing = await canvasCursor(page);
  await sleep(80);
  const ringGenerates = generates(await page.evaluate(() => window.__pfWorkerLog), t0);
  await page.mouse.up();
  await sleep(600);
  if (during !== name) errors.push(`dragging ${label}'s ring left "${during}" highlighted`);
  if (grabbing !== "grabbing") errors.push(`dragging ${label}'s ring shows cursor "${grabbing}", not "grabbing"`);
  if (ringGenerates.length) errors.push(`${ringGenerates.length} generate job(s) posted during ${label}'s ring drag`);
  const added = (await page.evaluate(() => window.__pfCommits)).slice(commits0);
  if (added.length !== 1) { errors.push(`${added.length} onParamsCommit calls after ${label}'s ring drag, expected exactly 1`); return null; }
  const { changed, params } = added[0];
  if (!changed?.includes(param)) errors.push(`${label}'s ring drag committed ${JSON.stringify(changed)}, not ${param}`);
  if (Object.is(params[param], before[param])) errors.push(`${label}'s ring drag left ${param} at ${before[param]}`);
  const moved = alsoMoves.filter((k) => Math.abs((params[k] ?? 0) - (before[k] ?? 0)) > 0.05);
  if (alsoMoves.length && !moved.length) errors.push(`${label}'s ring drag moved none of ${alsoMoves.join(", ")}`);
  return { ring: `${label}:${name}`, generatesDuringDrag: ringGenerates.length, commit: changed, [param]: [before[param], params[param]], moved };
}

/** The reference drag, then the wrist pitch ring (a joint on the palm limb, which no handle drags). */
async function checkHand(page, url, errors) {
  const summary = await checkReference(page, url, errors);
  const box = await page.locator(VIEWER_CANVAS).boundingBox();
  const joint = await checkJointRing(page, box, { limb: "palm", joint: "wristPitch", param: "wristPitch" }, errors);
  const viewSwitch = await checkViewSwitch(page, box, errors);
  return { ...summary, joint, viewSwitch };
}

/** The pose overlay's state, read in the page: what a view switch must leave empty. */
const poseState = (page) => page.evaluate((sel) => {
  const pose = window.__pfRuntime.pose;
  return {
    points: pose.handlePoints().length, pins: pose.__pinPoints().length, pinCount: pose.pinCount(),
    drawn: pose.__drawn(), chip: pose.__chip(), aim: pose.__aimGizmo(), joint: pose.__jointGizmo(),
    cursor: document.querySelector(sel).style.cursor,
  };
}, VIEWER_CANVAS);

/**
 * Handles are view-specific (pose/handle-views.js): hand.html's print view is a flat kit the
 * pose never reaches, so after a pin and a hover in the assembly view, a switch to print
 * (the pointer left on the dot) must leave nothing: no handle points, badges, overlay
 * objects, gizmo, readout chip, grab cursor or hover claim — and a sweep of the canvas
 * (the old dots' spots included) claims nothing, and a press where a dot was does not drag.
 * Back in the assembly view the handles and the pin come back.
 */
async function checkViewSwitch(page, box, errors) {
  const pts = await page.evaluate(() => window.__pfRuntime.pose.handlePoints());
  const h = pts.find((p) => p.handleId === "index" && p.at === "tip") ?? pts[0];
  if (!h) { errors.push("view switch: no handle point in the assembly view"); return null; }
  const at = { x: box.x + h.x, y: box.y + h.y };
  await hoverHandle(page, at, `${h.handleId}:${h.at}`);
  await page.mouse.down();
  await page.mouse.up();
  await sleep(80);
  const before = await poseState(page);
  if (before.pins !== 1) errors.push(`view switch: a click on ${h.handleId}:${h.at} badged ${before.pins} pins, expected 1`);
  if (!before.drawn.objects || !before.drawn.claims) errors.push(`view switch: hovering ${h.handleId}:${h.at} drew ${before.drawn.objects} objects, claims ${before.drawn.claims}`);
  const commits = (await page.evaluate(() => window.__pfCommits)).length;

  await page.evaluate(() => window.__pfRuntime.setView("print"));
  await settle(page);
  const after = await poseState(page);
  const stale = (s, label) => {
    const bad = [];
    if (s.points) bad.push(`${s.points} handle points`);
    if (s.pins) bad.push(`${s.pins} pin badges`);
    if (s.pinCount) bad.push(`pinCount ${s.pinCount}`);
    if (s.drawn.objects) bad.push(`${s.drawn.objects} overlay objects`);
    if (s.drawn.claims) bad.push("a hover claim");
    if (s.chip) bad.push("the readout chip");
    if (s.aim || s.joint) bad.push("a gizmo");
    if (s.cursor === "grab" || s.cursor === "grabbing") bad.push(`cursor "${s.cursor}"`);
    if (bad.length) errors.push(`view switch: ${label} the print view shows ${bad.join(", ")}`);
    return bad.length;
  };
  stale(after, "right after the switch,");
  // Sweep the canvas, the old dots' spots first: nothing may claim the hover there.
  const spots = [...pts.map((p) => ({ x: box.x + p.x, y: box.y + p.y }))];
  for (let i = 1; i < 8; i++) for (let j = 1; j < 6; j++) spots.push({ x: box.x + (box.width * i) / 8, y: box.y + (box.height * j) / 6 });
  let claimed = 0;
  for (const s of spots) {
    await page.mouse.move(s.x, s.y);
    const st = await poseState(page);
    if (st.drawn.claims || st.drawn.objects || st.cursor === "grab") claimed++;
  }
  if (claimed) errors.push(`view switch: ${claimed} of ${spots.length} pointer spots in the print view showed or claimed a handle`);
  // a press where the dot was is an orbit, never a drag
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) { await page.mouse.move(at.x + i * 6, at.y); await sleep(20); }
  const dragging = await page.evaluate(() => window.__pfRuntime.pose.__isDragging());
  await page.mouse.up();
  if (dragging) errors.push("view switch: a press where a dot was in the assembly view dragged a handle in the print view");
  const commitsAfter = (await page.evaluate(() => window.__pfCommits)).length;
  if (commitsAfter !== commits) errors.push(`view switch: ${commitsAfter - commits} commits in the print view, expected none`);

  await page.evaluate(() => window.__pfRuntime.setView("assembly"));
  await settle(page);
  const back = await poseState(page);
  if (!back.points) errors.push("view switch: no handle points back in the assembly view");
  if (back.pins !== 1) errors.push(`view switch: ${back.pins} pin badges back in the assembly view, expected 1 (the pin is kept)`);
  await page.evaluate(() => window.__pfRuntime.pose.releasePins());
  return { printPoints: after.points, printObjects: after.drawn.objects, spots: spots.length, claimed, backPoints: back.points };
}

/** Wait until two animation frames have run. */
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/**
 * Where handle `id` sits on the canvas with each patch of `patches` applied in turn
 * (runtime.setParams), then `restore` applied and the page settled: `[{ x, y } | null]`,
 * CSS px from the canvas's top-left. How the check learns which way a handle moves on
 * screen without reading the camera.
 */
async function handleAt(page, id, patches, restore) {
  const out = [];
  for (const patch of patches) {
    await page.evaluate((p) => window.__pfRuntime.setParams(p), patch);
    await frames(page);
    out.push(await page.evaluate((i) => window.__pfRuntime.pose.handlePoints().find((p) => p.handleId === i) ?? null, id));
  }
  await page.evaluate((p) => window.__pfRuntime.setParams(p), restore);
  await settle(page);
  return out;
}

/** Let any build the page owes land (past the 180 ms regen debounce), then a frame. */
async function settle(page) {
  await sleep(600);
  await page.waitForFunction(() => document.getElementById("download")?.disabled === false, null, { timeout: 30000 });
  await frames(page);
}

/** Hover a handle point (from the side, so its reveal shows it) and require the grab cursor. */
async function hoverHandle(page, at, label) {
  await page.mouse.move(at.x + 18, at.y, { steps: 3 });
  await page.mouse.move(at.x, at.y, { steps: 3 });
  await sleep(50);
  const cursor = await canvasCursor(page);
  if (cursor !== "grab") throw new Error(`hovering ${label} shows cursor "${cursor}", not "grab"`);
}

const onCanvasAt = (page, at) => page.evaluate(([x, y, sel]) => document.elementFromPoint(x, y) === document.querySelector(sel), [at.x, at.y, VIEWER_CANVAS]);

/** The drag's commits since `since`, as one: errors unless exactly one was made. */
async function oneCommit(page, since, label, errors) {
  const added = (await page.evaluate(() => window.__pfCommits)).slice(since);
  if (added.length !== 1) { errors.push(`${added.length} onParamsCommit calls after ${label}, expected exactly 1`); return null; }
  return added[0];
}

const GEAR_TURN_STEPS = 96;

/**
 * The gearbox (parts/gearbox.js): drag the output gear's rim dot one full turn round its
 * own rim. gear3 turns at +1/2 the drive, so one turn of it writes driveAngle 0 -> 720:
 * the drag passes 360 with no stop, no wrap and no backwards frame (sampled every frame
 * from the dot's place on the rim), posts no `generate` job (turning the train is
 * matrix-only), and commits once, about 720 — the wrapped param stored unreduced.
 *
 * The rim's path on screen comes from the dot itself: with driveAngle 0, 180, 360 and 540
 * it sits at 0, 90, 180 and 270 degrees round gear3, which fixes the ellipse the rim
 * projects to (centre, and the 0 and 90 degree axes); the pointer then follows it.
 */
async function checkGearbox(page, url, errors) {
  const box = await openPoseApp(page, url);
  const ID = "gear3";
  const pts = await handleAt(page, ID, [0, 180, 360, 540].map((a) => ({ driveAngle: a })), { driveAngle: 0 });
  if (pts.some((p) => !p)) throw new Error(`no ${ID} handle point at some drive angle (${JSON.stringify(pts)})`);
  const c = { x: pts.reduce((a, p) => a + p.x, 0) / 4, y: pts.reduce((a, p) => a + p.y, 0) / 4 };
  const u = { x: pts[0].x - c.x, y: pts[0].y - c.y }, v = { x: pts[1].x - c.x, y: pts[1].y - c.y };
  const rim = (deg) => {
    const r = (deg * Math.PI) / 180;
    return { x: box.x + c.x + u.x * Math.cos(r) + v.x * Math.sin(r), y: box.y + c.y + u.y * Math.cos(r) + v.y * Math.sin(r) };
  };
  // A canvas point's angle round the rim's ellipse, degrees (u at 0, v at 90).
  const det = u.x * v.y - u.y * v.x;
  if (Math.abs(det) < 100) throw new Error(`${ID}'s rim is edge-on on screen (u ${JSON.stringify(u)}, v ${JSON.stringify(v)})`);
  const angleOf = (p) => {
    const dx = p.x - c.x, dy = p.y - c.y;
    return (Math.atan2((u.x * dy - u.y * dx) / det, (dx * v.y - dy * v.x) / det) * 180) / Math.PI;
  };
  const start = rim(0);
  for (let a = 0; a < 360; a += 15) {
    if (!(await onCanvasAt(page, rim(a)))) throw new Error(`${ID}'s rim at ${a} degrees is not on the canvas`);
  }
  await hoverHandle(page, start, `${ID}'s rim dot`);
  const commits0 = await page.evaluate(() => window.__pfCommits.length);
  const t0 = await page.evaluate(() => performance.now());
  await page.evaluate((id) => window.__pfSampleHandle(id), ID);
  await page.mouse.down();
  let grabbing = null;
  for (let i = 1; i <= GEAR_TURN_STEPS; i++) {
    const p = rim((360 * i) / GEAR_TURN_STEPS);
    await page.mouse.move(p.x, p.y);
    await sleep(20);
    if (i === GEAR_TURN_STEPS / 2) {
      if (!(await page.evaluate(() => window.__pfRuntime.pose.__isDragging()))) {
        await page.mouse.up();
        throw new Error(`a drag from ${ID}'s rim never started`);
      }
      grabbing = await canvasCursor(page);
    }
  }
  await sleep(120);
  const samples = await page.evaluate(() => { window.__pfHandleSampling = false; return window.__pfHandleSamples; });
  const during = generates(await page.evaluate(() => window.__pfWorkerLog), t0);
  await page.mouse.up();
  await sleep(600);
  if (grabbing !== "grabbing") errors.push(`turning ${ID} shows cursor "${grabbing}", not "grabbing"`);
  if (during.length) errors.push(`${during.length} generate job(s) posted while turning ${ID} (a gear train turns by matrix)`);
  // Unwrap the dot's angle frame by frame: it may only go forward.
  let turned = 0, back = 0, prev = null;
  for (const s of samples) {
    const a = angleOf(s);
    if (prev != null) {
      const step = ((a - prev + 540) % 360) - 180;
      turned += step;
      back = Math.min(back, step);
    }
    prev = a;
  }
  if (back < -0.5) errors.push(`${ID}'s dot stepped backwards ${(-back).toFixed(2)} degrees in one frame`);
  if (Math.abs(turned - 360) > 5) errors.push(`${ID}'s dot turned ${turned.toFixed(1)} degrees on screen, not one turn`);
  const commit = await oneCommit(page, commits0, `turning ${ID}`, errors);
  const drive = commit?.params?.driveAngle;
  if (commit && !commit.changed?.includes("driveAngle")) errors.push(`turning ${ID} committed ${JSON.stringify(commit.changed)}, not driveAngle`);
  if (commit && !(Math.abs(drive - 720) <= 5)) errors.push(`one turn of ${ID} committed driveAngle ${drive}, not about 720`);
  return { handle: ID, frames: samples.length, turnedDeg: Number(turned.toFixed(1)), worstBackStepDeg: Number((-back).toFixed(3)), generatesDuringDrag: during.length, driveAngle: drive ?? null };
}

/**
 * The drawer box (parts/drawer-box.js): a MOTION drag, then a SHAPE drag, on one part.
 *   - drawer1's pull, along its rail (an axis handle): grabbed on its two-sided arrow's
 *     shaft, at its far end toward a head (past the 14 px a dot's centre would pick), no
 *     `generate` job (a drawer slides by matrix), one commit opening drawer1 to about 60%
 *     of its travel, the other drawers where they were;
 *   - while it slides, its value in the viewbar's readout slot (measure's spot), gone on release;
 *   - the readout chip that drag leaves by the pull: typed into, it commits the snapped value once;
 *   - the top corner, across the top plane (a plane handle): the part is cheap (its last
 *     build under LIVE_REBUILD_MS), so it rebuilds LIVE — `generate` jobs during the drag —
 *     yet the host sees none of it: no onBuild until release, exactly one after, and one
 *     commit growing width and depth about 40 mm each.
 */
async function checkDrawerBox(page, url, errors) {
  const box = await openPoseApp(page, url);
  const defaults = await page.evaluate(() => window.__pfPart.defaults);
  const canvas = (p) => ({ x: box.x + p.x, y: box.y + p.y });
  const drag = async (from, to, label) => {
    await hoverHandle(page, from, label);
    await page.mouse.down();
    for (let i = 1; i <= DRAG_MOVES; i++) {
      await page.mouse.move(from.x + ((to.x - from.x) * i) / DRAG_MOVES, from.y + ((to.y - from.y) * i) / DRAG_MOVES);
      await sleep(20);
      if (i === DRAG_MOVES / 2 && !(await page.evaluate(() => window.__pfRuntime.pose.__isDragging()))) {
        await page.mouse.up();
        throw new Error(`a drag from ${label} never started`);
      }
    }
    await sleep(120);
  };

  // Motion: drawer1 out along its rail.
  const [d0, d1] = await handleAt(page, "drawer1", [{ drawer1Open: 0 }, { drawer1Open: 60 }], { drawer1Open: defaults.drawer1Open });
  if (!d0 || !d1) throw new Error("no drawer1 handle point");
  if (!d0.arrow) throw new Error(`drawer1's axis handle reports no arrow (${JSON.stringify(d0)})`);
  // on the shaft, near its end toward the head the pull runs toward (the shaft is the inner
  // 60% of each half: ARROW_HALF_LENGTH less ARROW_HEAD_LENGTH)
  const toward = Math.hypot(d0.arrow.to.x - d1.x, d0.arrow.to.y - d1.y) < Math.hypot(d0.arrow.from.x - d1.x, d0.arrow.from.y - d1.y) ? d0.arrow.to : d0.arrow.from;
  const SHAFT_AT = 0.56;
  const shaft = { x: d0.x + (toward.x - d0.x) * SHAFT_AT, y: d0.y + (toward.y - d0.y) * SHAFT_AT };
  const shaftOff = Math.hypot(shaft.x - d0.x, shaft.y - d0.y);
  if (shaftOff <= 14) errors.push(`drawer1's arrow's shaft end is ${shaftOff.toFixed(1)} px from its centre: within a dot's 14 px, so the press tests nothing`);
  let commits0 = await page.evaluate(() => window.__pfCommits.length);
  let t0 = await page.evaluate(() => performance.now());
  await drag(canvas(shaft), canvas({ x: shaft.x + d1.x - d0.x, y: shaft.y + d1.y - d0.y }), "drawer1's arrow, mid-shaft");
  const drawerJobs = generates(await page.evaluate(() => window.__pfWorkerLog), t0);
  // The live readout: in the viewbar's readout slot (measure's X/Y/Z spot), floated just
  // above the bar with right edges flush, the view cube stepped up over it.
  const liveReadout = await page.evaluate(() => {
    const rect = (sel) => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r && { top: r.top, bottom: r.bottom, right: r.right }; };
    return { text: window.__pfRuntime.pose.__dragReadout(), slot: rect("#viewbar .pf-pose-readout"), bar: rect("#viewbar"), cube: rect(".pf-viewcube-stack") };
  });
  if (!/Drawer 1/i.test(liveReadout.text ?? "")) errors.push(`no live readout in the viewbar slot while sliding drawer1 (${JSON.stringify(liveReadout.text)})`);
  else if (!liveReadout.slot || !liveReadout.bar || Math.abs(liveReadout.slot.right - liveReadout.bar.right) > 2 || liveReadout.slot.bottom > liveReadout.bar.top) {
    errors.push(`the live readout is not floated above the viewbar, right edges flush (${JSON.stringify(liveReadout)})`);
  } else if (liveReadout.cube && liveReadout.cube.bottom > liveReadout.slot.top + 0.5) {
    errors.push(`the view cube overlaps the live readout (${JSON.stringify(liveReadout)})`);
  }
  await page.mouse.up();
  await settle(page);
  if (await page.evaluate(() => window.__pfRuntime.pose.__dragReadout())) errors.push("the live readout stayed up after the drag ended");
  if (drawerJobs.length) errors.push(`${drawerJobs.length} generate job(s) posted while sliding drawer1 (a drawer slides by matrix)`);
  const slide = await oneCommit(page, commits0, "sliding drawer1", errors);
  const open = slide?.params?.drawer1Open;
  if (slide && !(Math.abs(open - 60) <= 6)) errors.push(`sliding drawer1 to its 60% mark committed drawer1Open ${open}`);
  for (const k of ["drawer2Open", "drawer3Open", "width", "depth", "height"]) {
    if (slide && !Object.is(slide.params[k], defaults[k])) errors.push(`sliding drawer1 moved ${k} (${defaults[k]} -> ${slide.params[k]})`);
  }

  // The readout chip: it shows by drawer1 after the slide; click it, type 20.34 and Enter —
  // one commit of the snapped value (step 0.1: 20.3), then the chip goes.
  const chip = await page.evaluate(() => window.__pfRuntime.pose.__chip());
  if (chip?.handleId !== "drawer1" || chip.kind !== "values") errors.push(`no readout chip by drawer1 after the slide (${JSON.stringify(chip)})`);
  let typed = null;
  if (chip) {
    commits0 = await page.evaluate(() => window.__pfCommits.length);
    await page.click(".pf-pose-chip-value");
    await page.fill('.pf-pose-chip input[name="drawer1Open"]', "20.34");
    await page.press('.pf-pose-chip input[name="drawer1Open"]', "Enter");
    await settle(page);
    const edit = await oneCommit(page, commits0, "the chip edit", errors);
    typed = edit?.params?.drawer1Open ?? null;
    if (edit && typed !== 20.3) errors.push(`the chip edit committed drawer1Open ${typed}, not 20.3 (20.34 snapped to its 0.1 step)`);
    if (await page.evaluate(() => window.__pfRuntime.pose.__chip())) errors.push("the readout chip stayed up after its edit was written");
  }

  // Shape: the top corner outward, live-rebuilt.
  const w = defaults.width, dp = defaults.depth;
  const [c0, c1] = await handleAt(page, "corner", [{ width: w, depth: dp }, { width: w + 40, depth: dp + 40 }], { width: w, depth: dp });
  if (!c0 || !c1) throw new Error("no corner handle point");
  const lastBuildMs = lastBuildTime(await page.evaluate(() => window.__pfWorkerLog));
  commits0 = await page.evaluate(() => window.__pfCommits.length);
  const builds0 = await page.evaluate(() => window.__pfBuilds.length);
  t0 = await page.evaluate(() => performance.now());
  await drag(canvas(c0), canvas(c1), "the cabinet's corner");
  const live = generates(await page.evaluate(() => window.__pfWorkerLog), t0);
  const buildsDuring = (await page.evaluate(() => window.__pfBuilds.length)) - builds0;
  await page.mouse.up();
  await settle(page);
  const buildsAfter = (await page.evaluate(() => window.__pfBuilds.length)) - builds0 - buildsDuring;
  if (!live.length) errors.push(`no generate job during the corner drag: a part this cheap (last build ${lastBuildMs} ms) rebuilds live`);
  if (buildsDuring) errors.push(`onBuild fired ${buildsDuring} time(s) during the corner drag (mid-drag builds are transient)`);
  if (buildsAfter !== 1) errors.push(`onBuild fired ${buildsAfter} time(s) after the corner drag's release, expected exactly 1`);
  const grow = await oneCommit(page, commits0, "the corner drag", errors);
  if (grow) {
    for (const [k, want] of [["width", w + 40], ["depth", dp + 40]]) {
      if (!(Math.abs(grow.params[k] - want) <= 6)) errors.push(`the corner drag committed ${k} ${grow.params[k]}, not about ${want}`);
    }
    if (!Object.is(grow.params.height, defaults.height)) errors.push(`the corner drag moved height (${defaults.height} -> ${grow.params.height})`);
  }
  return {
    drawer: { pressPxFromCentre: Number(shaftOff.toFixed(1)), generatesDuringDrag: drawerJobs.length, drawer1Open: open ?? null, chipTyped: typed },
    corner: { lastBuildMs, liveGenerates: live.length, buildsDuring, buildsAfter, width: grow?.params?.width ?? null, depth: grow?.params?.depth ?? null },
  };
}

const PAGES = [
  { entry: "pose-smoke.html", run: checkSmoke, required: true },
  { entry: "robot-arm.html", run: checkRobotArm, required: true },
  { entry: "hand.html", run: checkHand, required: true },
  { entry: "gearbox.html", run: checkGearbox, required: true },
  { entry: "drawer-box.html", run: checkDrawerBox, required: true },
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
