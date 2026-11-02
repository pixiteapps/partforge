// Headless smoke check: start a dev server, load a part app in real Chromium, and
// confirm the geometry worker actually boots (the STL export button enables once
// the first build's geometry is current) with no console/worker errors. Catches
// WASM/worker/wiring failures that a passing build and unit tests miss.
//
//   node scripts/check-app.mjs [entry.html] [--keep] [--allow-no-cutaway]
//   (entry defaults to demo.html)
//
// `--allow-no-cutaway` accepts only pages without #cutaway; a present but
// unusable cutaway control still fails.
//
// Set CHECK_PORT to run on a port other than 5179. Normal runs terminate Vite's
// detached process group before exiting. `--keep` intentionally leaves it running,
// prints its process-group ID, and makes the caller responsible for stopping it.
//
// Requires Playwright + a browser: `npm i -D playwright && npx playwright install chromium`.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const entry = process.argv.find((a, i) => i >= 2 && !a.startsWith("--")) || "demo.html";
const PORT = Number(process.env.CHECK_PORT) || 5179;
const url = `http://localhost:${PORT}/${entry}`;
const keepServer = process.argv.includes("--keep");
const allowNoCutaway = process.argv.includes("--allow-no-cutaway");
const viteBin = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));

let vite;
let viteFailure = null;
let viteState = null;
let viteLogDir;
let viteStderrPath;

const errors = [];
let booted = false;
let hovered = false;
let cutaway = false;
let cutawayControl = "missing";
let status = "(unavailable)";
let browser;
let page;

// The viewer's own WebGL canvas, told apart from the widget canvases that also
// live inside #app. A bare "#app canvas" matched exactly one element until the
// view cube shipped a permanently-attached canvas of its own; the child
// combinator excludes the cube's (nested two deep in .pf-viewcube-stack) and
// the :not() excludes annotate's lazily-created ink overlay, which is a direct
// child like this one. Ordering alone can no longer disambiguate these — the
// cube's canvas is present from boot, not created on demand.
const VIEWER_CANVAS = "#app > canvas:not(.pf-ink-canvas)";

function errorMessage(error) {
  return error?.message || String(error);
}

function startVite() {
  viteLogDir = mkdtempSync(join(tmpdir(), "partforge-check-"));
  const stdoutFd = openSync(join(viteLogDir, "vite.stdout.log"), "w");
  viteStderrPath = join(viteLogDir, "vite.stderr.log");
  const stderrFd = openSync(viteStderrPath, "w");
  try {
    vite = spawn(process.execPath, [viteBin, "--port", String(PORT), "--strictPort"], {
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  vite.on("error", (error) => { viteFailure = error; });
  vite.on("exit", (code, signal) => { viteState = { event: "exit", code, signal }; });
  vite.on("close", (code, signal) => { viteState = { event: "close", code, signal }; });
  vite.unref();
}

function boundedViteStderr() {
  if (!viteStderrPath || !existsSync(viteStderrPath)) return "";
  return readFileSync(viteStderrPath, "utf8").slice(-4000).trim().replace(/\s+/g, " ");
}

function viteStoppedMessage(prefix) {
  const state = viteState
    ? `${viteState.event} code=${viteState.code ?? "null"} signal=${viteState.signal ?? "none"}`
    : "state unavailable";
  const stderr = boundedViteStderr();
  return `${prefix} (${state})${stderr ? `: ${stderr}` : ""}`;
}

async function waitForVite() {
  for (let i = 0; i < 80; i++) {
    if (viteFailure) throw viteFailure;
    if (viteState) throw new Error(viteStoppedMessage("dev server stopped before startup"));
    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(250) });
    } catch {
      // Connection failures are expected while Vite is starting.
    }
    if (response?.ok) {
      // Give the process a brief chance to report strict-port failures; a
      // different server already occupying PORT can otherwise look ready.
      await sleep(250);
      if (viteState) throw new Error(viteStoppedMessage("dev server stopped before startup"));
      return;
    }
    await sleep(250);
  }
  const stderr = boundedViteStderr();
  throw new Error(`dev server did not start${stderr ? `: ${stderr}` : ""}`);
}

function viteGroupIsRunning() {
  if (!vite?.pid) return false;
  try {
    process.kill(-vite.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function stopVite() {
  if (!viteGroupIsRunning()) return;
  process.kill(-vite.pid, "SIGTERM");
  for (let i = 0; i < 40; i++) {
    if (!viteGroupIsRunning()) return;
    await sleep(50);
  }
  process.kill(-vite.pid, "SIGKILL");
  for (let i = 0; i < 20; i++) {
    if (!viteGroupIsRunning()) return;
    await sleep(50);
  }
  throw new Error(`Vite process group ${vite.pid} did not stop`);
}

async function checkCompactLayout(width) {
  await page.setViewportSize({ width, height: 720 });
  await sleep(50);
  const result = await page.evaluate(() => {
    const viewbar = document.getElementById("viewbar");
    const topbar = document.getElementById("topbar");
    const panel = document.getElementById("panel");
    const stage = document.getElementById("app");
    const viewRect = viewbar?.getBoundingClientRect();
    const stageRect = stage?.getBoundingClientRect();
    const intersects = (element) => {
      const rect = element?.getBoundingClientRect();
      return Boolean(viewRect && rect
        && viewRect.left < rect.right
        && viewRect.right > rect.left
        && viewRect.top < rect.bottom
        && viewRect.bottom > rect.top);
    };
    const overlappingChrome = [
      ["#topbar", topbar],
      ["#panel", panel],
    ].filter(([, element]) => intersects(element)).map(([name]) => name);
    const overflowingActions = [...document.querySelectorAll("#viewbar .pf-cutaway-actions button")]
      .filter((button) => button.scrollWidth > button.clientWidth)
      .map((button) => button.textContent?.trim() || "(unlabelled)");
    // #viewbar is a floating pill anchored to the stage's right edge
    // (bottom: 12px; right: 12px). At narrow widths a wide pill (extra
    // buttons, cutaway's Flip/Reset) can overflow the stage's LEFT edge and
    // get clipped by .pf-shell { overflow: hidden } — nothing previously
    // asserted horizontal containment.
    const containment = viewRect && stageRect
      ? { left: viewRect.left - stageRect.left, right: stageRect.right - viewRect.right }
      : null;
    return { overlappingChrome, overflowingActions, containment };
  });
  for (const target of result.overlappingChrome) {
    errors.push(`layout ${width}px: #viewbar overlaps ${target}`);
  }
  if (result.overflowingActions.length) {
    errors.push(`layout ${width}px: cutaway actions overflow (${result.overflowingActions.join(", ")})`);
  }
  if (result.containment && result.containment.left < -0.5) {
    errors.push(`layout ${width}px: #viewbar overflows the stage's left edge by ${Math.round(-result.containment.left)}px`);
  }
}

// Wide-layout geometry: the rail is a full-height right edge and the viewer
// column owns its floating chrome. checkCompactLayout only runs below the 720px
// breakpoint, where the rail is stacked, so it can't see any of this.
async function checkRailLayout(width) {
  await page.setViewportSize({ width, height: 720 });
  await sleep(50);
  const result = await page.evaluate(() => {
    const panel = document.getElementById("panel");
    const app = document.getElementById("app");
    const viewbar = document.getElementById("viewbar");
    if (!panel || !app) return { problems: ["missing #panel or #app"] };
    const rail = panel.getBoundingClientRect();
    const stage = app.getBoundingClientRect();
    const bar = viewbar?.getBoundingClientRect();
    const problems = [];
    if (Math.abs(rail.right - window.innerWidth) > 1) problems.push("rail is not flush to the right edge");
    if (Math.abs(rail.height - window.innerHeight) > 1) problems.push(`rail height ${Math.round(rail.height)} != viewport ${window.innerHeight}`);
    if (Math.abs(rail.left - stage.right) > 1) problems.push("rail does not sit flush against the viewer column");
    if (rail.width < 200) problems.push(`rail collapsed unexpectedly (${Math.round(rail.width)}px)`);
    if (bar && bar.right > stage.right + 1) problems.push("#viewbar escapes the viewer column");
    if (bar && bar.bottom > stage.bottom + 1) problems.push("#viewbar escapes the viewer column vertically");

    // Section divider: hiding the first section via relevance must not leave a
    // stray hairline under the rail header (see src/framework/app.css .section rule).
    const sections = [...document.querySelectorAll("#controls .section")];
    if (sections.length >= 2) {
      // Natural-state check first, with nothing mutated yet: this is what makes
      // the guard non-vacuous, since with only two sections the post-hide check
      // below always leaves exactly one visible section (no "following section"
      // to inspect). Only meaningful when the first two sections both start
      // visible; skip it otherwise rather than special-casing a hidden second.
      const firstHidden = sections[0].classList.contains("section-hidden");
      const secondHidden = sections[1].classList.contains("section-hidden");
      if (!firstHidden && !secondHidden) {
        if (getComputedStyle(sections[0]).borderTopWidth !== "0px") {
          problems.push("first section has a stray top divider in its natural state");
        }
        if (getComputedStyle(sections[1]).borderTopWidth === "0px") {
          problems.push("second section has no divider in its natural state - divider rule not in effect");
        }
      }

      if (!firstHidden) sections[0].classList.add("section-hidden");
      const secondVisible = sections.find((s) => s !== sections[0] && !s.classList.contains("section-hidden"));
      if (secondVisible && getComputedStyle(secondVisible).borderTopWidth !== "0px") {
        problems.push("first visible section after the DOM-first one keeps its divider after relevance hid it");
      }
      if (!firstHidden) sections[0].classList.remove("section-hidden");
    }

    return { problems };
  });
  for (const problem of result.problems) errors.push(`rail layout ${width}px: ${problem}`);

  // Drag the seam across the viewer and assert the rail followed. Pointer
  // capture is what makes this work; without it the pointer reaches the canvas
  // and the drag dies. happy-dom cannot model this, so it is proven here.
  const seam = await page.$(".pf-rail-seam");
  if (!seam) {
    errors.push(`rail layout ${width}px: no .pf-rail-seam to drag`);
    await resetRail();
    return;
  }
  await settleRail(); // the viewport change above may have re-clamped the width
  const box = await seam.boundingBox();
  const before = await page.evaluate(() => document.getElementById("panel").getBoundingClientRect().width);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 80, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await sleep(200);
  const after = await page.evaluate(() => document.getElementById("panel").getBoundingClientRect().width);
  if (after <= before + 40) {
    errors.push(`rail layout ${width}px: drag did not widen the rail (${Math.round(before)} -> ${Math.round(after)})`);
  }
  await resetRail();
}

// The bar's placement lands one or more FRAMES after a resize —
// animation-controls.js applies it from a ResizeObserver via
// requestAnimationFrame — so a wall-clock wait before measuring is a race, and
// on a slow runner it loses: the measurement then describes the PREVIOUS
// width's placement. That reads as nonsense ("off stage-centre with room to
// spare", because the inline `left` pinned for a narrow stage is still on the
// bar at 1600px), which is worse than a plain failure. Wait in frames instead,
// the same machine-speed-independent approach as the capture baseline below:
// let the bar's own geometry hold still, with a floor of a few frames so a rect
// that has not been touched YET can't pass as one that has settled.
async function settleAnimBar() {
  await page.evaluate(() => new Promise((resolve) => {
    const bar = document.querySelector(".pf-anim-bar");
    if (!bar) return resolve();
    let last = "", stable = 0, frames = 0;
    const tick = () => {
      const r = bar.getBoundingClientRect();
      const key = `${Math.round(r.left)}:${Math.round(r.width)}`;
      stable = key === last ? stable + 1 : 0;
      last = key;
      frames++;
      // 240 frames is a bail-out, not an expectation: something is wrong if the
      // bar never holds still, and the assertions should report that, not hang.
      if ((frames >= 6 && stable >= 3) || frames > 240) return resolve();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
}

// The animation transport bar (.pf-anim-bar) floats centered on the stage's
// bottom edge while #viewbar floats bottom-right in the same band —
// animation-controls.js clamps the bar left of the viewbar with a 10px gap
// and app.css floors its height at the viewbar's (see
// docs/superpowers/specs/2026-08-07-animation-bar-layout-design.md). Headless
// unit tests stub every rect, so the rendered invariants are asserted here:
// no overlap, the gap, the 12px left margin, the height floor, centered when
// roomy — and, at least once across the widths, that the clamp actually
// engaged (all-roomy widths would make this check prove nothing).
async function checkAnimBarLayout(widths) {
  // VISIBILITY, not existence: the bar is always in the DOM now and is hidden
  // (display:none) on a view with no animations, so a count() gate would size a
  // 0x0 element and report bogus "0px tall" errors on such a view.
  if (!await page.locator(".pf-anim-bar").isVisible()) return;
  // Measure a still bar: a moving playhead keeps re-running the placement
  // observer, so widths sampled mid-playback can straddle a reflow.
  await pauseTransportIfPlaying();
  let sawSqueeze = false;
  for (const width of widths) {
    await page.setViewportSize({ width, height: 720 });
    await settleAnimBar();
    const result = await page.evaluate(() => {
      const bar = document.querySelector(".pf-anim-bar");
      const stage = document.getElementById("app");
      const viewbar = document.getElementById("viewbar");
      if (!bar || !stage || !viewbar) return null;
      const b = bar.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      const v = viewbar.getBoundingClientRect();
      const verticalHit = b.top < v.bottom && b.bottom > v.top;
      return {
        verticalHit,
        gap: v.left - b.right,
        leftMargin: b.left - s.left,
        barHeight: b.height,
        viewbarHeight: v.height,
        centerOffset: (b.left + b.right) / 2 - (s.left + s.right) / 2,
        // from measured widths, would the CSS-centered position collide?
        // the +1 requires a >=1px margin before demanding a slide, so a
        // future geometry colliding by less than the -0.5 tolerance below
        // isn't held to sliding by an imperceptible amount.
        wouldCollideCentered: verticalHit && (s.width + b.width) / 2 > (v.left - s.left) - 10 + 1,
      };
    });
    if (!result) { errors.push(`anim bar ${width}px: missing .pf-anim-bar, #app, or #viewbar`); continue; }
    if (result.barHeight < result.viewbarHeight - 0.5) {
      errors.push(`anim bar ${width}px: bar is ${result.barHeight}px tall, shorter than #viewbar's ${result.viewbarHeight}px`);
    }
    if (!result.verticalHit) continue; // narrow layout lifts the bar above the viewbar
    if (result.gap < 9.5) {
      errors.push(`anim bar ${width}px: gap to #viewbar is ${Math.round(result.gap)}px, expected ≥ 10`);
    }
    if (result.leftMargin < 11.5) {
      errors.push(`anim bar ${width}px: bar sits ${Math.round(result.leftMargin)}px from the stage's left edge, expected ≥ 12`);
    }
    if (result.wouldCollideCentered) {
      sawSqueeze = true;
      if (result.centerOffset > -0.5) {
        errors.push(`anim bar ${width}px: centered placement would overlap #viewbar but the bar did not slide left`);
      }
    } else if (Math.abs(result.centerOffset) > 1) {
      errors.push(`anim bar ${width}px: bar is ${Math.round(result.centerOffset)}px off stage-centre with room to spare`);
    }
  }
  if (!sawSqueeze) {
    errors.push("anim bar: no tested width squeezed the bar — use a narrower width so the clamp path is exercised");
  }
}

// checkAnimBarLayout above sizes and places the BAR; this sizes the controls
// inside it. They were authored at mouse scale — a 13px glyph in 2px/4px of
// padding is ~20x20, 8px apart. Measured on a 390px stage: a tap 12px off the
// pause button's centre, ordinary finger error, hit the bar's background and
// did nothing; a little further hit a ‹ › pager, which SWITCHES ANIMATION.
// Hence a size floor, and a separation floor so the enlarged targets cannot
// overlap into one another — a wrong action is worse than a dead one.
//
// Only pages declaring animations grow a bar, so this is a no-op elsewhere.
const TAP_TARGET_MIN = 44; // iOS HIG minimum (Material asks 48; 44 is the floor)
async function checkTransportTargets(width) {
  await page.setViewportSize({ width, height: 720 });
  await sleep(50);
  const result = await page.evaluate(async (min) => {
    const bar = document.querySelector(".pf-anim-bar");
    // Same visibility-not-existence rule as checkAnimBarLayout: a display:none
    // bar has no client rects, and measuring its 0x0 targets proves nothing.
    if (!bar || !bar.getClientRects().length) return null; // no animations on this view
    const problems = [];
    // Measure under EVERY animation, not just the selected one: the ⓘ info
    // button only renders for animations with a description, so a single-shot
    // measurement can miss the most crowded row.
    const pick = bar.querySelector(".pf-anim-pick");
    const names = pick ? [...pick.options].map((o) => o.value) : [null];
    for (const name of names) {
      if (name != null) {
        pick.value = name;
        pick.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((r) => requestAnimationFrame(r));
      }
      measure(name);
      checkBubbleClearsBar(name);
    }
    return { problems };

    // The chapter bubble floats ABOVE the bar while the user scrubs — and on a
    // stepped animation that is the exact moment the whole transport matters.
    // The bar wraps into rows at these widths, so "above the timeline" and
    // "above the bar" stopped being the same place; assert the revealed bubble
    // never covers the bar's controls.
    function checkBubbleClearsBar(name) {
      const where = name ? `[${name}] ` : "";
      const wrap = bar.querySelector(".pf-anim-scrub-wrap");
      const w = wrap.getBoundingClientRect();
      wrap.dispatchEvent(new PointerEvent("pointermove", {
        clientX: w.left + w.width / 2, bubbles: true,
      }));
      const bubble = document.querySelector(".pf-anim-chapter.pf-show");
      if (bubble) {
        const b = bubble.getBoundingClientRect();
        const barRect = bar.getBoundingClientRect();
        if (b.bottom > barRect.top + 0.5) {
          problems.push(`${where}the chapter bubble overlaps the bar (bubble bottom ${Math.round(b.bottom)}, bar top ${Math.round(barRect.top)})`);
        }
      }
      wrap.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true }));
    }

    function measure(name) {
      const where = name ? `[${name}] ` : "";
      const boxes = [];
      // Measure the range INPUT, not its wrap: the wrap is inert, so height
      // on the wrap alone leaves a native-height input as the real target and
      // taps in the wrap's slack dead.
      for (const el of bar.querySelectorAll("button, .pf-anim-scrub, select")) {
        if (el.hidden || el.offsetParent === null) continue;
        const r = el.getBoundingClientRect();
        boxes.push({ name: el.className || el.tagName, r });
        // The scrubber is a track, not a target: it has to be TALL enough to
        // grab and wide enough to aim along, so its width is checked apart.
        const wide = el.classList.contains("pf-anim-scrub") ? 120 : min;
        if (r.width + 0.5 < wide || r.height + 0.5 < min) {
          problems.push(`${where}${el.className || el.tagName} is ${Math.round(r.width)}x${Math.round(r.height)}, below ${wide}x${min}`);
        }
      }
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i].r, b = boxes[j].r;
          if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) {
            problems.push(`${where}${boxes[i].name} overlaps ${boxes[j].name}`);
          }
        }
      }
      const stage = document.querySelector(".pf-stage")?.getBoundingClientRect();
      const barRect = bar.getBoundingClientRect();
      if (stage && (barRect.left < stage.left - 0.5 || barRect.right > stage.right + 0.5)) {
        problems.push(`${where}the bar escapes the stage horizontally`);
      }
      if (stage && barRect.top < stage.top - 0.5) {
        problems.push(`${where}the bar is taller than the stage`);
      }
    }
  }, TAP_TARGET_MIN);
  if (!result) return;
  for (const problem of result.problems) errors.push(`transport ${width}px: ${problem}`);
}

// The rail's width is a 150ms CSS transition (chrome.css .pf-rail), and a
// transition starts at the first style recalc AFTER the token changes — not when
// it changes. On the CI runner the viewer's software-GL renders can starve the
// main thread of frames, so a reset's commit (--pf-rail-w back to 288px) can sit
// un-rendered until the NEXT probe's own getBoundingClientRect forces the recalc:
// that read then starts the transition and returns the OLD width. The seam has
// no transition and already sits at the new edge, so the drag that follows lands
// 80px out from the new edge — which was the old width to the pixel, and read as
// "did not widen (374 -> 374)" on filleted-box.html. A wall-clock sleep cannot
// close that gap; waiting in frames does: let the rail hold still at the width
// its token says, with the same floor settleAnimBar uses so an untouched rect
// cannot pass as a settled one. The token is 0 where the rail reserves no width
// (narrow, overlay), so only a positive token is held to the drawn width.
async function settleRail() {
  await page.evaluate(() => new Promise((resolve) => {
    const panel = document.getElementById("panel");
    if (!panel) return resolve();
    let last = -1, stable = 0, frames = 0;
    const tick = () => {
      const w = panel.getBoundingClientRect().width;
      const token = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--pf-rail-w"));
      const atToken = !(token > 0) || Math.abs(w - token) <= 1;
      stable = atToken && Math.abs(w - last) <= 0.5 ? stable + 1 : 0;
      last = w;
      frames++;
      if ((frames >= 6 && stable >= 3) || frames > 240) return resolve();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
}

// Reset through the rail's own API — a dblclick on the seam routes through
// rail.js's commit(), which resets to the 288px default — so the DOM and
// rail.js's in-memory `state` agree. The old approach (clear localStorage,
// poke --pf-rail-w directly) left `state` holding the dragged width, so the
// next setViewportSize fired a resize -> apply() that overwrote the inline
// value right back to the stale width; later checks then ran against a
// widened rail even though the property and storage both looked "clean".
//
// Uses a real page.mouse.dblclick() rather than a synthetic dblclick event
// dispatched in page.evaluate: onPointerDown calls e.preventDefault() on the
// seam's pointerdown, and only a genuine click sequence (pointerdown, up,
// click, pointerdown, up, click, dblclick) exercises that path — a dispatched
// MouseEvent("dblclick") skips straight to the last event and never touches it.
async function resetRail() {
  const seam = await page.$(".pf-rail-seam");
  if (!seam) return; // nothing to reset — the caller already recorded the missing-seam error
  const box = await seam.boundingBox();
  if (!box) return;
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await settleRail();
}

// Narrow-layout pane tabs: below RAIL_NARROW_BREAKPOINT (720px) the shell shows
// exactly ONE pane, full height, chosen by .pf-tabbar (mobile-tabs.js writes
// data-pf-pane onto .pf-shell) — and #rail-toggle hides itself because the tab
// bar replaces it. This is pure CSS cascade, invisible to happy-dom (the vitest
// suite never loads chrome.css/app.css), which is exactly how this branch's two
// bugs escaped: .pf-tabbar's unconditional `display: none` declared after the
// media query that reveals it (the bar was invisible at every width), and
// #viewbar button's author-origin `display: flex` beating the UA's
// `[hidden] { display: none }` (rail.js's `toggle.hidden = true` left
// #rail-toggle fully visible below the breakpoint). Both are fixed; this check
// is what would have caught them.
//
// #rail-toggle floats on its own at the stage's top right since 2026-08-20, so
// the rule it now needs is `.pf-float-rail-toggle[hidden]` in app.css rather
// than `#viewbar button[hidden]` — the trap is identical (a centring
// `display: flex` outranking the UA sheet) and this check is still the only
// thing that sees it, since the vitest suite loads no CSS.
//
// What this does NOT cover: this whole script runs Chromium headless, and
// headless Chromium does not throttle rendering the way a headed browser
// does for hidden content. Measured directly: a `visibility: hidden`
// sandboxed iframe kept delivering requestAnimationFrame callbacks under
// headless (180 in the sample window; `display: none` delivered a full
// count too in one configuration), while headed Chromium delivered zero for
// `visibility: hidden`. So a bug where hiding an element starves its rAF
// loop — as happened to partforge-cloud's viewer iframe and its
// build-screenshot capture — would pass this check even if reintroduced
// here. Catching that class needs a headed run.
async function checkNarrowPaneTabs(narrowWidth, wideWidth) {
  const displays = async () => page.evaluate(() => {
    const display = (selector) => {
      const el = document.querySelector(selector);
      return el ? getComputedStyle(el).display : "(missing)";
    };
    // Geometry, not just `display`. A tab bar can be display:flex and still be
    // invisible: if the stage refuses to shrink (it needs min-height: 0, since
    // the narrow shell is a column and the canvas carries a real pixel height),
    // the bar is pushed past the bottom of the viewport. That shipped once, and
    // a display-only assertion waved it through in both engines.
    const bar = document.querySelector(".pf-tabbar");
    const rect = bar ? bar.getBoundingClientRect() : null;
    return {
      tabbar: display(".pf-tabbar"),
      railToggle: display("#rail-toggle"),
      stage: display(".pf-stage"),
      rail: display(".pf-rail"),
      barOnScreen: rect ? rect.top < window.innerHeight && rect.bottom > 0 && rect.height > 0 : false,
      barBottom: rect ? Math.round(rect.bottom) : null,
      viewportH: window.innerHeight,
      overflowY: document.documentElement.scrollHeight - window.innerHeight,
    };
  });

  await page.setViewportSize({ width: narrowWidth, height: 720 });
  await sleep(50);
  let result = await displays();
  if (result.tabbar !== "flex") {
    errors.push(`pane tabs ${narrowWidth}px: .pf-tabbar display is ${result.tabbar}, expected flex`);
  }
  if (!result.barOnScreen) {
    errors.push(`pane tabs ${narrowWidth}px: .pf-tabbar is laid out off-screen (bottom ${result.barBottom} vs viewport ${result.viewportH}) — it is display:${result.tabbar} but not visible`);
  }
  if (result.overflowY > 0) {
    errors.push(`pane tabs ${narrowWidth}px: the shell overflows the viewport by ${result.overflowY}px — a pane is refusing to shrink`);
  }
  if (result.railToggle !== "none") {
    errors.push(`pane tabs ${narrowWidth}px: #rail-toggle display is ${result.railToggle}, expected none`);
  }
  if (result.stage === "none") {
    errors.push(`pane tabs ${narrowWidth}px: .pf-stage is hidden with data-pf-pane at its default`);
  }
  if (result.rail !== "none") {
    errors.push(`pane tabs ${narrowWidth}px: .pf-rail display is ${result.rail}, expected none with data-pf-pane at its default`);
  }

  // Switch panes the way a phone user would: tap the tab bar's Controls button.
  const railTab = page.locator('[data-pf-pane-tab="rail"]');
  if (await railTab.count()) {
    await railTab.click();
    await sleep(50);
    result = await displays();
    if (result.rail === "none") {
      errors.push(`pane tabs ${narrowWidth}px: .pf-rail is still hidden after switching to the Controls tab`);
    }
    if (result.stage !== "none") {
      errors.push(`pane tabs ${narrowWidth}px: .pf-stage display is ${result.stage} after switching to the Controls tab, expected none`);
    }
    // Switch back to the stage tab so no state leaks into a later check that
    // reuses this narrow width (checkCompactLayout runs at widths below the
    // same breakpoint).
    const stageTab = page.locator('[data-pf-pane-tab="stage"]');
    if (await stageTab.count()) {
      await stageTab.click();
      await sleep(50);
    }
  } else {
    errors.push(`pane tabs ${narrowWidth}px: no [data-pf-pane-tab="rail"] button to click`);
  }

  await page.setViewportSize({ width: wideWidth, height: 720 });
  await sleep(50);
  result = await displays();
  if (result.tabbar !== "none") {
    errors.push(`pane tabs ${wideWidth}px: .pf-tabbar display is ${result.tabbar}, expected none above the breakpoint`);
  }
  if (result.railToggle === "none") {
    errors.push(`pane tabs ${wideWidth}px: #rail-toggle is hidden above the breakpoint`);
  }
  if (result.stage === "none" || result.rail === "none") {
    errors.push(`pane tabs ${wideWidth}px: stage and rail are not both visible above the breakpoint (stage=${result.stage}, rail=${result.rail})`);
  }
}

// Idle pages are static since the turntable's removal, but an `autoplay`
// animation (e.g. hinged-box's looping "cycle") may be running on this page —
// pause it the same way a person would, same trick the removed turntable
// #pause button used to need. Idempotent: once paused the glyph is ▶ and this
// is a harmless no-op, so callers that both precede and follow a given check
// can call it freely.
async function pauseTransportIfPlaying() {
  const animPlayButton = page.locator(".pf-anim-play");
  if (await animPlayButton.count() && await animPlayButton.textContent() === "⏸") {
    await animPlayButton.click();
  }
}

// Showcase capture (runtime.captureCurrent): a page that stashes its mount handle
// on window.__pfRuntime (demo.html does) gets the capture exercised the way an
// embedder would. Asserts the real-GL properties the faked-renderer unit tests
// cannot: the JPEG comes back at the requested long-edge size with the live
// viewport's aspect, and the visible canvas is pixel-identical afterwards (render
// target, lights, and grid all restored). Pages without the handle are skipped.
async function checkCaptureCurrent() {
  if (!await page.evaluate(() => Boolean(window.__pfRuntime?.captureCurrent))) return;
  // A looping canvas never satisfies the identical-screenshots baseline below
  // — the cutaway check already paused the transport before its own baseline
  // screenshot, so this is normally a no-op; kept here too in case this is
  // reached without the cutaway check having run.
  await pauseTransportIfPlaying();
  // The idle canvas is static now (no turntable), but any residual
  // OrbitControls damping from the setup above (e.g. the cutaway check) still
  // needs to settle — so on a slow software-GL runner (CI) a wall-clock sleep
  // under-waits and the residual sub-pixel drift keeps accumulating between
  // the baseline and after-capture screenshots. Wait the decay out in frames
  // (machine-speed independent), then still demand consecutive identical
  // screenshots before trusting the baseline.
  await page.evaluate(() => new Promise((resolve) => {
    let n = 0;
    const tick = () => (++n >= 120 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }));
  let before = await page.locator(VIEWER_CANVAS).screenshot();
  let stable = false;
  for (let i = 0; i < 15 && !stable; i++) {
    await sleep(200);
    const next = await page.locator(VIEWER_CANVAS).screenshot();
    stable = before.equals(next);
    before = next;
  }
  if (!stable) { errors.push("captureCurrent: canvas never stabilized for a baseline"); return; }
  const result = await page.evaluate(async (sel) => {
    const dataUrl = window.__pfRuntime.captureCurrent({ size: 512 });
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/jpeg")) {
      return { ok: false, why: `unexpected return value: ${String(dataUrl).slice(0, 40)}` };
    }
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = dataUrl; });
    const canvas = document.querySelector(sel);
    return {
      ok: true,
      width: img.naturalWidth,
      height: img.naturalHeight,
      canvasW: canvas.clientWidth,
      canvasH: canvas.clientHeight,
    };
  }, VIEWER_CANVAS);
  if (!result.ok) { errors.push(`captureCurrent: ${result.why}`); return; }
  if (Math.max(result.width, result.height) !== 512) {
    errors.push(`captureCurrent: long edge ${Math.max(result.width, result.height)} != requested 512`);
  }
  const wantAspect = result.canvasW / result.canvasH;
  const gotAspect = result.width / result.height;
  if (Math.abs(gotAspect - wantAspect) > 0.02) {
    errors.push(`captureCurrent: aspect ${gotAspect.toFixed(3)} != viewport ${wantAspect.toFixed(3)}`);
  }
  await sleep(100);
  if (!before.equals(await page.locator(VIEWER_CANVAS).screenshot())) {
    errors.push("captureCurrent: live canvas changed after an offscreen capture");
  }
}

// Cutaway section caps are stencil-masked, and a WebGLRenderTarget does not get
// a stencil buffer unless it asks for one — so an offscreen capture taken with
// cutaway enabled used to come back with each cap flooding its ENTIRE plane with
// hatch, burying the part, while the live canvas stayed perfect. Nothing threw;
// only the captured pixels were wrong, which is exactly what the faked-renderer
// unit tests cannot see (they have no GL state, let alone a stencil buffer).
//
// Measure how much of the frame the hatch covers. Hatch is a fine stripe pattern,
// so sampling pairs of pixels a few px apart and counting big luminance jumps
// gives its area; a masked cap marks only the cross-section, an unmasked one
// marks a whole quad. Measured on demo.html at the default framing: 0.8% with
// cutaway off, 7.9% masked (correct), 32.0% unmasked (the bug). The threshold
// sits between the latter two — retune it here if a page with a much larger
// cross-section ever stashes a runtime handle.
async function checkCutawayCapture() {
  if (!cutaway) return; // no cutaway on this page — nothing to assert
  if (!await page.evaluate(() => Boolean(window.__pfRuntime?.captureCurrent))) return;
  const result = await page.evaluate(async () => {
    const dataUrl = window.__pfRuntime.captureCurrent({ size: 512 });
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/jpeg")) {
      return { ok: false, why: `unexpected return value: ${String(dataUrl).slice(0, 40)}` };
    }
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = dataUrl; });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const luma = (x, y) => {
      const i = (y * canvas.width + x) * 4;
      return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    };
    const STRIDE = 3, EDGE = 18;
    let hatched = 0, sampled = 0;
    for (let y = 0; y < canvas.height; y += 2) {
      for (let x = 0; x + STRIDE < canvas.width; x += 2) {
        sampled++;
        if (Math.abs(luma(x, y) - luma(x + STRIDE, y)) > EDGE) hatched++;
      }
    }
    return { ok: true, coverage: hatched / sampled };
  });
  if (!result.ok) { errors.push(`cutaway capture: ${result.why}`); return; }
  const MAX_HATCH_COVERAGE = 0.18;
  if (result.coverage > MAX_HATCH_COVERAGE) {
    errors.push(
      `cutaway capture: section hatch covers ${(result.coverage * 100).toFixed(1)}% of the frame `
      + `(limit ${(MAX_HATCH_COVERAGE * 100).toFixed(0)}%) — caps are rendering unmasked, `
      + "which means the offscreen render target has no stencil buffer",
    );
  }
}

// The ?debug cache overlay (#pf-debug) is fixed-position dev chrome, wholly
// separate from the app's own layout. It has been chased around the window's
// corners more than once, silently colliding with #topbar's floating tabs or
// #viewbar each time (see docs/superpowers/sdd/debug-overlay-fix.md) with
// nothing catching it. This is a small dedicated check rather than folding
// ?debug into the main page load above: the overlay only matters at a couple
// of widths, and reusing the already-booted page would mean re-navigating
// (query strings can't be toggled in place) partway through the other checks.
async function checkDebugOverlay(widths) {
  await page.goto(`${url}?debug`, { waitUntil: "load", timeout: 30000 });
  await page.waitForSelector("#pf-debug", { timeout: 10000 });
  for (const width of widths) {
    await page.setViewportSize({ width, height: 720 });
    await sleep(50);
    const result = await page.evaluate(() => {
      const rectOf = (id) => document.getElementById(id)?.getBoundingClientRect();
      const intersects = (a, b) =>
        Boolean(a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);
      const overlay = rectOf("pf-debug");
      return {
        hasOverlay: Boolean(overlay),
        overlapsTopbar: intersects(overlay, rectOf("topbar")),
        overlapsViewbar: intersects(overlay, rectOf("viewbar")),
      };
    });
    if (!result.hasOverlay) errors.push(`debug overlay ${width}px: #pf-debug missing`);
    if (result.overlapsTopbar) errors.push(`debug overlay ${width}px: #pf-debug overlaps #topbar`);
    if (result.overlapsViewbar) errors.push(`debug overlay ${width}px: #pf-debug overlaps #viewbar`);
  }
}

try {
  startVite();
  await waitForVite();

  browser = await chromium.launch();
  page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + errorMessage(e)));
  page.on("worker", (w) => w.on("console", (m) => { if (m.type() === "error") errors.push("worker: " + m.text()); }));

  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  // The STL button enables exactly when the first build's geometry is current
  // (mount's setExportEnabled) — the status line no longer carries a triangle
  // count to wait on (that readout moved to console.debug).
  await page.waitForFunction(
    () => document.getElementById("download")?.disabled === false,
    { timeout: 60000 }
  );
  booted = true;

  // Hover inspection: move the mouse across the canvas and expect the feature
  // tooltip to appear (any hit — labeled features or the sub-part fallback).
  // A sparse model (a robot arm's thin links) leaves most fixed points over the
  // background, and a posable part's pose dots and rings claim the hover (rightly
  // hiding the tooltip) where they sit, so the sweep walks a 9 x 9 grid over the
  // middle of the canvas, nearest the centre first, until one point shows a tooltip.
  const box = await page.locator(VIEWER_CANVAS).boundingBox();
  if (box) {
    const grid = [];
    for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) grid.push([0.15 + (0.7 * i) / 8, 0.15 + (0.7 * j) / 8]);
    grid.sort((a, b) => Math.hypot(a[0] - 0.5, a[1] - 0.5) - Math.hypot(b[0] - 0.5, b[1] - 0.5));
    for (const [fx, fy] of grid) {
      await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
      await sleep(120);
      if (await page.locator(".pf-hover-tip.show:not(.pf-tooltip-anchored)").count()) { hovered = true; break; }
    }
  }

  const cutawayButton = page.locator("#cutaway");
  let frameBeforeCutaway;
  if (await cutawayButton.count()) {
    cutawayControl = await cutawayButton.isDisabled() ? "disabled" : "ready";
    if (cutawayControl === "ready") {
      // Idle pages are static now (no turntable), but an `autoplay` animation
      // may be running — pause the transport before the baseline screenshot,
      // or a looping canvas makes the "did the canvas change" comparison
      // below vacuous (it would already be changing every frame regardless
      // of cutaway). This sleep is just cheap insurance against any
      // remaining in-flight damping settling.
      await pauseTransportIfPlaying();
      await sleep(250);
      frameBeforeCutaway = await page.locator(VIEWER_CANVAS).screenshot();
      await cutawayButton.click();
      cutaway = await cutawayButton.getAttribute("aria-pressed") === "true";
      cutawayControl = cutaway ? "enabled" : "not pressed";
      await sleep(200);
      if (cutaway && frameBeforeCutaway.equals(await page.locator(VIEWER_CANVAS).screenshot())) {
        errors.push("render: canvas did not change after cutaway was enabled");
      }
    }
  }

  {
    const viewport = page.viewportSize();
    await checkRailLayout(1280);
    await checkRailLayout(1024);
    if (cutaway) {
      await checkCompactLayout(601);
      await checkCompactLayout(390);
      await checkCompactLayout(320);
    }
    await checkNarrowPaneTabs(400, 1024);
    await checkAnimBarLayout([1600, 1280, 1024]);
    await checkTransportTargets(390); // a phone in portrait
    await checkTransportTargets(320); // the narrowest phone still supported
    if (viewport) await page.setViewportSize(viewport);
  }
  await checkCaptureCurrent(); // before checkDebugOverlay — that one navigates away
  await checkCutawayCapture(); // cutaway is still enabled from the toggle above

  // Annotate's actions row (Undo/Clear/Send) is the widest of the viewbar's
  // three contextual rows — see app.css's 430px/360px shrink rules — so its
  // containment is worth its own pass through checkCompactLayout, mirroring
  // the cutaway pass above. Only apps that wire onAnnotationSend show #annotate
  // (demo.html does); other apps skip this block entirely. Run only after the
  // canvas-screenshot checks above: opening annotate lazily creates an overlay
  // <canvas> (.pf-ink-canvas) inside #app — VIEWER_CANVAS already excludes it
  // by class, so this ordering is no longer load-bearing for those checks, but
  // it's kept so this block doesn't have to reason about ink on top of the
  // view cube's own permanently-attached canvas (present since boot, on every
  // app — the reason VIEWER_CANVAS exists at all). Isolated from cutaway
  // (toggled off first, restored after): the two are independent toggles, and
  // running both open at once would show two contextual action rows stacked in
  // the same pill — a real but separate overflow case from the one this fix's
  // arithmetic covers.
  const annotateButton = page.locator("#annotate");
  if (await annotateButton.count() && !(await annotateButton.isDisabled())) {
    const cutawayWasOn = cutaway && await cutawayButton.getAttribute("aria-pressed") === "true";
    if (cutawayWasOn) await cutawayButton.click();
    await annotateButton.click();
    const annotateOpen = (await annotateButton.getAttribute("aria-pressed")) === "true";
    if (annotateOpen) {
      const viewport = page.viewportSize();
      await checkCompactLayout(601);
      await checkCompactLayout(390);
      await checkCompactLayout(320);
      // Restore a normal-width viewport before closing.
      if (viewport) await page.setViewportSize(viewport);
      // Can't just click #annotate again: while sketch mode owns the
      // top-centre toolbar, mount.js hides the WHOLE #viewbar (see app.css's
      // "Sketch-mode toolbar" comment) so the pencil toggle is unreachable.
      // Exit the way a real user does: the toolbar's own close button
      // (sketch-toolbar.js's always-present, never-disabled last button —
      // the in-UI exit affordance for exactly this reason). Fall back to the
      // __pfRuntime handle captureCurrent already relies on above only if
      // that click somehow doesn't close the mode; #viewbar (and #annotate
      // within it) reappears once setEnabled(false) restores it either way.
      await page.locator('.pf-sketch-toolbar [data-action="close"]').click();
      if ((await annotateButton.getAttribute("aria-pressed")) === "true") {
        await page.evaluate(() => window.__pfRuntime?.annotate?.setEnabled(false));
      }
    }
    if (cutawayWasOn) await cutawayButton.click(); // restore cutaway's prior state
  }

  // 390px is below the 720px stacked-layout breakpoint; 850px sits in the
  // narrower-but-still-side-by-side range where the tabs and a corner overlay
  // are most likely to collide (see the debug-overlay-fix report).
  await checkDebugOverlay([390, 850]);
  if (viteState) throw new Error(viteStoppedMessage("dev server stopped during smoke check"));
} catch (error) {
  errors.push("check: " + errorMessage(error));
} finally {
  if (page) {
    try {
      status = await page.$eval("#status", (element) => element.textContent);
    } catch (error) {
      errors.push("status: " + errorMessage(error));
      status = "(no #status)";
    }
  }
  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      errors.push("cleanup: " + errorMessage(error));
    }
  }
  if (!keepServer && vite) {
    try {
      await stopVite();
    } catch (error) {
      errors.push("cleanup: " + errorMessage(error));
    }
  }
  if (viteLogDir) {
    try {
      rmSync(viteLogDir, { recursive: true, force: true });
    } catch (error) {
      errors.push("cleanup: " + errorMessage(error));
    }
  }
}

console.log(`check ${url}`);
console.log(`  booted: ${booted}   hovered: ${hovered}   cutaway: ${cutaway}   status: ${JSON.stringify(status)}   errors: ${errors.length}`);
if (!cutaway) console.log(`  cutaway control: ${cutawayControl}`);
if (keepServer && vite?.pid) console.log(`  vite: kept running (pid ${vite.pid})`);
for (const e of errors.slice(0, 10)) console.log("    - " + e.split("\n")[0]);
const cutawaySatisfied = cutaway || (allowNoCutaway && cutawayControl === "missing");
process.exit(booted && hovered && cutawaySatisfied && errors.length === 0 ? 0 : 1);
