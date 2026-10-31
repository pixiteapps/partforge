// Frame-time bench for posing (inverse kinematics): drives robot-arm.html and
// hand.html in real Chromium and reports, per scenario, the main-thread milliseconds
// each animation frame spends in script (every rAF callback and every pointer listener,
// timed by wrappers installed before the app loads), the frame rate, the part's
// main-thread derive() calls, and the top self-time functions from a CDP CPU profile.
//
//   npm run bench:pose -- [--preview] [--url <base>] [--json <file>] [--no-profile] [--swiftshader]
//
// Without --url it starts its own server: the Vite dev server, or with --preview a
// production build (built into a temp dir with base "/") served by `vite preview`.
//
// Each scenario presses with a real mouse (so pointer capture and orbit arbitration are
// the app's own), then sends exactly ONE pointermove per animation frame from inside
// the page for 60 frames — a steady 60-120 Hz mouse — so every measured frame carries one
// move and, while dragging, one solve:
//   hover        no press: back and forth across the first limb (its dots shown)
//   dragTip      the first handle's point (hand: the index tip; arm: the tool's ball)
//   dragPinned   hand only: the thumb tip pinned, then the index tip dragged (both
//                handles list the wrist, so the solve holds the thumb through it)
//   aimRing      arm only: round the aim gizmo's pitch ring
//   idleOrbit    a tip pinned (its badge drawn), then an orbit drag on the background
//
// On macOS Chromium runs on the GPU (ANGLE Metal); --swiftshader keeps Playwright's
// software GL, where rendering, not script, sets the frame time.
// Requires Playwright + Chromium: `npm i -D playwright && npx playwright install chromium`.
import { chromium } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const PORT = Number(process.env.BENCH_PORT) || 5192;
const preview = args.includes("--preview");
const profile = !args.includes("--no-profile");
const root = fileURLToPath(new URL("..", import.meta.url));
const VIEWER_CANVAS = "#app > canvas:not(.pf-ink-canvas)";
const FRAMES = 60;

let server = null;
let outDir = null;
async function startServer() {
  const vite = join(root, "node_modules/vite/bin/vite.js");
  let cmd = [vite, "--port", String(PORT), "--strictPort"];
  if (preview) {
    outDir = mkdtempSync(join(tmpdir(), "partforge-bench-pose-"));
    const built = spawnSync(process.execPath, [vite, "build", "--base", "/", "--outDir", outDir, "--emptyOutDir"], { cwd: root, stdio: "ignore" });
    if (built.status !== 0) throw new Error("vite build failed");
    cmd = [vite, "preview", "--base", "/", "--outDir", outDir, "--port", String(PORT), "--strictPort"];
  }
  server = spawn(process.execPath, cmd, { cwd: root, detached: true, stdio: "ignore" });
  server.unref();
  const base = `http://localhost:${PORT}`;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/hand.html`, { signal: AbortSignal.timeout(250) })).ok) return base; } catch { /* starting */ }
    await sleep(250);
  }
  throw new Error("server did not start");
}
function stopServer() {
  try { if (server?.pid) process.kill(-server.pid, "SIGTERM"); } catch { /* gone */ }
  if (outDir) rmSync(outDir, { recursive: true, force: true });
}

// In the page before any app script: time every rAF callback and pointer listener, and
// count the part's derive() calls.
function instrument() {
  const now = () => performance.now();
  let acc = 0;
  let depth = 0;
  const wrap = (fn) => function (...a) {
    if (depth++) { try { return fn.apply(this, a); } finally { depth--; } }
    const t = now();
    try { return fn.apply(this, a); } finally { acc += now() - t; depth--; }
  };
  const rawRAF = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => rawRAF(wrap(cb));
  const types = new Set(["pointermove", "pointerdown", "pointerup", "mousemove", "wheel"]);
  const wrapped = new WeakMap();
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, o) {
    if (types.has(type) && typeof fn === "function") {
      let w = wrapped.get(fn);
      if (!w) { w = wrap(fn); wrapped.set(fn, w); }
      return add.call(this, type, w, o);
    }
    return add.call(this, type, fn, o);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, o) {
    return remove.call(this, type, (typeof fn === "function" && wrapped.get(fn)) || fn, o);
  };
  const bench = { frames: null, derives: 0 };
  window.__bench = bench;
  /** One pointermove per animation frame through `points` (client px); per-frame script ms recorded. */
  window.__benchMoves = (selector, points, pointerId) => new Promise((resolve) => {
    const part = window.__pfPart;
    if (part && typeof part.derive === "function" && !part.derive.__bench) {
      const raw = part.derive;
      part.derive = function (...a) { bench.derives++; return raw.apply(this, a); };
      part.derive.__bench = true;
    }
    const el = document.querySelector(selector);
    bench.derives = 0;
    bench.frames = [];
    acc = 0;
    let last = now();
    let i = 0;
    const tick = () => {
      const t = now();
      if (i > 0) bench.frames.push({ busy: acc, dt: t - last });
      acc = 0;
      last = t;
      // two trailing frames: the last move's coalesced solve runs in the frame after it
      if (i >= points.length + 2) { resolve({ frames: bench.frames, derives: bench.derives }); return; }
      const p = points[i++];
      if (p) {
        el.dispatchEvent(new PointerEvent("pointermove", {
          clientX: p.x, clientY: p.y, pointerId, pointerType: "mouse", isPrimary: true,
          buttons: p.buttons ?? 0, bubbles: true, cancelable: true, composed: true,
        }));
      }
      rawRAF(tick);
    };
    rawRAF(tick);
  });
}

const pct = (xs, p) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const r1 = (v) => Math.round(v * 10) / 10;

/** Top self-time functions of a CDP profile, ms. */
function topSelf(prof, n = 12) {
  const byId = new Map(prof.nodes.map((nd) => [nd.id, nd]));
  const dt = prof.timeDeltas;
  const self = new Map();
  for (let i = 0; i < prof.samples.length; i++) {
    const f = byId.get(prof.samples[i]).callFrame;
    const file = (f.url || "").split("/").pop().split("?")[0];
    const key = `${f.functionName || "(anon)"} ${file}${file ? `:${f.lineNumber + 1}` : ""}`;
    self.set(key, (self.get(key) ?? 0) + (dt[i + 1] ?? 0) / 1000);
  }
  return [...self].filter(([k]) => !/^\((idle|program)\)/.test(k))
    .sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, ms]) => ({ fn: k, ms: r1(ms) }));
}

/** Send `points` one per frame (see instrument) and summarise the frames. */
async function measure(page, cdp, points, buttons) {
  if (cdp) { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 100 }); await cdp.send("Profiler.start"); }
  // Chromium's mouse is pointerId 1; a press's capture and listeners key on it.
  const run = await page.evaluate(([sel, pts]) => window.__benchMoves(sel, pts, 1), [VIEWER_CANVAS, points.map((p) => ({ ...p, buttons }))]);
  const prof = cdp ? (await cdp.send("Profiler.stop")).profile : null;
  const busy = run.frames.map((f) => f.busy);
  const dts = run.frames.map((f) => f.dt);
  const mean = dts.reduce((a, b) => a + b, 0) / (dts.length || 1);
  return {
    frames: run.frames.length,
    medianMs: r1(pct(busy, 50)), p95Ms: r1(pct(busy, 95)), maxMs: r1(Math.max(...busy)),
    fps: r1(1000 / mean), derivesPerFrame: r1(run.derives / points.length),
    top: prof ? topSelf(prof) : null,
  };
}

async function open(page, url) {
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => document.getElementById("download")?.disabled === false, null, { timeout: 60000 });
  await sleep(500);
  return page.locator(VIEWER_CANVAS).boundingBox();
}
const handlePoints = (page) => page.evaluate(() => window.__pfRuntime.pose.handlePoints());
const inBox = (box, p) => p.x > 30 && p.y > 30 && p.x < box.width - 30 && p.y < box.height - 30;

/** FRAMES points toward the canvas centre and back (~120 px out), with a little sideways wobble. */
function dragPoints(from, box) {
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const l = Math.hypot(cx - from.x, cy - from.y) || 1;
  const ux = (cx - from.x) / l, uy = (cy - from.y) / l;
  return Array.from({ length: FRAMES }, (_, i) => {
    const s = 120 * Math.sin(((i + 1) / FRAMES) * Math.PI);
    const w = 8 * Math.sin(i / 6);
    return { x: from.x + ux * s - uy * w, y: from.y + uy * s + ux * w };
  });
}

async function hoverOnto(page, at) {
  await page.mouse.move(at.x + 18, at.y, { steps: 3 });
  await page.mouse.move(at.x, at.y, { steps: 3 });
  await sleep(60);
}

/** Press at `from` (past the drag threshold first, so frame 1 is already a drag), measure `points`, release. */
async function dragMeasure(page, cdp, from, points) {
  await page.mouse.down();
  await page.mouse.move(from.x + 4, from.y + 4, { steps: 2 });
  await sleep(50);
  const r = await measure(page, cdp, points, 1);
  await page.mouse.up();
  await sleep(800);
  return r;
}

async function benchPage(browser, base, entry) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(instrument);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
  const cdp = profile ? await page.context().newCDPSession(page) : null;
  const box = await open(page, `${base}/${entry}`);
  const at = (p) => ({ x: box.x + p.x, y: box.y + p.y });
  const find = async (id) => (await handlePoints(page)).find((p) => (id == null || p.handleId === id) && inBox(box, p));
  const out = {};
  const first = await find(entry === "hand.html" ? "index" : null);
  if (!first) throw new Error(`${entry}: no handle point on the canvas`);

  // hover: back and forth across the first limb's point, no press
  await page.mouse.move(at(first).x + 200, at(first).y + 120);
  await sleep(100);
  out.hover = await measure(page, cdp, Array.from({ length: FRAMES }, (_, i) => {
    const t = Math.abs(((i / 30) % 2) - 1);
    return { x: at(first).x - 60 + 120 * t, y: at(first).y + 20 * Math.sin(i / 5) };
  }), 0);

  // dragTip
  await hoverOnto(page, at(first));
  out.dragTip = { handle: first.handleId, ...await dragMeasure(page, cdp, at(first), dragPoints(at(first), box)) };

  if (entry === "hand.html") {
    const thumb = await find("thumb");
    if (thumb) {
      await hoverOnto(page, at(thumb));
      await page.mouse.click(at(thumb).x, at(thumb).y);
      await sleep(200);
      const index = await find("index");
      await hoverOnto(page, at(index));
      out.dragPinned = { handle: "index, thumb pinned", ...await dragMeasure(page, cdp, at(index), dragPoints(at(index), box)) };
    }
  } else {
    const tool = await find(null);
    await hoverOnto(page, at(tool));
    const g = await page.evaluate(() => window.__pfRuntime.pose.__aimGizmo());
    const ring = g && (g.rings.pitch ?? Object.values(g.rings)[0]);
    if (ring?.ahead) {
      const from = at(ring), to = at(ring.ahead);
      await page.mouse.move(from.x, from.y, { steps: 4 });
      await sleep(60);
      // round the ring (three "ahead" steps) and back
      const pts = Array.from({ length: FRAMES }, (_, i) => {
        const t = 3 * Math.sin(((i + 1) / FRAMES) * Math.PI);
        return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      });
      out.aimRing = { handle: "pitch ring", ...await dragMeasure(page, cdp, from, pts) };
    }
  }

  // idleOrbit: a pinned tip's badge drawn, then orbit from the background
  if (!(await page.evaluate(() => window.__pfRuntime.pose.pinCount()))) {
    const tip = await find(null);
    await hoverOnto(page, at(tip));
    await page.mouse.click(at(tip).x, at(tip).y);
    await sleep(200);
  }
  const o = { x: box.x + 40, y: box.y + box.height - 40 };
  await page.mouse.move(o.x, o.y);
  await page.mouse.down();
  out.idleOrbit = await measure(page, cdp, Array.from({ length: FRAMES }, (_, i) => ({ x: o.x + i * 3, y: o.y - 30 * Math.sin(i / 20) })), 1);
  await page.mouse.up();
  out.gl = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
  });
  out.errors = errors;
  await page.close();
  return out;
}

let browser;
const results = {};
try {
  const base = (arg("--url") ?? await startServer()).replace(/\/$/, "");
  // A real GPU where there is one: SwiftShader's software GL makes rendering, not
  // script, the frame time (and the hand drops to a few fps), which hides what posing costs.
  browser = await chromium.launch(process.platform === "darwin" && !args.includes("--swiftshader")
    ? { args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"] } : {});
  for (const entry of ["robot-arm.html", "hand.html"]) {
    results[entry] = await benchPage(browser, base, entry);
    const { gl, errors, ...scenarios } = results[entry];
    console.log(`\n${entry}  (GL: ${gl})${errors.length ? `  page errors: ${errors.join(" | ")}` : ""}`);
    for (const [name, r] of Object.entries(scenarios)) {
      console.log(`  ${name.padEnd(10)} frames ${String(r.frames).padStart(3)}  median ${String(r.medianMs).padStart(5)} ms  p95 ${String(r.p95Ms).padStart(5)} ms  max ${String(r.maxMs).padStart(5)} ms  fps ${String(r.fps).padStart(5)}  derives/frame ${r.derivesPerFrame}${r.handle ? `  (${r.handle})` : ""}`);
      for (const t of r.top ?? []) console.log(`      ${String(t.ms).padStart(7)} ms  ${t.fn}`);
    }
  }
  const json = arg("--json");
  if (json) writeFileSync(json, JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  stopServer();
}
