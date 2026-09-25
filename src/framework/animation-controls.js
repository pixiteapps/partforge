// Transport bar + playback driver for part-declared animations. The bar is
// framework-generated DOM appended to the stage (no host markup needed, like
// the debug overlay); the driver ticks the pure playback state machine
// (animation.js) from the viewer's frame loop and routes every param write
// through the mount-supplied applyValues hook — the same path as a slider
// edit, minus the regen debounce. Returns null when NO view declares a
// (valid) animation, so mount can wire it unconditionally.
//
// Animations belong to a VIEW: the bar shows the active view's set and hides
// itself in a view that declares none, and every view switch resets the
// outgoing animation first (see viewChanged). The host owns which view is
// active — getView() is the driver's only window onto it.
import { viewAnimations, createPlayback, stepIndexAt } from "./animation.js";
import { createInfoPopover, attachInfo } from "./controls.js";
import { stageClearFor } from "./stage-clear.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function setBtnLabel(b, label) {
  b.setAttribute("aria-label", label);
  b.title = label;
}
function btn(className, text, label) {
  const b = el("button", className, text);
  b.type = "button";
  setBtnLabel(b, label);
  return b;
}

// Where the transport bar may sit, given the stage width, the bar's natural
// width, and the viewbar's left edge (all px, viewbarLeft stage-relative).
// null → the CSS default (centered) already clears the viewbar. Otherwise
// inline overrides: `left` slides the bar toward the stage's `margin`, and
// when even that isn't enough, `maxWidth` caps the bar so the `gap` holds.
export function planAnimBarPlacement({ stageWidth, barWidth, viewbarLeft }, { gap = 10, margin = 12 } = {}) {
  const centeredLeft = (stageWidth - barWidth) / 2;
  const limit = viewbarLeft - gap - barWidth;
  if (centeredLeft <= limit) return null;
  const left = Math.max(margin, limit);
  const available = Math.max(0, viewbarLeft - gap - margin);
  return barWidth > available ? { left, maxWidth: available } : { left };
}

// A rect with no area is not a claim on the stage — it is the ABSENCE of one,
// and unioning it in would drag the union's left/top edges to 0. The concrete
// case is Sketch mode hiding the cube stack via the `hidden` property: a
// `display: none` element's getBoundingClientRect() is all zeros, which made
// the union {left: 0, top: 0} and planned the transport bar to the stage's left
// edge at max-width: 0. But a hidden ancestor is only one way to get that rect
// — an unattached element and a `content-visibility: hidden` subtree report the
// same — so the filter is on the rect's own emptiness rather than on any one
// cause of it.
const isEmptyRect = (r) => !r || r.right - r.left <= 0 || r.bottom - r.top <= 0;

// The bottom-right chrome cluster is two elements now — #viewbar with the view
// cube stacked above it — so the transport bar has to clamp against their union
// or it slides under the cube on a narrow stage. Null-tolerant because either
// element can be absent (a host that drops the viewbar; a mount before the cube
// attaches) — and empty-tolerant per the rule above, which is the same "no
// claim here" case arriving as a zero rect instead of as null.
export function unionRect(a, b) {
  if (isEmptyRect(a)) return isEmptyRect(b) ? null : b;
  if (isEmptyRect(b)) return a;
  return {
    left: Math.min(a.left, b.left),
    right: Math.max(a.right, b.right),
    top: Math.min(a.top, b.top),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

// The cluster's footprint AS IF THE CUBE WERE VISIBLE — what the CROWDING
// decision is measured against, as opposed to the measured union above, which is
// what the bar is actually PLACED against. Two rects, two purposes.
//
// Deciding "is the bar crowded?" from the measured union oscillates, because the
// cube is part of that union and hiding it is the consequence of the answer:
// cube visible → wide union → bar capped → crowded → hide the cube → its rect
// is all zeros → unionRect drops it → the bar fits → not crowded → show the cube
// → round again. Two frames per cycle, each one a ResizeObserver notification,
// on screen as a flickering cube. This rect does not depend on whether the stack
// is displayed, so the answer is a fixed point: hiding the cube cannot change
// it.
//
// The stack's edges are derived from the viewbar's because chrome.css anchors
// both to the same margin: `.pf-float-viewbar` is `bottom: 12px; right: 12px`
// and `.pf-viewcube-stack` is `right: 12px` with its bottom resting on top of
// the viewbar (`--pf-viewbar-clear` + a few px). So the stack shares the
// viewbar's right edge, reaches a published width in from it, and occupies the
// band directly above the viewbar's top. That small gap between them is
// deliberately NOT subtracted: a hair taller than the truth is the safe
// direction for a "would these two collide?" test — and this rect is therefore
// unaffected the day chrome.css retunes it (2026-08-20 took it from 8px to 3).
//
// Null/empty-tolerant on exactly unionRect's terms — a zero-area rect is the
// ABSENCE of a claim, not a claim on the stage's top-left corner:
// - no viewbar rect (a host that drops #viewbar) → nothing to anchor a nominal
//   stack on, so fall back to the cube's own measured rect; if that is empty
//   too there is nothing to decide against at all. This one fallback is
//   visibility-DEPENDENT and so not a fixed point — it is the best available
//   answer without the viewbar anchor, and it only applies to a host that has
//   removed the viewbar entirely.
// - no published size (no cube attached, or none ever measured) → the stack
//   makes no nominal claim and the viewbar's rect stands alone.
export function nominalClusterRect(viewbarRect, cubeRect, size) {
  if (isEmptyRect(viewbarRect)) return isEmptyRect(cubeRect) ? null : cubeRect;
  const width = size?.width > 0 ? size.width : 0;
  const height = size?.height > 0 ? size.height : 0;
  if (!width || !height) return viewbarRect;
  return unionRect(viewbarRect, {
    left: viewbarRect.right - width,
    right: viewbarRect.right,
    top: viewbarRect.top - height,
    bottom: viewbarRect.top,
  });
}

// The stack's own size, read from where viewcube-controls.js publishes it rather
// than measured: a hidden (display:none) stack measures all zeros, and the whole
// point of the nominal rect above is to survive that. Integer CSS px in
// data-pf-w / data-pf-h; anything missing or non-positive means "nothing
// published yet".
function publishedSize(element) {
  if (!element) return null;
  const width = Number(element.dataset.pfW);
  const height = Number(element.dataset.pfH);
  return width > 0 && height > 0 ? { width, height } : null;
}

// The scrubber's resolution: `t` is reported to the user as one of this many
// steps, and read back the same way.
export const SCRUB_STEPS = 1000;

// Snap a seek target UP onto the scrubber's grid.
//
// syncUi rounds `t` onto that grid to position the thumb, but a chapter
// boundary rarely lands on it: with three equal chapters, 1/3 rounds DOWN to
// 0.333 — which is in the chapter BEFORE the one the playhead is really in. The
// bar then reports a chapter it is not at, and the next arrow-key nudge reads
// the rounded value back and "moves" the user a chapter without the position
// changing. Rounding up keeps the grid value on the same side of the boundary
// as `t`, so the playhead and what the scrubber shows always agree.
//
// A chapter shorter than one step can't be represented at all; nothing here can
// fix that, and lint's minimum step duration keeps it out of reach.
export function snapUpToScrubGrid(t) {
  const stepped = Math.ceil(t * SCRUB_STEPS - 1e-9) / SCRUB_STEPS;
  return Math.min(1, Math.max(0, stepped));
}

// "Close enough to a chapter's start to count as being ON it." One scrubber
// step, for the same reason: finer than the grid is finer than anything the
// user can see or land on.
const AT_BOUNDARY = 1 / SCRUB_STEPS;

// Center-x for the chapter bubble, in px within the scrub wrap: the bubble
// tracks `fraction` along the timeline but never hangs past either end. A
// wrap narrower than the bubble has no legal band — park it in the middle.
export function clampBubbleX(fraction, wrapWidth, bubbleWidth) {
  if (wrapWidth <= bubbleWidth) return wrapWidth / 2;
  const half = bubbleWidth / 2;
  return Math.min(Math.max(fraction * wrapWidth, half), wrapWidth - half);
}

// A setter for an element's text that MUTATES its existing text node instead of
// replacing it. `el.textContent = x` always replaces the node, and WebKit will
// not dispatch a `click` on an element whose text node was replaced between
// mousedown and mouseup — so a label that can change while the user is pressing
// it must be written this way or the press is silently swallowed. Isolated in
// WebKit on a 120ms press: `textContent = <identical string>` loses the click,
// `node.data = <same>` never does, and neither does an attribute write.
//
// This is what makes the transport's glyph safe even when it legitimately flips
// mid-press (playback ending under the user's finger), which no amount of
// skipping redundant writes can cover.
function textSetter(element) {
  const node = element.firstChild?.nodeType === 3
    ? element.firstChild
    : element.appendChild(document.createTextNode(""));
  return (value) => { if (node.data !== value) node.data = value; };
}

export function attachAnimationControls(viewer, part, {
  container, applyValues, getParamValues, getView,
  // Called with `true` when the bar has run out of room beside the bottom-right
  // cluster and has started capping its own width (see isCrowded below), and
  // with `false` when it has not — on CHANGE only. mount uses it to stand the
  // view cube down so the bar can have the space back. Defaulted, so a host or
  // a test that does not care is unaffected.
  onCrowded = () => {},
}) {
  // A malformed animations block must degrade to "no transport bar", never a
  // crashed mount — lint reports the specifics; the viewer just goes without.
  let byView;
  try { byView = viewAnimations(part); } catch { byView = new Map(); }
  if (![...byView.values()].some((a) => a.length)) return null;

  const reducedMotion = typeof matchMedia === "function"
    && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const tweenDuration = reducedMotion ? 0 : 0.6; // reduced motion: jump cut, no sweep

  // `animations` is the ACTIVE view's set; it is re-pointed by viewChanged, and
  // is empty (with a null current/playback) in a view that declares none.
  const animsFor = (view) => byView.get(view) ?? [];
  let animations = animsFor(getView());
  let current = animations[0] ?? null;
  let playback = current ? createPlayback(current) : null;
  let snapshot = null; // tracked-param values before this animation first drove them

  // Autoplay: at most one animation PER VIEW declares it (lint-enforced), and
  // each view's own gets its kick when that view becomes active. Armed until
  // the user manually touches the transport — one touch disarms it for the
  // whole session, every view included — and never armed at all under
  // prefers-reduced-motion: self-starting motion is exactly what that setting
  // opts out of. The transport still plays everything on request.
  const autoplayFor = (view) => animsFor(view).find((a) => a.autoplay) ?? null;
  let autoplayArmed = [...byView.values()].some((set) => set.some((a) => a.autoplay)) && !reducedMotion;
  const disarmAutoplay = () => { autoplayArmed = false; };

  // --- DOM --------------------------------------------------------------------
  const bar = el("div", "pf-anim-bar");
  const info = createInfoPopover();

  // The bar's DOM is built ONCE and re-dressed per view: which of the picker,
  // the title and the pagers actually shows is syncStructure's call, because a
  // view switch can move between a one-animation set and a many-animation one.
  const pick = document.createElement("select");
  pick.className = "pf-anim-pick";
  pick.setAttribute("aria-label", "Choose animation");
  const title = el("span", "pf-anim-title", "");
  // Multi-animation views page with ‹ › at the card's outer edges — whole
  // animations only, never chapters (chapters are the bubble + PageUp/Down).
  const prevAnimBtn = btn("pf-anim-page", "‹", "Previous animation");
  const nextAnimBtn = btn("pf-anim-page", "›", "Next animation");
  bar.append(prevAnimBtn, pick, title);
  const infoSlot = el("span", "pf-anim-info");
  // Inline SVGs, not the ▶/⏸ characters: U+23F8 takes its EMOJI presentation
  // on iOS, so the pause glyph rendered as a color sticker in an otherwise
  // monochrome bar. Both glyphs are PERSISTENT children toggled by the
  // data-playing attribute (app.css) — the WebKit click-loss rule below
  // forbids replacing the button's children while a press may be down, and an
  // attribute write never eats a click.
  const playBtn = btn("pf-anim-play", null, "Play animation");
  playBtn.innerHTML =
    '<svg class="pf-anim-glyph-play" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>'
    + '<svg class="pf-anim-glyph-pause" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M7 4.5h3.4v15H7zM13.6 4.5H17v15h-3.6z"/></svg>';
  const scrubWrap = el("span", "pf-anim-scrub-wrap");
  const scrub = document.createElement("input");
  scrub.type = "range";
  scrub.min = "0"; scrub.max = String(SCRUB_STEPS); scrub.step = "1"; scrub.value = "0";
  scrub.className = "pf-anim-scrub";
  scrub.setAttribute("aria-label", "Animation position");
  scrubWrap.append(scrub);
  const resetBtn = btn("pf-anim-reset", "↺", "Reset animation");
  bar.append(infoSlot, playBtn, scrubWrap, resetBtn, nextAnimBtn);
  container.append(bar);
  // Chapter bubble: floats above the scrubber naming the chapter under the
  // pointer (hover) or playhead (scrub).
  //
  // It is a child of the STAGE, not of the bar, for the same reason the ⓘ
  // popover is a child of document.body: when the bar runs out of room it caps
  // its width and sets overflow:hidden (see applyPlacement), and anything
  // inside it is clipped — the bubble sits above the bar's content box, so it
  // was clipped away entirely in exactly the narrow layouts where a shrunken
  // timeline needs its labels most. Living on the stage puts it out of that
  // clip, and out of the placement ResizeObserver's subtree as well.
  //
  // Non-interactive and aria-hidden: the accessible chapter channel is the
  // scrubber's aria-valuetext, not this flag.
  const chapterBubble = el("span", "pf-anim-chapter");
  chapterBubble.setAttribute("aria-hidden", "true");
  container.append(chapterBubble);

  // A reveal is either HOVER-owned or TRANSIENT. A hover reveal lives until the
  // pointer leaves; a transient one (keyboard jump, scrub, touch) fades itself.
  //
  // `hoverInside` marks the pointer as the current owner, and while it is set a
  // transient reveal deliberately arms no fade — a drag fires pointermove then
  // an `input` on every step, so the transient timer would otherwise be the last
  // one set and would blank the label under a finger that never left.
  //
  // Every path that hides the bubble clears the latch too, so it can never
  // outlive the reveal it guards: an animation switch hides the bubble while the
  // pointer sits still, and a gesture the browser steals for scrolling delivers
  // pointercancel instead of pointerleave.
  const BUBBLE_FADE_MS = 1000;
  let bubbleFadeTimer = 0;
  let hoverInside = false;
  // The label's rendered width is re-measured only when the label itself
  // changes: showChapterBubble runs on every pointermove, and offsetWidth
  // forces a synchronous layout. Writing through textSetter keeps the text node
  // stable per the WebKit rule above, rather than replacing it per move.
  const setBubbleText = textSetter(chapterBubble);
  let bubbleLabel = null;
  let bubbleWidth = 0;
  function showChapterBubble(fraction, { transient = false } = {}) {
    if (!current || current.steps.length <= 1) return;
    const f = Math.min(1, Math.max(0, fraction));
    const label = current.steps[stepIndexAt(current, f)].label;
    if (label !== bubbleLabel) {
      bubbleLabel = label;
      setBubbleText(label);
      bubbleWidth = chapterBubble.offsetWidth;
    }
    // Stage-relative, because the bubble lives on the stage rather than in the
    // wrap: track the point along the timeline, then lift clear of the bar —
    // the BAR's top, not the wrap's. The touch layout wraps the bar into rows
    // with the timeline on the lower one, so "above the wrap" would sit the
    // bubble on the chooser row. checkTransportTargets pins this.
    const wrapRect = scrubWrap.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    const stageRect = container.getBoundingClientRect();
    chapterBubble.style.left =
      `${wrapRect.left - stageRect.left + clampBubbleX(f, wrapRect.width, bubbleWidth)}px`;
    chapterBubble.style.bottom = `${stageRect.bottom - barRect.top + 8}px`;
    chapterBubble.classList.add("pf-show");
    clearTimeout(bubbleFadeTimer);
    bubbleFadeTimer = 0;
    if (transient && !hoverInside) bubbleFadeTimer = setTimeout(hideChapterBubble, BUBBLE_FADE_MS);
  }
  function fadeChapterBubble() {
    if (!chapterBubble.classList.contains("pf-show")) return;
    clearTimeout(bubbleFadeTimer);
    bubbleFadeTimer = setTimeout(hideChapterBubble, BUBBLE_FADE_MS);
  }
  function hideChapterBubble() {
    clearTimeout(bubbleFadeTimer);
    bubbleFadeTimer = 0;
    hoverInside = false;
    chapterBubble.classList.remove("pf-show");
  }
  const onWrapPointerMove = (e) => {
    if (!current || current.steps.length <= 1) return; // no chapters: no bubble, and no layout read
    const rect = scrubWrap.getBoundingClientRect();
    if (!rect.width) return;
    hoverInside = true;
    showChapterBubble((e.clientX - rect.left) / rect.width);
  };
  // A touch pointer's leave arrives with the finger lift, so hiding outright
  // would blank the label the tap just asked for — and touch has no hover to
  // read it with afterwards. Let it fade like a keyboard reveal instead. A
  // mouse leaving still hides at once: the pointer moving away IS the dismissal.
  const onWrapPointerLeave = (e) => {
    hoverInside = false;
    if (e?.pointerType === "touch") fadeChapterBubble();
    else hideChapterBubble();
  };
  scrubWrap.addEventListener("pointermove", onWrapPointerMove);
  scrubWrap.addEventListener("pointerleave", onWrapPointerLeave);
  scrubWrap.addEventListener("pointercancel", onWrapPointerLeave);

  // Late-bound hook into the placement section below (a plain call would hit
  // the TDZ on its `let placementRaf` — setup invokes syncStructure before the
  // placement block runs). Wired to schedulePlacement once that block exists,
  // so a view switch that shows/hides the bar re-publishes --pf-anim-clear
  // even where ResizeObserver is absent.
  let onStructureChanged = null;

  // Sketch mode takes this slot over: the app floats its own composer where the
  // bar sits, and a frozen sketch over a playing animation is meaningless
  // anyway. Its own flag rather than a straight write to `display`, for the
  // reason mount.js spells out for the view cube's two hide reasons: with one
  // assignment shared between causes, whichever fires last wins, and a view
  // switch back to an animated view would reveal a bar that sketch mode still
  // wants gone.
  let hiddenForSketch = false;

  // Per-view + per-animation chrome: which chooser shows, the picker's options,
  // title, ⓘ description, pager labels, scrubber ticks. A view with no
  // animations hides the whole bar rather than showing an empty transport.
  function syncStructure() {
    bar.style.display = current && !hiddenForSketch ? "" : "none";
    onStructureChanged?.();
    hideChapterBubble();
    if (!current) return;
    const paged = animations.length > 1;
    pick.style.display = paged ? "" : "none";
    title.style.display = paged ? "none" : "";
    prevAnimBtn.style.display = paged ? "" : "none";
    nextAnimBtn.style.display = paged ? "" : "none";
    pick.replaceChildren(...animations.map((a) => {
      const o = document.createElement("option");
      o.value = a.name; o.textContent = a.label;
      return o;
    }));
    pick.value = current.name;
    title.textContent = current.label;
    if (paged) {
      // Name the destination. Activating a pager keeps focus on it and leaves
      // its glyph unchanged, so without this a screen reader re-announces the
      // same generic "Next animation" and never says what is now selected.
      const i = animations.indexOf(current);
      const at = (d) => animations[(i + d + animations.length) % animations.length].label;
      setBtnLabel(prevAnimBtn, `Previous animation: ${at(-1)}`);
      setBtnLabel(nextAnimBtn, `Next animation: ${at(1)}`);
    }
    infoSlot.replaceChildren();
    attachInfo(infoSlot, current.description ?? "", info);
    const stepped = current.steps.length > 1;
    for (const n of scrubWrap.querySelectorAll(".pf-anim-tick")) n.remove();
    if (stepped) {
      for (const t of current.stepStarts.slice(1)) {
        const tick = el("span", "pf-anim-tick");
        tick.style.left = `${t * 100}%`;
        scrubWrap.append(tick);
      }
    }
  }

  // syncUi() runs on every playback frame. Two rules keep that from eating the
  // user's clicks, and they are independent:
  //
  // 1. The play button's glyph flip is an ATTRIBUTE toggle over two persistent
  //    SVG children (app.css keys which one shows on [data-playing]) — its
  //    children are never touched after construction. This is the one that
  //    matters, because it holds even when the glyph legitimately changes
  //    under a held finger — playback ending mid-press. (The bubble's text
  //    still goes through textSetter, the text-node form of the same rule.)
  // 2. Each element has its own renderer that leaves early when its own value
  //    is unchanged, so a playing transport touches only what actually moved:
  //    the scrubber's value, and aria-valuetext when it crosses a reporting
  //    step. Per ELEMENT, not per write: driving several elements off one
  //    shared state key means a step change also redraws the button, which was
  //    still enough to lose the click before rule 1 was in place.
  //
  // Without rule 1 this cost the pause click outright: press, release, no click
  // event at all, and only ever while playing — the one moment the button is
  // for. Measured in WebKit, any press held >= 40ms lost it (a real click is
  // ~100ms; a synthetic 0ms one survives, which is why automated clicking never
  // saw it). Reset was never affected: nothing rewrites that button per frame.
  let shownActive = null;

  function renderPlayButton(active) {
    if (active === shownActive) return;
    shownActive = active;
    playBtn.toggleAttribute("data-playing", active);
    const label = active ? "Pause animation" : "Play animation";
    playBtn.setAttribute("aria-label", label);
    playBtn.title = label;
  }

  // aria-valuetext is the accessible chapter channel — the bubble is aria-hidden,
  // so this is the only place the chapter name reaches assistive tech. An
  // attribute write never eats clicks (see the WebKit note above), but a screen
  // reader announces every CHANGE, and during playback the position moves on its
  // own: an exact percentage would chatter ~100 times a run with the scrubber
  // focused. So while playing the percentage is reported in 10% steps. A
  // user-driven seek reports the exact position, which is when precision is the
  // feedback the user asked for.
  let shownValuetext = null;
  function renderValuetext(t, stepIndex, playing) {
    const pct = Math.round(t * 100);
    const shown = playing ? Math.round(pct / 10) * 10 : pct;
    const text = current.steps.length > 1
      ? `${current.steps[stepIndex].label} — ${shown}%`
      : `${shown}%`;
    if (text === shownValuetext) return;
    shownValuetext = text;
    scrub.setAttribute("aria-valuetext", text);
  }

  function syncUi() {
    if (!current) return; // a view with no animations has nothing to draw
    const { status, t, stepIndex } = playback.state();
    const playing = status === "playing" || status === "intro";
    scrub.value = String(Math.round(t * SCRUB_STEPS));
    renderPlayButton(playing);
    renderValuetext(t, stepIndex, playing);
  }

  // Belt-and-braces for the animation swap. Both caches above key on the exact
  // value written to the DOM, so today a stale one can only ever agree with what
  // is already on screen — this reset is currently redundant, and no test can
  // pin it. It is kept because the cache it replaced (the old step readout) keyed
  // on a step INDEX, which genuinely collided across animations at index 0: any
  // future renderer keyed on a proxy rather than on its rendered value needs
  // this hook to already exist.
  function invalidateUi() { shownActive = null; shownValuetext = null; }

  // --- driver -----------------------------------------------------------------
  // A frame that throws — a malformed cue or track that slipped past lint, a
  // viewer that rejects a view name — must cost that frame, not the render
  // loop: this callback runs from the viewer's frame listeners, and letting it
  // propagate would take the other listeners down with it. Warn once, then
  // stay quiet so a bad frame can't flood the console 60x a second.
  let frameFailureWarned = false;
  function warnFrameFailure(err) {
    if (frameFailureWarned) return;
    frameFailureWarned = true;
    console.warn("partforge: animation frame failed", err);
  }
  function apply(r) {
    if (!r || !current) return;
    // A playing frame always draws, whatever it changed: the viewer renders on
    // demand, and playback must never stall waiting for something to ask.
    viewer.requestRender?.();
    try {
      // Params go through applyValues (the slider path) only when the animation
      // actually drives some: an opacity-only frame must neither snapshot nor
      // write params, or it would dirty the regen loop for a display-only fade.
      // First write for this run also remembers what the user's params were, so
      // Reset can put them back.
      if (Object.keys(r.values).length) {
        if (snapshot == null) snapshot = getParamValues(current.trackedKeys);
        applyValues(r.values);
      }
      // Opacity is display-only and lives entirely in the viewer — no param, no
      // rebuild, nothing to snapshot; doReset drops the overrides wholesale.
      for (const [n, v] of Object.entries(r.opacity ?? {})) viewer.setSubPartOpacity?.(n, v);
      if (r.cue) {
        viewer.tweenCameraTo(r.cue.view, {
          duration: tweenDuration,
          // An intro cue gates playback until the tween settles; mid-timeline
          // cues overlap playback and need no completion signal.
          onComplete: r.status === "intro" ? () => guarded(() => playback.introDone()) : undefined,
        });
      }
      syncUi();
    } catch (err) {
      warnFrameFailure(err);
    }
  }

  // Every transport entry point goes through here so the STATE-MACHINE call is
  // inside the guard too, not just apply(). playback.tick() is evaluated in the
  // render loop, and three re-arms requestAnimationFrame only after the frame
  // callback returns — a throw escaping from there stops the rAF chain and
  // freezes the viewer permanently instead of costing one frame.
  function guarded(produce) {
    if (!playback) return; // active view has no animations: nothing to drive
    try { apply(produce()); } catch (err) { warnFrameFailure(err); }
  }

  function doReset() {
    playback?.reset();
    viewer.cancelCameraTween();
    viewer.clearSubPartOpacities?.();
    if (snapshot) { applyValues(snapshot); snapshot = null; }
    syncUi();
  }

  function selectAnimation(name) {
    const next = animations.find((a) => a.name === name);
    if (!next || next === current) return;
    doReset();
    current = next;
    playback = createPlayback(current);
    syncStructure();
    invalidateUi();
    syncUi();
  }

  const offFrame = viewer.onFrame((dt) => guarded(() => playback.tick(dt)));
  // User orbit: the viewer has already cancelled any cue tween (its own
  // "start" handler); disarm the remaining cues, and if an intro tween was
  // gating playback, settle the gate — cancel() never fires onComplete, so
  // without this the machine would sit in "intro" forever.
  const offOrbit = viewer.onCameraStart(() => {
    if (!playback) return;
    playback.disarmCues();
    if (playback.state().status === "intro") guarded(() => playback.introDone());
  });

  const onPlayClick = () => {
    if (!current) return;
    disarmAutoplay();
    const active = playback.state().status;
    if (active === "playing" || active === "intro") {
      viewer.cancelCameraTween();
      guarded(() => playback.pause());
    } else {
      guarded(() => playback.play());
    }
  };
  const onScrub = () => {
    if (!current) return;
    disarmAutoplay();
    const f = Number(scrub.value) / SCRUB_STEPS;
    showChapterBubble(f, { transient: true });
    guarded(() => playback.seek(f));
  };
  // PageUp/PageDown jump whole chapters — the keyboard replacement for the
  // removed step buttons. PageUp goes FORWARD, matching the key's native
  // slider direction (it increases the value). Single-step animations keep
  // the browser's native coarse seek instead.
  //
  // Targets are derived from the chapter the playhead is IN rather than by
  // scanning stepStarts for the nearest boundary — same answers (verified
  // equivalent across the whole 0..1 range), but it reads as the rule it
  // implements and allocates nothing per keypress.
  //
  // AT_BOUNDARY decides "am I at this chapter's start or inside it", which is
  // what makes PageDown step back rather than restart. It is one scrubber step
  // because that is the finest position the user can see or reach: a tolerance
  // finer than the grid would call a playhead that just landed on a boundary
  // "inside" the chapter, and PageDown would restart it forever instead of
  // walking back.
  const onScrubKeydown = (e) => {
    if (!current || current.steps.length <= 1) return;
    if (e.key !== "PageUp" && e.key !== "PageDown") return;
    e.preventDefault();
    disarmAutoplay();
    const { t } = playback.state();
    const starts = current.stepStarts;
    const i = stepIndexAt(current, t);
    const target = snapUpToScrubGrid(e.key === "PageUp"
      ? (starts[i + 1] ?? 1)
      // Inside a chapter, back up to its own start (restart it); already at the
      // start, step to the chapter before — the video-player convention.
      : (t > starts[i] + AT_BOUNDARY ? starts[i] : (starts[i - 1] ?? 0)));
    // seek() abandons a pending cue but cannot touch the viewer's camera, so an
    // in-flight tween would keep travelling to the position we just left.
    viewer.cancelCameraTween();
    showChapterBubble(target, { transient: true });
    guarded(() => playback.seek(target));
  };
  const cycleAnimation = (dir) => {
    if (!current) return;
    disarmAutoplay();
    const i = animations.indexOf(current);
    selectAnimation(animations[(i + dir + animations.length) % animations.length].name);
  };
  const onPrevAnim = () => cycleAnimation(-1);
  const onNextAnim = () => cycleAnimation(1);
  const onPick = () => { disarmAutoplay(); selectAnimation(pick.value); };
  const onResetClick = () => { disarmAutoplay(); doReset(); };
  prevAnimBtn.addEventListener("click", onPrevAnim);
  nextAnimBtn.addEventListener("click", onNextAnim);
  playBtn.addEventListener("click", onPlayClick);
  scrub.addEventListener("input", onScrub);
  scrub.addEventListener("keydown", onScrubKeydown);
  pick.addEventListener("change", onPick);
  resetBtn.addEventListener("click", onResetClick);

  syncStructure();
  syncUi();

  // --- placement: keep clear of the bottom-right cluster ---------------------
  // chrome.css centers the bar (left: 50% / translateX(-50%)), and nothing in
  // CSS can stop that centered position sliding under the bottom-right cluster
  // when the stage narrows — #viewbar's width is dynamic (cutaway's Flip/Reset
  // appear and disappear), so a static reservation would either overlap or
  // waste centre space. Measure instead: when the transport bar's vertical
  // band intersects the CLUSTER's — #viewbar unioned with the view cube stack
  // sitting above it, since that stack can be taller than the viewbar alone —
  // clamp the bar's left so a 10px gap holds, capping its width if even the
  // stage's 12px margin isn't enough. Overrides are inline and cleared at the
  // top of every pass, so chrome.css (or a host that re-anchors any of these
  // elements out of the shared band) stays authoritative the moment the
  // constraint stops binding. The clear-measure-apply sequence is loop-safe: it
  // settles within one frame, so ResizeObserver — which reports rendered sizes
  // at frame boundaries — never sees the intermediate state.
  //
  // A pass also decides whether the bar is CROWDED — out of room to the point
  // of capping its own width, which shrinks its controls below the 44px tap
  // target — and reports that through onCrowded so the cube can give way. That
  // decision is measured against the NOMINAL cluster rect, never the union used
  // for placement: see nominalClusterRect for why the difference is the whole
  // design. It is reported LAST in the pass, after the bar has been placed, so
  // the hide it may cause lands on the next frame's pass rather than
  // invalidating the rects this one just measured.
  const viewbarEl = container.querySelector("#viewbar");
  // Looked up lazily on every pass rather than captured once: the cube stack is
  // generated by viewcube-controls.js, which may attach after this bar does.
  const cubeSelector = ".pf-viewcube-stack";
  let placementRaf = 0;
  function applyPlacement() {
    placementRaf = 0;
    bar.style.left = "";
    bar.style.transform = "";
    bar.style.maxWidth = "";
    bar.style.overflow = "";
    bar.classList.remove("pf-squeezed");
    const stageRect = container.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    // Publish the bar's vertical claim on the stage as --pf-anim-clear: the
    // distance from the stage's bottom edge to the bar's top, 0px when the bar
    // is hidden — by us (a view with no animations, sketch mode: the inline
    // display) OR by a host stylesheet, which leaves our inline display alone
    // and empties the bar's box, the case stageClearFor tests. Hosts that
    // float their own chrome at the stage's bottom-centre (partforge-cloud's
    // status/forging stack) read it to sit above the bar instead of under it;
    // with no bar mounted the property is never set and a var() fallback of
    // 0px applies.
    const clear = bar.style.display === "none" ? 0 : stageClearFor(stageRect, barRect);
    container.style.setProperty("--pf-anim-clear", `${clear}px`);
    const cubeEl = container.querySelector(cubeSelector);
    const viewbarRect = viewbarEl?.getBoundingClientRect() ?? null;
    const cubeRect = cubeEl?.getBoundingClientRect() ?? null;
    // Every measurement of the pass is taken before anything is written, and
    // the crowding verdict is one of them — it must not read rects that the
    // placement below has already moved.
    const crowded = isCrowded({ stageRect, barRect, viewbarRect, cubeRect, cubeEl });
    placeBar(stageRect, barRect, unionRect(viewbarRect, cubeRect));
    reportCrowded(crowded);
  }

  // Is the bar out of room? Judged against the nominal cluster rather than the
  // measured union, so that hiding the cube — which is what a `true` here causes
  // — cannot flip the answer back. `barRect.width` is the bar's NATURAL width:
  // applyPlacement clears maxWidth/overflow/pf-squeezed before measuring, and
  // getBoundingClientRect forces layout, so a previous pass's cap is never read
  // back in here.
  function isCrowded({ stageRect, barRect, viewbarRect, cubeRect, cubeEl }) {
    // A bar that is not on screen cannot be crowded by anything — the same
    // two conditions the --pf-anim-clear calculation above uses.
    if (bar.style.display === "none" || barRect.height === 0) return false;
    const nominal = nominalClusterRect(viewbarRect, cubeRect, publishedSize(cubeEl));
    // Same vertical-band test the placement path applies, against the nominal
    // rect: bands that do not intersect cannot collide, so there is nothing to
    // be crowded by.
    if (!nominal || barRect.top >= nominal.bottom || barRect.bottom <= nominal.top) return false;
    const plan = planAnimBarPlacement({
      stageWidth: stageRect.width,
      barWidth: barRect.width,
      viewbarLeft: nominal.left - stageRect.left,
    });
    // The CAP is the crowded state, not the slide: a bar that only moves
    // sideways keeps its full width and its full-size controls.
    return plan?.maxWidth != null;
  }

  let reportedCrowded = null; // null: nothing said yet, so the first pass always reports
  function reportCrowded(crowded) {
    if (crowded === reportedCrowded) return;
    reportedCrowded = crowded;
    onCrowded(crowded);
  }

  // The write half of a placement pass. `cluster` is the MEASURED union, which
  // is what lets the bar actually reclaim the space once the cube is gone.
  function placeBar(stageRect, barRect, cluster) {
    if (!cluster || barRect.top >= cluster.bottom || barRect.bottom <= cluster.top) return;
    const plan = planAnimBarPlacement({
      stageWidth: stageRect.width,
      barWidth: barRect.width,
      viewbarLeft: cluster.left - stageRect.left,
    });
    if (!plan) return;
    bar.style.left = `${plan.left}px`;
    bar.style.transform = "none";
    // maxWidth is the last resort, only reached when even the margin can't
    // hold the gap — and the bar's flex children have hard minimums that don't
    // shrink to fit a tighter cap. overflow:hidden is applied here, inline,
    // rather than as a static rule so it is scoped to the capped state and the
    // (far more common) uncapped bar never clips anything.
    //
    // Nothing that floats above the bar may live inside it, or this clips it:
    // the ⓘ popover is on document.body and the chapter bubble is on the stage,
    // both for that reason.
    if (plan.maxWidth != null) {
      bar.style.maxWidth = `${plan.maxWidth}px`;
      bar.style.overflow = "hidden";
      // Under the cap the bar sheds the pagers (~40px with their gaps). They are
      // pure convenience — the picker beside them reaches every animation — and
      // spending that width on the timeline is what keeps the scrubber
      // targetable instead of letting it collapse toward nothing.
      bar.classList.add("pf-squeezed");
    }
  }
  function schedulePlacement() {
    if (typeof requestAnimationFrame !== "function") return applyPlacement();
    if (!placementRaf) placementRaf = requestAnimationFrame(applyPlacement);
  }
  // Observing the bar itself catches content-driven width changes — the ⓘ glyph
  // appearing or disappearing when only some animations declare a description;
  // the viewbar, cutaway's actions; the stage, rail drags and window resizes.
  const placementObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(schedulePlacement) : null;
  if (placementObserver) {
    placementObserver.observe(container);
    placementObserver.observe(bar);
    if (viewbarEl) placementObserver.observe(viewbarEl);
    const cubeAtSetup = container.querySelector(cubeSelector);
    if (cubeAtSetup) placementObserver.observe(cubeAtSetup);
  }
  onStructureChanged = schedulePlacement; // see the hook's declaration above
  schedulePlacement();

  const runtime = {
    // An unknown name is a host bug, not a request to play whatever happens to
    // be selected — say so and do nothing rather than silently animating
    // something else. "Unknown" is judged against the ACTIVE view's set: an
    // animation that exists in another view is not playable from here.
    play(name) {
      disarmAutoplay();
      if (name != null && !animations.some((a) => a.name === name)) {
        console.warn(`partforge: unknown animation "${name}"`);
        return;
      }
      if (name) selectAnimation(name);
      guarded(() => playback.play());
    },
    pause() { disarmAutoplay(); viewer.cancelCameraTween(); guarded(() => playback.pause()); },
    seek(t) { disarmAutoplay(); guarded(() => playback.seek(t)); },
    stop() { disarmAutoplay(); doReset(); },
    state: () => ({
      view: getView(),
      animation: current?.name ?? null,
      ...(playback ? playback.state() : { status: "idle", t: 0, stepIndex: 0 }),
    }),
  };

  const handle = {
    runtime,
    // A user edit to any control (or a host setParams) takes over the params:
    // pause playback rather than fight over them.
    notifyUserEdit() {
      disarmAutoplay();
      viewer.cancelCameraTween();
      playback?.userEdited();
      syncUi();
    },
    // Hide/reveal for SKETCH mode only. `--pf-anim-clear` follows for free:
    // syncStructure notifies the placement pass, which derives the clearance
    // from this same `display` value and publishes 0px for a hidden bar.
    setHidden(hidden) {
      const next = hidden === true;
      if (next === hiddenForSketch) return;
      hiddenForSketch = next;
      syncStructure();
    },
    // Mount calls this from the view-tab onChange, BEFORE it refreshes the
    // view: the outgoing animation's params and opacity overrides must be
    // restored before the incoming view composes its assembly.
    viewChanged() {
      doReset();
      animations = animsFor(getView());
      current = animations[0] ?? null;
      playback = current ? createPlayback(current) : null;
      syncStructure();
      invalidateUi();
      if (current) syncUi();
    },
    // Mount calls this on first ready and on every view/tab switch — it plays
    // the ACTIVE view's autoplay animation, if that view declares one.
    autoplayKick() {
      if (!autoplayArmed) return;
      const target = autoplayFor(getView());
      if (!target) return;
      // selectAnimation resolves within the ACTIVE view's set, so a kick that
      // arrives before viewChanged has re-pointed it finds nothing to select —
      // degrade to a no-op rather than driving the outgoing view's playback.
      if (current !== target) selectAnimation(target.name);
      if (current !== target || !playback) return;
      const { status } = playback.state();
      if (status !== "playing" && status !== "intro") guarded(() => playback.play());
    },
    detach() {
      offFrame();
      offOrbit();
      viewer.clearSubPartOpacities?.();
      prevAnimBtn.removeEventListener("click", onPrevAnim);
      nextAnimBtn.removeEventListener("click", onNextAnim);
      playBtn.removeEventListener("click", onPlayClick);
      scrub.removeEventListener("input", onScrub);
      scrub.removeEventListener("keydown", onScrubKeydown);
      pick.removeEventListener("change", onPick);
      resetBtn.removeEventListener("click", onResetClick);
      info.dispose();
      placementObserver?.disconnect();
      if (placementRaf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(placementRaf);
      scrubWrap.removeEventListener("pointermove", onWrapPointerMove);
      scrubWrap.removeEventListener("pointerleave", onWrapPointerLeave);
      scrubWrap.removeEventListener("pointercancel", onWrapPointerLeave);
      hideChapterBubble(); // also clears hoverInside
      chapterBubble.remove(); // a stage child, so the bar taking itself out misses it
      container.style.removeProperty("--pf-anim-clear"); // no bar, no claim
      bar.remove();
    },
    __viewer: viewer, // test hook only
  };
  return handle;
}
