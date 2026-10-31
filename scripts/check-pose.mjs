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
//     whose build reads p.aCurl) must fade to 0.35 during the drag, no `generate` job
//     may be posted until release, exactly one is posted after it, and the new mesh
//     and opacity 1 must reach the screen in the same frame (sampled every frame:
//     never the new geometry still ghosted, never the old geometry back at full).
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
//     goal follows the turned joint).
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

/** Load a page and wait for its first build; posing must be live with no toggle. Returns the canvas box. */
async function openPoseApp(page, url) {
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => document.getElementById("download")?.disabled === false, { timeout: 60000 });
  if (await page.locator("#pose:visible").count()) throw new Error("a visible #pose toggle: posing has no toggle");
  await sleep(150); // a frame or two
  if (!(await page.evaluate(() => window.__pfRuntime.pose.isLive()))) throw new Error("posing is not live after the first build");
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
  const picks = await checkPicks(page, box, errors);
  const measure = await checkMeasureHides(page, box, errors);
  return { midOpacity, jobs: result.jobs.length, after: result.after?.opacity, commits: result.commits?.length ?? null, frames: result.samples.length, pins: pinned.pins, ...picks, ...measure };
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
  return { ...summary, ring: name, ringCommit: added[0]?.changed ?? null, ringValue: aimParam ? added[0]?.params?.[aimParam] : null, joint };
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
  return { ...summary, joint };
}

const PAGES = [
  { entry: "pose-smoke.html", run: checkSmoke, required: true },
  { entry: "robot-arm.html", run: checkRobotArm, required: true },
  { entry: "hand.html", run: checkHand, required: true },
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
