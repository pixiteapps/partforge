// @vitest-environment happy-dom
// test/framework/animation-controls.test.js
// Transport bar + driver against a fake viewer: play/pause/scrub/step wiring,
// cue → tween dispatch, intro gating, snapshot/reset, user-edit pause, and the
// runtime surface.
import { afterEach, describe, expect, it, test, vi } from "vitest";
import { attachAnimationControls, planAnimBarPlacement, clampBubbleX, snapUpToScrubGrid, unionRect, nominalClusterRect } from "../../src/framework/animation-controls.js";

function fakeViewer() {
  const frameCbs = new Set(); const orbitCbs = new Set();
  return {
    onFrame: (cb) => { frameCbs.add(cb); return () => frameCbs.delete(cb); },
    onCameraStart: (cb) => { orbitCbs.add(cb); return () => orbitCbs.delete(cb); },
    tweenCameraTo: vi.fn((view, { onComplete } = {}) => onComplete?.()), // completes instantly
    cancelCameraTween: vi.fn(),
    setSubPartOpacity: vi.fn(),
    clearSubPartOpacities: vi.fn(),
    frame: (dt) => { for (const cb of [...frameCbs]) cb(dt); },
    orbit: () => { for (const cb of [...orbitCbs]) cb(); },
  };
}

// Animations are declared PER VIEW: "box" carries both, "solo" carries none —
// which is what exercises the hide/show and reset paths of a view switch.
const part = {
  parts: {
    base: { views: ["box", "solo"], build: () => {} },
    lid: { views: ["box"], build: () => {} },
  },
  views: {
    box: {
      label: "Box",
      animations: {
        open: { label: "Open lid", camera: "front", duration: 2, easing: "linear",
          description: "Opens the **lid**.", tracks: { lidAngle: [[0, 0], [1, 110]] } },
        assemble: { label: "Assemble", steps: [
          { label: "Appear", duration: 1, easing: "linear", opacity: { lid: [[0, 0], [1, 1]] } },
          { label: "Lower", duration: 1, easing: "linear", tracks: { lidLift: [[0, 40], [1, 0]] } },
        ] },
      },
    },
    solo: { label: "Solo" },
  },
};

function setup(defn = part) {
  const container = document.createElement("div");
  document.body.append(container);
  const params = { lidAngle: 5, lidLift: 0 };
  const applied = [];
  let activeView = "box";
  const ctl = attachAnimationControls(fakeViewer(), defn, {
    container,
    applyValues: (v) => { applied.push({ ...v }); Object.assign(params, v); },
    getParamValues: (keys) => Object.fromEntries(keys.map((k) => [k, params[k]])),
    getView: () => activeView,
  });
  const switchView = (name) => { activeView = name; ctl.viewChanged(); };
  return { container, params, applied, ctl, switchView, viewer: ctl.__viewer };
}

let handles = [];
afterEach(() => { for (const h of handles.splice(0)) h?.detach(); document.body.replaceChildren(); });

test("no animations → null, no DOM", () => {
  const container = document.createElement("div");
  expect(attachAnimationControls(fakeViewer(), {}, { container, applyValues: () => {}, getParamValues: () => ({}) })).toBeNull();
  expect(container.children).toHaveLength(0);
});

test("returns null only when NO view declares animations", () => {
  const container = document.createElement("div");
  const none = { views: { v: { label: "V" } }, parts: {} };
  expect(attachAnimationControls(fakeViewer(), none, {
    container, applyValues: () => {}, getParamValues: () => ({}), getView: () => "v",
  })).toBeNull();
  expect(container.children).toHaveLength(0);
});

test("top-level animations are ignored — clean break", () => {
  const container = document.createElement("div");
  const legacy = { views: { v: { label: "V" } }, parts: {},
    animations: { open: { duration: 1, tracks: { x: [[0, 0], [1, 1]] } } } };
  expect(attachAnimationControls(fakeViewer(), legacy, {
    container, applyValues: () => {}, getParamValues: () => ({}), getView: () => "v",
  })).toBeNull();
});

test("switching to a view without animations hides the bar; back shows it", () => {
  const { container, ctl, switchView } = setup(); handles.push(ctl);
  const bar = container.querySelector(".pf-anim-bar");
  expect(bar.style.display).not.toBe("none");
  switchView("solo");
  expect(bar.style.display).toBe("none");
  expect(ctl.runtime.state()).toMatchObject({ view: "solo", animation: null });
  switchView("box");
  expect(bar.style.display).not.toBe("none");
  expect(ctl.runtime.state()).toMatchObject({ view: "box", animation: "open" });
});

test("publishes --pf-anim-clear on the stage: bar height while shown, 0px hidden, unset on detach", async () => {
  const { container, ctl, switchView } = setup();
  const bar = container.querySelector(".pf-anim-bar");
  const rect = (o) => () => ({ left: 0, right: 800, width: 800, height: 0, ...o });
  container.getBoundingClientRect = rect({ top: 0, bottom: 600, height: 600 });
  bar.getBoundingClientRect = rect({ top: 540, bottom: 580, left: 200, right: 600, width: 400, height: 40 });
  switchView("box"); // re-syncs structure, scheduling a placement pass
  await new Promise((r) => requestAnimationFrame(r));
  expect(container.style.getPropertyValue("--pf-anim-clear")).toBe("60px");

  switchView("solo"); // no animations → hidden bar claims nothing
  await new Promise((r) => requestAnimationFrame(r));
  expect(container.style.getPropertyValue("--pf-anim-clear")).toBe("0px");

  ctl.detach();
  expect(container.style.getPropertyValue("--pf-anim-clear")).toBe("");
});

test("a bar hidden by a HOST stylesheet claims 0px too — the empty box is the test, not our inline display", async () => {
  // partforge-cloud's part-open sheet hides .pf-anim-bar with a stylesheet
  // `display: none`; bar.style.display stays "" and getBoundingClientRect is
  // all zeros. Measuring that rect published `stageRect.bottom - 0` — the
  // whole stage height — and flung the host's stacked chrome off the stage.
  const { container, ctl, switchView } = setup();
  const bar = container.querySelector(".pf-anim-bar");
  const rect = (o) => () => ({ left: 0, right: 0, width: 0, height: 0, top: 0, bottom: 0, ...o });
  container.getBoundingClientRect = rect({ right: 800, width: 800, bottom: 600, height: 600 });
  bar.getBoundingClientRect = rect(); // hidden from outside: an empty box, display untouched
  switchView("box");
  await new Promise((r) => requestAnimationFrame(r));
  expect(bar.style.display).toBe(""); // the premise: nothing of ours hid it
  expect(container.style.getPropertyValue("--pf-anim-clear")).toBe("0px");
  ctl.detach();
});

test("a view switch resets: snapshot restored, opacities cleared, position zeroed", () => {
  const { applied, ctl, switchView } = setup(); handles.push(ctl);
  const viewer = ctl.__viewer;
  ctl.runtime.play();          // takes snapshot { lidAngle: 5 }
  viewer.frame(1);             // t=0.5, lidAngle 55
  switchView("solo");
  expect(applied.at(-1)).toEqual({ lidAngle: 5 });            // snapshot restored
  expect(viewer.clearSubPartOpacities).toHaveBeenCalled();
  switchView("box");
  expect(ctl.runtime.state().t).toBe(0);
});

test("opacity tracks drive viewer.setSubPartOpacity each frame", () => {
  const { container, ctl } = setup(); handles.push(ctl);
  const viewer = ctl.__viewer;
  container.querySelector(".pf-anim-pick").value = "assemble";
  container.querySelector(".pf-anim-pick").dispatchEvent(new Event("change", { bubbles: true }));
  ctl.runtime.play();
  viewer.frame(0.5); // mid step 1: lid at 0.5
  const calls = viewer.setSubPartOpacity.mock.calls;
  expect(calls.at(-1)[0]).toBe("lid");
  expect(calls.at(-1)[1]).toBeCloseTo(0.5);
});

test("reset clears opacity overrides", () => {
  const { container, ctl } = setup(); handles.push(ctl);
  const viewer = ctl.__viewer;
  container.querySelector(".pf-anim-pick").value = "assemble";
  container.querySelector(".pf-anim-pick").dispatchEvent(new Event("change", { bubbles: true }));
  // Selecting an animation resets too, so clear first — otherwise this asserts
  // the SWITCH cleared the overrides and would pass with stop() deleted.
  viewer.clearSubPartOpacities.mockClear();
  ctl.runtime.play();
  viewer.frame(0.5);
  ctl.runtime.stop();
  expect(viewer.clearSubPartOpacities).toHaveBeenCalled();
});

// The `Object.keys(r.values).length` guard in apply() exists for exactly this
// animation: a fade drives the display and nothing else, so it must neither
// take a param snapshot nor call applyValues — either would push a rebuild
// through the regen loop once per frame for a change no rebuild can see.
// (The shared fixture's "assemble" cannot pin this: its second step declares a
// `lidLift` track, and evaluateTrack holds that track's boundary value at every
// t, so even its opacity-only step reports a non-empty `values`.)
const fadePart = {
  parts: { lid: { views: ["box"], build: () => {} } },
  views: {
    box: {
      label: "Box",
      animations: {
        fade: { label: "Fade in", duration: 2, easing: "linear", opacity: { lid: [[0, 0], [1, 1]] } },
      },
    },
  },
};

test("an opacity-only animation drives the viewer without touching params", () => {
  const { applied, ctl } = setup(fadePart); handles.push(ctl);
  const viewer = ctl.__viewer;
  ctl.runtime.play();
  viewer.frame(0.5); // t = 0.25
  viewer.frame(0.5); // t = 0.5
  expect(applied).toHaveLength(0); // applyValues never called: nothing to regen
  const calls = viewer.setSubPartOpacity.mock.calls.filter((c) => c[0] === "lid");
  expect(calls.at(-1)[1]).toBeCloseTo(0.5); // ...but the fade itself is driven
  // And no snapshot was taken, so Reset has no params to write back either.
  ctl.runtime.stop();
  expect(applied).toHaveLength(0);
});

test("runtime.play resolves names in the ACTIVE view only", () => {
  const { ctl, switchView } = setup(); handles.push(ctl);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  switchView("solo");
  ctl.runtime.play("open"); // exists in "box", not here
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown animation"));
  expect(ctl.runtime.state().status).toBe("idle");
  warn.mockRestore();
});

test("renders the bar with a picker (two animations) and an info glyph", () => {
  const { container, ctl } = setup(); handles.push(ctl);
  expect(container.querySelector(".pf-anim-bar")).toBeTruthy();
  expect(container.querySelector(".pf-anim-pick")).toBeTruthy();
  expect(container.querySelector(".pf-anim-bar .info")).toBeTruthy(); // description glyph
});

test("play runs the intro tween, then frames drive param values", () => {
  const { applied, ctl } = setup(); handles.push(ctl);
  const viewer = ctl.__viewer;
  ctl.runtime.play();
  expect(viewer.tweenCameraTo).toHaveBeenCalledWith("front", expect.anything());
  viewer.frame(1); // 1s of 2s → t=0.5 → lidAngle 55
  expect(applied.at(-1).lidAngle).toBeCloseTo(55);
});

test("a camera cue never asks for a refit — it means 'look from here', not 'refit'", () => {
  // The view cube's clicks pass `{ refit: true }` to tweenCameraTo (see
  // viewer.js). A cue must not: under orthographic that re-derives the frustum,
  // which would resize the part under the user partway through an animation.
  const { ctl } = setup(); handles.push(ctl);
  const viewer = ctl.__viewer;
  ctl.runtime.play();
  expect(viewer.tweenCameraTo).toHaveBeenCalled();
  for (const [, options] of viewer.tweenCameraTo.mock.calls) {
    expect(options?.refit).toBeUndefined();
  }
});

test("reset restores the pre-animation param snapshot", () => {
  const { applied, ctl } = setup(); handles.push(ctl);
  ctl.runtime.play();
  ctl.__viewer.frame(1);
  ctl.runtime.stop();
  expect(applied.at(-1)).toEqual({ lidAngle: 5 }); // the snapshot taken at play
});

test("user orbit disarms cues; user edit pauses", () => {
  const { ctl } = setup(); handles.push(ctl);
  const viewer = ctl.__viewer;
  ctl.runtime.play();
  viewer.orbit();
  ctl.notifyUserEdit();
  expect(ctl.runtime.state().status).toBe("paused");
});

test("scrubbing applies values without moving the camera", () => {
  const { container, applied, ctl } = setup(); handles.push(ctl);
  const viewer = ctl.__viewer;
  const scrub = container.querySelector(".pf-anim-scrub");
  scrub.value = "500";
  scrub.dispatchEvent(new Event("input", { bubbles: true }));
  expect(applied.at(-1).lidAngle).toBeCloseTo(55);
  expect(viewer.tweenCameraTo).not.toHaveBeenCalled();
});

test("stepped animation shows ticks but no step label or step buttons", () => {
  const { container, ctl } = setup(); handles.push(ctl);
  container.querySelector(".pf-anim-pick").value = "assemble";
  container.querySelector(".pf-anim-pick").dispatchEvent(new Event("change", { bubbles: true }));
  expect(container.querySelector(".pf-anim-step")).toBeNull();
  expect(container.querySelector(".pf-anim-step-btn")).toBeNull();
  expect(container.querySelectorAll(".pf-anim-tick")).toHaveLength(1); // one interior boundary
});

// The bar caps its own width and sets overflow:hidden when it runs out of room
// (see the placement test below), so anything floating ABOVE it that lives
// INSIDE it is clipped away — which is what happened to the bubble in exactly
// the narrow layouts that need it. It belongs to the stage instead, like the
// ⓘ popover belongs to document.body.
test("the chapter bubble lives on the stage, outside the bar the cap clips", () => {
  const { container, ctl } = setup(); handles.push(ctl);
  const bar = container.querySelector(".pf-anim-bar");
  const bubble = container.querySelector(".pf-anim-chapter");
  expect(bubble).toBeTruthy();
  expect(bar.contains(bubble)).toBe(false);
  expect(bubble.parentElement).toBe(container);
  // ...and it still leaves with the rest of the chrome, since the bar removing
  // itself no longer takes the bubble with it.
  ctl.detach();
  expect(container.querySelector(".pf-anim-chapter")).toBeNull();
});

test("chapter bubble follows hover over the scrubber and names the chapter", () => {
  const { container, ctl } = setup(); handles.push(ctl);
  container.querySelector(".pf-anim-pick").value = "assemble";
  container.querySelector(".pf-anim-pick").dispatchEvent(new Event("change", { bubbles: true }));
  const wrap = container.querySelector(".pf-anim-scrub-wrap");
  wrap.getBoundingClientRect = () => ({ left: 0, right: 220, top: 0, bottom: 14, width: 220, height: 14 });
  const bubble = container.querySelector(".pf-anim-chapter");
  expect(bubble.classList.contains("pf-show")).toBe(false);
  // assemble: steps Appear (0..0.5) and Lower (0.5..1). Hover at 25% → Appear.
  wrap.dispatchEvent(new PointerEvent("pointermove", { clientX: 55, bubbles: true }));
  expect(bubble.classList.contains("pf-show")).toBe(true);
  expect(bubble.textContent).toBe("Appear");
  // Hover at 75% → Lower.
  wrap.dispatchEvent(new PointerEvent("pointermove", { clientX: 165, bubbles: true }));
  expect(bubble.textContent).toBe("Lower");
  wrap.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true }));
  expect(bubble.classList.contains("pf-show")).toBe(false);
});

test("a drag's transient scrub reveal does not steal the bubble from an in-progress hover", () => {
  vi.useFakeTimers();
  try {
    const { container, ctl } = setup(); handles.push(ctl);
    container.querySelector(".pf-anim-pick").value = "assemble";
    container.querySelector(".pf-anim-pick").dispatchEvent(new Event("change", { bubbles: true }));
    const wrap = container.querySelector(".pf-anim-scrub-wrap");
    wrap.getBoundingClientRect = () => ({ left: 0, right: 220, top: 0, bottom: 14, width: 220, height: 14 });
    const scrub = container.querySelector(".pf-anim-scrub");
    const bubble = container.querySelector(".pf-anim-chapter");

    // A drag: pointermove (hover claims the bubble) then the scrub `input` that
    // follows it on every step — the same order a real mouse/touch drag fires.
    wrap.dispatchEvent(new PointerEvent("pointermove", { clientX: 55, bubbles: true }));
    scrub.value = "250";
    scrub.dispatchEvent(new Event("input", { bubbles: true }));
    expect(bubble.classList.contains("pf-show")).toBe(true);

    // The transient reveal must not have armed a fade: the pointer still owns
    // the bubble, so holding the thumb still past 1s must not hide it.
    vi.advanceTimersByTime(1100);
    expect(bubble.classList.contains("pf-show")).toBe(true);

    // Only pointerleave ends a hover-owned reveal.
    wrap.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true }));
    expect(bubble.classList.contains("pf-show")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("scrub input reveals the bubble at the playhead and it fades after the hold", () => {
  vi.useFakeTimers();
  try {
    const { container, ctl } = setup(); handles.push(ctl);
    container.querySelector(".pf-anim-pick").value = "assemble";
    container.querySelector(".pf-anim-pick").dispatchEvent(new Event("change", { bubbles: true }));
    const scrub = container.querySelector(".pf-anim-scrub");
    const bubble = container.querySelector(".pf-anim-chapter");
    scrub.value = "750";
    scrub.dispatchEvent(new Event("input", { bubbles: true }));
    expect(bubble.classList.contains("pf-show")).toBe(true);
    expect(bubble.textContent).toBe("Lower");
    vi.advanceTimersByTime(1100);
    expect(bubble.classList.contains("pf-show")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

// A touch "leave" arrives with the finger lift, so hiding outright would blank
// the label the tap just asked for — and touch has no hover to read it with.
test("a touch pointer leaving fades the bubble instead of blanking it", () => {
  vi.useFakeTimers();
  try {
    const { container, ctl } = setup(); handles.push(ctl);
    container.querySelector(".pf-anim-pick").value = "assemble";
    container.querySelector(".pf-anim-pick").dispatchEvent(new Event("change", { bubbles: true }));
    const wrap = container.querySelector(".pf-anim-scrub-wrap");
    wrap.getBoundingClientRect = () => ({ left: 0, right: 220, top: 0, bottom: 14, width: 220, height: 14 });
    const bubble = container.querySelector(".pf-anim-chapter");

    wrap.dispatchEvent(new PointerEvent("pointermove", { clientX: 165, pointerType: "touch", bubbles: true }));
    expect(bubble.textContent).toBe("Lower");
    wrap.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "touch", bubbles: true }));
    expect(bubble.classList.contains("pf-show")).toBe(true);   // still readable
    vi.advanceTimersByTime(1100);
    expect(bubble.classList.contains("pf-show")).toBe(false);  // then fades itself

    // A mouse leave still dismisses at once — the pointer moving away IS the
    // dismissal, and there is a cursor to re-hover with.
    wrap.dispatchEvent(new PointerEvent("pointermove", { clientX: 165, pointerType: "mouse", bubbles: true }));
    wrap.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse", bubbles: true }));
    expect(bubble.classList.contains("pf-show")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

// The hover latch suppresses transient fades; if it outlived the reveal it
// guards, a later keyboard reveal would arm no fade and stick forever.
test("the hover latch never outlives the bubble it guards", () => {
  vi.useFakeTimers();
  try {
    const { container, ctl } = setup(); handles.push(ctl);
    const pick = container.querySelector(".pf-anim-pick");
    pick.value = "assemble"; pick.dispatchEvent(new Event("change", { bubbles: true }));
    const wrap = container.querySelector(".pf-anim-scrub-wrap");
    wrap.getBoundingClientRect = () => ({ left: 0, right: 220, top: 0, bottom: 14, width: 220, height: 14 });
    const scrub = container.querySelector(".pf-anim-scrub");
    const bubble = container.querySelector(".pf-anim-chapter");

    // Hover claims the bubble, then an animation switch hides it out from under
    // the still-parked pointer (a host-driven select, or autoplay on a view
    // change). The latch has to clear with it.
    wrap.dispatchEvent(new PointerEvent("pointermove", { clientX: 55, bubbles: true }));
    expect(bubble.classList.contains("pf-show")).toBe(true);
    pick.value = "open"; pick.dispatchEvent(new Event("change", { bubbles: true }));
    pick.value = "assemble"; pick.dispatchEvent(new Event("change", { bubbles: true }));

    // A transient reveal now must fade on its own.
    scrub.value = "750";
    scrub.dispatchEvent(new Event("input", { bubbles: true }));
    expect(bubble.classList.contains("pf-show")).toBe(true);
    vi.advanceTimersByTime(1100);
    expect(bubble.classList.contains("pf-show")).toBe(false);

    // pointercancel (a gesture the browser steals for scrolling) releases it too.
    wrap.dispatchEvent(new PointerEvent("pointermove", { clientX: 55, bubbles: true }));
    wrap.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));
    scrub.value = "250";
    scrub.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(1100);
    expect(bubble.classList.contains("pf-show")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("single-step animation never shows a bubble", () => {
  const { container, ctl } = setup(); handles.push(ctl); // default animation "open" has one step
  const wrap = container.querySelector(".pf-anim-scrub-wrap");
  wrap.getBoundingClientRect = () => ({ left: 0, right: 220, top: 0, bottom: 14, width: 220, height: 14 });
  wrap.dispatchEvent(new PointerEvent("pointermove", { clientX: 110, bubbles: true }));
  expect(container.querySelector(".pf-anim-chapter").classList.contains("pf-show")).toBe(false);
});

// --- clampBubbleX: pure center-x clamp --------------------------------------
test("clampBubbleX centers, clamps at both ends, and degrades on a too-narrow wrap", () => {
  expect(clampBubbleX(0.5, 220, 60)).toBe(110);   // free middle
  expect(clampBubbleX(0, 220, 60)).toBe(30);      // clamped at the left end
  expect(clampBubbleX(1, 220, 60)).toBe(190);     // clamped at the right end
  expect(clampBubbleX(0.9, 220, 60)).toBe(190);   // clamp engages before the end
  expect(clampBubbleX(0.5, 40, 60)).toBe(20);     // bubble wider than wrap → center it
});

test("runtime.play(name) switches animation; detach removes the bar", () => {
  const { container, ctl } = setup(); handles.push(ctl);
  ctl.runtime.play("assemble");
  expect(ctl.runtime.state().animation).toBe("assemble");
  ctl.detach();
  expect(container.querySelector(".pf-anim-bar")).toBeNull();
});

// deferred-tween viewer: unlike fakeViewer() above, tweenCameraTo does NOT
// fire onComplete synchronously — it's captured so the test controls when
// (or whether) the tween settles. This is what exposes the "orbit during a
// gated intro" bug: with an instantly-completing tween, introDone() always
// fires on its own and the gate never has a chance to strand playback.
function deferredFakeViewer() {
  const frameCbs = new Set(); const orbitCbs = new Set();
  let pendingComplete = null;
  return {
    onFrame: (cb) => { frameCbs.add(cb); return () => frameCbs.delete(cb); },
    onCameraStart: (cb) => { orbitCbs.add(cb); return () => orbitCbs.delete(cb); },
    tweenCameraTo: vi.fn((view, { onComplete } = {}) => { pendingComplete = onComplete ?? null; }),
    // Models the real camera-tween: cancel() DROPS onComplete rather than firing
    // it. A stub that keeps the callback alive hides every bug where something
    // cancels a gating tween and nothing ever settles the gate.
    cancelCameraTween: vi.fn(() => { pendingComplete = null; }),
    suppressAutoRotate: vi.fn(),
    frame: (dt) => { for (const cb of [...frameCbs]) cb(dt); },
    orbit: () => { for (const cb of [...orbitCbs]) cb(); },
    settle: () => { const c = pendingComplete; pendingComplete = null; c?.(); },
    get pendingComplete() { return pendingComplete; },
  };
}

test("orbit during a gated intro settles the gate instead of stranding playback", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const frameCbs = new Set(); const orbitCbs = new Set();
  let _pendingComplete = null;
  const viewer = {
    onFrame: (cb) => { frameCbs.add(cb); return () => frameCbs.delete(cb); },
    onCameraStart: (cb) => { orbitCbs.add(cb); return () => orbitCbs.delete(cb); },
    tweenCameraTo: vi.fn((view, { onComplete } = {}) => { _pendingComplete = onComplete ?? null; }),
    cancelCameraTween: vi.fn(),
  };
  const applied = [];
  const ctl = attachAnimationControls(viewer, part, {
    container,
    applyValues: (v) => applied.push({ ...v }),
    getParamValues: () => ({ lidAngle: 5 }),
    getView: () => "box",
  });
  handles.push(ctl);
  ctl.runtime.play(); // "open" has a t=0 cue → status "intro", params hold
  expect(ctl.runtime.state().status).toBe("intro");
  const before = applied.length;
  for (const cb of [...frameCbs]) cb(0.5); // gated: tick() is null, nothing applied
  expect(applied.length).toBe(before);
  for (const cb of [...orbitCbs]) cb(); // user grabs the orbit mid-intro
  expect(ctl.runtime.state().status).toBe("playing"); // gate settled
  for (const cb of [...frameCbs]) cb(1); // 1s of 2s → t=0.5 → lidAngle 55
  expect(applied.at(-1).lidAngle).toBeCloseTo(55);
});

// An unknown name is a host bug: playing "whatever is currently selected"
// instead would be a silent wrong answer.
test("runtime.play(unknown) warns and plays nothing", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { applied, ctl } = setup(); handles.push(ctl);

  ctl.runtime.play("nope");

  expect(warn).toHaveBeenCalledWith('partforge: unknown animation "nope"');
  expect(ctl.runtime.state().status).toBe("idle");
  expect(ctl.runtime.state().animation).toBe("open"); // selection untouched
  expect(applied).toHaveLength(0);
  warn.mockRestore();
});

// The driver runs from the viewer's frame listeners: a bad frame must cost that
// frame, not every other listener on the loop.
test("a throwing applyValues degrades the frame instead of killing the loop", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const container = document.createElement("div");
  document.body.append(container);
  const viewer = fakeViewer();
  const ctl = attachAnimationControls(viewer, part, {
    container,
    applyValues: () => { throw new Error("bad track"); },
    getParamValues: () => ({ lidAngle: 5 }),
    getView: () => "box",
  });
  handles.push(ctl);

  expect(() => ctl.runtime.play()).not.toThrow();
  expect(() => viewer.frame(0.5)).not.toThrow();
  expect(() => viewer.frame(0.5)).not.toThrow();

  expect(warn).toHaveBeenCalledWith("partforge: animation frame failed", expect.any(Error));
  expect(warn.mock.calls.filter((c) => c[0] === "partforge: animation frame failed")).toHaveLength(1); // warned once, not per frame
  warn.mockRestore();
});

test("orbit while idle changes nothing", () => {
  const { applied, ctl, viewer } = (() => {
    const container = document.createElement("div");
    document.body.append(container);
    const params = { lidAngle: 5, lidLift: 0 };
    const applied = [];
    const v = deferredFakeViewer();
    const ctl = attachAnimationControls(v, part, {
      container,
      applyValues: (val) => { applied.push({ ...val }); Object.assign(params, val); },
      getParamValues: (keys) => Object.fromEntries(keys.map((k) => [k, params[k]])),
      getView: () => "box",
    });
    return { applied, ctl, viewer: v };
  })();
  handles.push(ctl);
  expect(ctl.runtime.state().status).toBe("idle");
  viewer.orbit();
  expect(ctl.runtime.state().status).toBe("idle");
  expect(applied.length).toBe(0);
});

const autoPart = {
  views: {
    box: {
      label: "Box",
      animations: {
        open: part.views.box.animations.open,
        cycle: { label: "Cycle", duration: 2, loop: true, easing: "linear", autoplay: true,
          tracks: { lidAngle: [[0, 0], [0.5, 110], [1, 0]] } },
      },
    },
    // A SECOND view with an autoplay animation of its own: autoplayFor() has to
    // resolve against the ACTIVE view, not against whichever view happened to be
    // first. Hardcoding it to the first view left the whole suite green.
    // `drift` is declared FIRST and does NOT autoplay, so viewChanged's default
    // selection lands on it — reaching `spin` can only be autoplayFor's doing.
    solo: {
      label: "Solo",
      animations: {
        drift: { label: "Drift", duration: 2, easing: "linear",
          tracks: { lidAngle: [[0, 0], [1, 20]] } },
        spin: { label: "Spin", duration: 2, easing: "linear", autoplay: true,
          tracks: { lidAngle: [[0, 0], [1, 90]] } },
      },
    },
  },
};

test("autoplayKick selects and plays the autoplay animation", () => {
  const { ctl } = setup(autoPart); handles.push(ctl);
  ctl.autoplayKick();
  expect(ctl.runtime.state()).toMatchObject({ animation: "cycle", status: "playing" }); // no cue → straight to playing
});

test("autoplayKick while already playing is a no-op; re-kick after a view switch keeps the loop running", () => {
  const { ctl } = setup(autoPart); handles.push(ctl);
  ctl.autoplayKick();
  ctl.__viewer.frame(0.5);
  const t = ctl.runtime.state().t;
  ctl.autoplayKick(); // tab switch while looping
  expect(ctl.runtime.state().status).toBe("playing");
  expect(ctl.runtime.state().t).toBeCloseTo(t); // not restarted
});

test("manual interaction disarms autoplay for the session", () => {
  const { container, ctl } = setup(autoPart); handles.push(ctl);
  ctl.autoplayKick();
  container.querySelector(".pf-anim-play").click(); // user pauses
  ctl.autoplayKick(); // next tab switch
  expect(ctl.runtime.state().status).toBe("paused"); // stayed paused
});

test("a param edit that pauses playback also disarms autoplay", () => {
  const { ctl } = setup(autoPart); handles.push(ctl);
  ctl.autoplayKick();
  ctl.notifyUserEdit();
  ctl.autoplayKick();
  expect(ctl.runtime.state().status).toBe("paused");
});

test("autoplayKick after a view switch plays THAT view's autoplay animation", () => {
  const { ctl, switchView } = setup(autoPart); handles.push(ctl);
  ctl.autoplayKick();
  expect(ctl.runtime.state()).toMatchObject({ view: "box", animation: "cycle" });

  switchView("solo"); // mount does viewChanged() first, then autoplayKick()
  expect(ctl.runtime.state().animation).toBe("drift"); // default selection, no autoplay
  ctl.autoplayKick();

  const state = ctl.runtime.state();
  expect(state).toMatchObject({ view: "solo", animation: "spin" }); // not "cycle", not "drift"
  expect(["playing", "intro"]).toContain(state.status);
});

test("no autoplay animation → autoplayKick is a harmless no-op", () => {
  const { ctl } = setup(); handles.push(ctl); // original two-animation part, no autoplay
  ctl.autoplayKick();
  expect(ctl.runtime.state().status).toBe("idle");
});

test("reset BUTTON disarms autoplay, but autoplayKick's own selectAnimation path never does", () => {
  const { container, ctl } = setup(autoPart); handles.push(ctl);
  // Kick from the non-autoplay animation: exercises selectAnimation → doReset internally.
  ctl.runtime.state(); // (read-only, must not disarm)
  ctl.autoplayKick();
  expect(ctl.runtime.state()).toMatchObject({ animation: "cycle", status: "playing" });
  // A second kick still works (the internal path did not disarm)…
  ctl.autoplayKick();
  expect(ctl.runtime.state().status).toBe("playing");
  // …but the reset BUTTON does disarm.
  container.querySelector(".pf-anim-reset").click();
  ctl.autoplayKick();
  expect(ctl.runtime.state().status).toBe("idle");
});

test("prefers-reduced-motion: autoplay never arms; manual play still works", () => {
  const spy = vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true });
  try {
    const { ctl } = setup(autoPart); handles.push(ctl);
    ctl.autoplayKick();
    expect(ctl.runtime.state().status).toBe("idle");
    ctl.runtime.play("cycle");
    expect(ctl.runtime.state().status).toBe("playing");
  } finally { spy.mockRestore(); }
});

// An intro cue gates playback until its tween settles, and pausing cancels that
// tween — which drops onComplete. If the cue were retired when the intro started,
// resuming would issue no cue at all and the camera would stay wherever the
// cancelled sweep abandoned it, for the rest of the run.
test("pausing mid-intro and resuming re-issues the camera cue", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const params = { lidAngle: 5, lidLift: 0 };
  const viewer = deferredFakeViewer();
  const ctl = attachAnimationControls(viewer, part, {
    container,
    applyValues: (val) => Object.assign(params, val),
    getParamValues: (keys) => Object.fromEntries(keys.map((k) => [k, params[k]])),
    getView: () => "box",
  });
  handles.push(ctl);

  ctl.runtime.play("open");
  expect(ctl.runtime.state().status).toBe("intro");
  expect(viewer.tweenCameraTo).toHaveBeenCalledTimes(1);

  ctl.runtime.pause(); // cancels the sweep; onComplete is dropped
  expect(ctl.runtime.state().status).toBe("paused");
  expect(viewer.pendingComplete).toBeNull();

  ctl.runtime.play();
  expect(ctl.runtime.state().status).toBe("intro");
  expect(viewer.tweenCameraTo).toHaveBeenCalledTimes(2);
  expect(viewer.tweenCameraTo.mock.calls[1][0]).toBe("front");

  // And once it does settle, playback starts and the cue is not issued again.
  viewer.settle();
  expect(ctl.runtime.state().status).toBe("playing");
  viewer.frame(0.1);
  expect(viewer.tweenCameraTo).toHaveBeenCalledTimes(2);
});

// --- planAnimBarPlacement: pure clamp math ----------------------------------
// stage-relative px in, inline-override plan out. null = the CSS default
// (centered) already clears the viewbar.

test("placement: centered when there is room", () => {
  // centeredLeft 300 ≤ limit 800−10−400 = 390
  expect(planAnimBarPlacement({ stageWidth: 1000, barWidth: 400, viewbarLeft: 800 })).toBeNull();
});

test("placement: exactly touching the gap is still centered", () => {
  // centeredLeft 300 === limit 710−10−400 = 300
  expect(planAnimBarPlacement({ stageWidth: 1000, barWidth: 400, viewbarLeft: 710 })).toBeNull();
});

test("placement: slides left to hold the 10px gap", () => {
  // centeredLeft 300 > limit 700−10−400 = 290
  expect(planAnimBarPlacement({ stageWidth: 1000, barWidth: 400, viewbarLeft: 700 }))
    .toEqual({ left: 290 });
});

test("placement: never crosses the 12px stage margin", () => {
  // limit 430−10−400 = 20 → still above margin
  expect(planAnimBarPlacement({ stageWidth: 600, barWidth: 400, viewbarLeft: 430 }))
    .toEqual({ left: 20 });
  // limit 415−10−400 = 5 → clamped to 12, and 400 > available 415−10−12 = 393 → capped
  expect(planAnimBarPlacement({ stageWidth: 600, barWidth: 400, viewbarLeft: 415 }))
    .toEqual({ left: 12, maxWidth: 393 });
});

test("placement: cap never goes negative", () => {
  // viewbar hugging the left edge: available 15−10−12 < 0 → cap at 0
  expect(planAnimBarPlacement({ stageWidth: 600, barWidth: 400, viewbarLeft: 15 }))
    .toEqual({ left: 12, maxWidth: 0 });
});

test("placement: honours custom gap and margin", () => {
  expect(planAnimBarPlacement({ stageWidth: 1000, barWidth: 400, viewbarLeft: 700 }, { gap: 20, margin: 30 }))
    .toEqual({ left: 280 });
});

// --- placement wiring: ResizeObserver → measured clamp -----------------------
// happy-dom has no layout, so rects are stubbed; the viewer-pose tests use the
// same globalThis.ResizeObserver stub pattern.

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

test("placement wiring: clamps against the viewbar, clears when roomy, disconnects on detach", async () => {
  const OriginalRO = globalThis.ResizeObserver;
  let roCallback;
  const observed = new Set();
  let disconnected = false;
  globalThis.ResizeObserver = class {
    constructor(fn) { roCallback = fn; }
    observe(el) { observed.add(el); }
    disconnect() { disconnected = true; }
  };
  try {
    const container = document.createElement("div");
    const viewbar = document.createElement("div");
    viewbar.id = "viewbar";
    container.append(viewbar);
    document.body.append(container);
    container.getBoundingClientRect = () =>
      ({ left: 0, right: 1000, top: 0, bottom: 700, width: 1000, height: 700 });
    let viewbarLeft = 800;
    viewbar.getBoundingClientRect = () =>
      ({ left: viewbarLeft, right: viewbarLeft + 190, top: 650, bottom: 694, width: 190, height: 44 });
    const ctl = attachAnimationControls(fakeViewer(), part, {
      container, applyValues: () => {}, getParamValues: () => ({}), getView: () => "box",
    });
    handles.push(ctl);
    const bar = container.querySelector(".pf-anim-bar");
    bar.getBoundingClientRect = () =>
      ({ left: 300, right: 700, top: 656, bottom: 692, width: 400, height: 36 });
    expect(observed.has(container)).toBe(true);
    expect(observed.has(bar)).toBe(true);
    expect(observed.has(viewbar)).toBe(true);

    // roomy: centeredLeft 300 ≤ limit 800−10−400 → no overrides
    roCallback(); await nextFrame();
    expect(bar.style.left).toBe("");

    // squeezed: limit 700−10−400 = 290 < centeredLeft 300 → slide left
    viewbarLeft = 700;
    roCallback(); await nextFrame();
    expect(bar.style.left).toBe("290px");
    expect(bar.style.transform).toBe("none");
    expect(bar.style.maxWidth).toBe("");
    expect(bar.style.overflow).toBe("");
    expect(bar.classList.contains("pf-squeezed")).toBe(false); // sliding is not squeezing

    // capped: even the 12px margin isn't enough (300−10−12 = 278 < barWidth
    // 400) → left pins to the margin and maxWidth caps the bar, clipping its
    // over-minimum flex children instead of spilling onto #viewbar
    viewbarLeft = 300;
    roCallback(); await nextFrame();
    expect(bar.style.left).toBe("12px");
    expect(bar.style.maxWidth).toBe("278px");
    expect(bar.style.overflow).toBe("hidden");
    // ...and the bar sheds the pagers, so their width goes to the timeline
    // rather than the timeline collapsing to keep them.
    expect(bar.classList.contains("pf-squeezed")).toBe(true);

    // roomy again → overrides cleared, chrome.css back in charge
    viewbarLeft = 800;
    roCallback(); await nextFrame();
    expect(bar.style.left).toBe("");
    expect(bar.style.transform).toBe("");
    expect(bar.style.overflow).toBe("");
    expect(bar.classList.contains("pf-squeezed")).toBe(false);

    ctl.detach();
    expect(disconnected).toBe(true);
  } finally {
    globalThis.ResizeObserver = OriginalRO;
  }
});

test("placement wiring: no-op when the bars' vertical bands do not intersect", async () => {
  const OriginalRO = globalThis.ResizeObserver;
  let roCallback;
  globalThis.ResizeObserver = class {
    constructor(fn) { roCallback = fn; }
    observe() {}
    disconnect() {}
  };
  try {
    const container = document.createElement("div");
    const viewbar = document.createElement("div");
    viewbar.id = "viewbar";
    container.append(viewbar);
    document.body.append(container);
    container.getBoundingClientRect = () =>
      ({ left: 0, right: 500, top: 0, bottom: 700, width: 500, height: 700 });
    // viewbar in the bottom band, bar lifted above it (narrow layout's bottom: 64px)
    viewbar.getBoundingClientRect = () =>
      ({ left: 100, right: 490, top: 650, bottom: 694, width: 390, height: 44 });
    const ctl = attachAnimationControls(fakeViewer(), part, {
      container, applyValues: () => {}, getParamValues: () => ({}), getView: () => "box",
    });
    handles.push(ctl);
    const bar = container.querySelector(".pf-anim-bar");
    bar.getBoundingClientRect = () =>
      ({ left: 50, right: 450, top: 600, bottom: 636, width: 400, height: 36 });
    roCallback(); await nextFrame();
    expect(bar.style.left).toBe(""); // would collide horizontally, but bands don't meet
  } finally {
    globalThis.ResizeObserver = OriginalRO;
  }
});

test("aria-valuetext announces chapter and percent", () => {
  const { container, ctl } = setup(); handles.push(ctl);
  const scrub = container.querySelector(".pf-anim-scrub");
  expect(scrub.getAttribute("aria-valuetext")).toBe("0%"); // single-step: percent only
  container.querySelector(".pf-anim-pick").value = "assemble";
  container.querySelector(".pf-anim-pick").dispatchEvent(new Event("change", { bubbles: true }));
  expect(scrub.getAttribute("aria-valuetext")).toBe("Appear — 0%");
  scrub.value = "750";
  scrub.dispatchEvent(new Event("input", { bubbles: true }));
  expect(scrub.getAttribute("aria-valuetext")).toBe("Lower — 75%");
});

test("PageUp/PageDown jump chapter boundaries; no-ops for single-step", () => {
  const { container, ctl } = setup(); handles.push(ctl);
  const scrub = container.querySelector(".pf-anim-scrub");
  container.querySelector(".pf-anim-pick").value = "assemble";
  container.querySelector(".pf-anim-pick").dispatchEvent(new Event("change", { bubbles: true }));
  // From t=0, PageUp lands on the next boundary (0.5), PageUp again on the end (1).
  scrub.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }));
  expect(ctl.runtime.state().t).toBeCloseTo(0.5);
  scrub.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }));
  expect(ctl.runtime.state().t).toBeCloseTo(1);
  // PageDown walks back.
  scrub.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true }));
  expect(ctl.runtime.state().t).toBeCloseTo(0.5);
  scrub.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true }));
  expect(ctl.runtime.state().t).toBeCloseTo(0);
  // Single-step: the key is left to the browser's native coarse seek.
  container.querySelector(".pf-anim-pick").value = "open";
  container.querySelector(".pf-anim-pick").dispatchEvent(new Event("change", { bubbles: true }));
  const ev = new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true });
  scrub.dispatchEvent(ev);
  expect(ev.defaultPrevented).toBe(false);
  expect(ctl.runtime.state().t).toBeCloseTo(0);
});

// Three EQUAL chapters, so every boundary (1/3, 2/3) falls between two steps of
// the scrubber's 1/1000 grid — the case that exposes a jump landing on a `t`
// the scrubber cannot represent.
function thirdsHarness() {
  const container = document.createElement("div");
  document.body.append(container);
  const thirds = { views: { v: { label: "V", animations: { m: { label: "M", steps: [
    { label: "A", duration: 1, easing: "linear", tracks: { lidAngle: [[0, 0], [1, 1]] } },
    { label: "B", duration: 1, easing: "linear", tracks: { lidAngle: [[0, 1], [1, 2]] } },
    { label: "C", duration: 1, easing: "linear", tracks: { lidAngle: [[0, 2], [1, 3]] } },
  ] } } } } };
  const ctl = attachAnimationControls(fakeViewer(), thirds, {
    container, applyValues: () => {}, getParamValues: () => ({ lidAngle: 0 }), getView: () => "v",
  });
  handles.push(ctl);
  const scrub = container.querySelector(".pf-anim-scrub");
  const press = (key) => scrub.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  // The chapter the bar is REPORTING, which is the thing the user perceives.
  const chapter = () => scrub.getAttribute("aria-valuetext").split(" — ")[0];
  return { ctl, scrub, press, chapter };
}

// PageDown's rule: restart the chapter you are inside, step back from the one
// you are at the top of. The 1e-6 is the at-the-boundary tolerance deciding
// which of those you are in.
test("PageDown restarts the current chapter, or steps back from its start", () => {
  const { ctl, press, chapter } = thirdsHarness();

  ctl.runtime.seek(0.8);                       // well inside C
  press("PageDown");
  expect(chapter()).toBe("C");                 // restarts C, does not leave it
  press("PageDown");
  expect(chapter()).toBe("B");                 // at C's start, so step back
  // Anything the scrubber would round onto B's start counts as being AT it,
  // not inside it — the tolerance is one step of the grid, not an epsilon.
  ctl.runtime.seek(1 / 3 + 1e-5);
  press("PageDown");
  expect(chapter()).toBe("A");
  ctl.runtime.seek(1 / 3 + 0.05);              // genuinely inside B
  press("PageDown");
  expect(chapter()).toBe("B");                 // so B restarts
  ctl.runtime.seek(0);
  press("PageDown");
  expect(ctl.runtime.state().t).toBe(0);       // nowhere left to go
});

// A jump used to land on the exact boundary (1/3), which syncUi rounds DOWN to
// 333 — a value that reads back as the PREVIOUS chapter. The bar then reported
// a chapter the playhead was not in, and any later arrow-key nudge re-derived
// `t` from that rounded value and silently moved the user a chapter.
test("a chapter jump lands where the scrubber can report it", () => {
  const { scrub, press, chapter } = thirdsHarness();

  press("PageUp");
  expect(chapter()).toBe("B");
  // The thumb's own value must agree with the playhead about the chapter...
  const shown = Number(scrub.value) / 1000;
  expect(shown).toBeGreaterThanOrEqual(1 / 3);
  expect(shown).toBeLessThan(2 / 3);
  // ...so a net-zero arrow round-trip reports the same chapter it started in.
  const nudge = (d) => {
    scrub.value = String(Number(scrub.value) + d);   // what the browser does
    scrub.dispatchEvent(new Event("input", { bubbles: true }));
  };
  nudge(-1); nudge(+1);
  expect(chapter()).toBe("B");

  press("PageUp");                                    // B → C
  expect(chapter()).toBe("C");
  nudge(-1); nudge(+1);
  expect(chapter()).toBe("C");
});

test("snapUpToScrubGrid keeps a target on its own side of a boundary", () => {
  expect(snapUpToScrubGrid(1 / 3)).toBeCloseTo(0.334, 10);   // up, not down to .333
  expect(snapUpToScrubGrid(2 / 3)).toBeCloseTo(0.667, 10);
  expect(snapUpToScrubGrid(0.5)).toBe(0.5);                  // already on the grid
  expect(snapUpToScrubGrid(0)).toBe(0);                      // and no -0
  expect(Object.is(snapUpToScrubGrid(0), -0)).toBe(false);
  expect(snapUpToScrubGrid(1)).toBe(1);                      // never past the end
  expect(snapUpToScrubGrid(1.4)).toBe(1);
});

test("a chapter jump cancels an in-flight camera tween", () => {
  const { container, ctl, viewer } = setup(); handles.push(ctl);
  container.querySelector(".pf-anim-pick").value = "assemble";
  container.querySelector(".pf-anim-pick").dispatchEvent(new Event("change", { bubbles: true }));
  const scrub = container.querySelector(".pf-anim-scrub");
  viewer.cancelCameraTween.mockClear();
  scrub.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }));
  // seek() abandons the pending cue but cannot touch the camera; without this
  // the tween keeps travelling to the position the user just left.
  expect(viewer.cancelCameraTween).toHaveBeenCalled();
});

// aria-valuetext is the only accessible chapter channel, and a screen reader
// announces every change — an exact percentage chatters ~100 times per run.
test("aria-valuetext reports coarse percent while playing, exact when seeking", () => {
  const { container, ctl, viewer } = setup(); handles.push(ctl);
  const scrub = container.querySelector(".pf-anim-scrub");
  container.querySelector(".pf-anim-play").click();     // "open", 2s, single-step
  const writes = new Set();
  for (let i = 0; i < 40; i++) { viewer.frame(0.05); writes.add(scrub.getAttribute("aria-valuetext")); }
  expect([...writes].every((v) => /^\d*0%$/.test(v))).toBe(true); // 10% steps only
  expect(writes.size).toBeLessThanOrEqual(11);

  // A user-driven seek reports the exact position — that precision is the
  // feedback they asked for.
  container.querySelector(".pf-anim-play").click();     // pause
  scrub.value = "247";
  scrub.dispatchEvent(new Event("input", { bubbles: true }));
  expect(scrub.getAttribute("aria-valuetext")).toBe("25%");
});

test("animation pager bookends the card and cycles with wrap", () => {
  const { container, ctl } = setup(); handles.push(ctl); // two animations
  const bar = container.querySelector(".pf-anim-bar");
  const pagers = bar.querySelectorAll(".pf-anim-page");
  expect(pagers).toHaveLength(2);
  expect(bar.firstElementChild).toBe(pagers[0]);
  expect(bar.lastElementChild).toBe(pagers[1]);
  // The label names the destination: activating a pager keeps focus on it and
  // leaves its glyph alone, so this is all a screen reader has to go on.
  expect(pagers[0].getAttribute("aria-label")).toBe("Previous animation: Assemble");
  expect(pagers[1].getAttribute("aria-label")).toBe("Next animation: Assemble");
  const pick = container.querySelector(".pf-anim-pick");
  pagers[1].click();                                   // open → assemble
  expect(ctl.runtime.state().animation).toBe("assemble");
  expect(pick.value).toBe("assemble");
  // ...and the labels re-point at the new destination.
  expect(pagers[1].getAttribute("aria-label")).toBe("Next animation: Open lid");
  pagers[1].click();                                   // assemble → wraps to open
  expect(ctl.runtime.state().animation).toBe("open");
  pagers[0].click();                                   // open → wraps back to assemble
  expect(ctl.runtime.state().animation).toBe("assemble");
});

// The bar's DOM is built once and re-dressed per view, so the pagers and the
// picker always exist — a single-animation view HIDES them rather than never
// having built them, and shows the plain title instead.
test("single-animation view hides the pager and the picker", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const solo = { views: { v: { label: "V", animations: { open: { label: "Open lid",
    duration: 1, easing: "linear", tracks: { lidAngle: [[0, 0], [1, 110]] } } } } } };
  const ctl = attachAnimationControls(fakeViewer(), solo, {
    container, applyValues: () => {}, getParamValues: () => ({}), getView: () => "v",
  });
  handles.push(ctl);
  const pagers = container.querySelectorAll(".pf-anim-page");
  expect(pagers).toHaveLength(2);
  expect([...pagers].every((p) => p.style.display === "none")).toBe(true);
  expect(container.querySelector(".pf-anim-pick").style.display).toBe("none");
  const title = container.querySelector(".pf-anim-title");
  expect(title.style.display).not.toBe("none");
  expect(title.textContent).toBe("Open lid");
});

describe("bottom-right cluster measurement", () => {
  // planAnimBarPlacement is pure and already covered; what this defends is that
  // the CALLER measures the union of the viewbar and the view cube stacked
  // above it. Measuring only #viewbar lets the bar slide under the cube.
  it("clamps against the union's left edge, not just the viewbar's", () => {
    const union = unionRect(
      { left: 300, right: 400, top: 560, bottom: 604 }, // #viewbar
      { left: 320, right: 400, top: 470, bottom: 552 }, // .pf-viewcube-stack
    );
    expect(union.left).toBe(300);
    expect(union.right).toBe(400);
    expect(union.top).toBe(470);
    expect(union.bottom).toBe(604);
  });

  it("returns the one rect it is given when the other is missing", () => {
    const only = { left: 300, right: 400, top: 560, bottom: 604 };
    expect(unionRect(only, null)).toEqual(only);
    expect(unionRect(null, only)).toEqual(only);
    expect(unionRect(null, null)).toBeNull();
  });

  // A zero-area rect is what getBoundingClientRect() reports for a display:none
  // element (Sketch mode hides the cube stack that way), and it must count as
  // "no claim", not as a claim on the stage's top-left corner.
  it("ignores a zero-area rect instead of unioning its zeros in", () => {
    const only = { left: 300, right: 400, top: 560, bottom: 604 };
    const zero = { left: 0, right: 0, top: 0, bottom: 0 };
    expect(unionRect(only, zero)).toEqual(only);
    expect(unionRect(zero, only)).toEqual(only);
    expect(unionRect(zero, zero)).toBeNull();
    // Degenerate on one axis only is just as empty — no pixels, no claim.
    expect(unionRect(only, { left: 0, right: 0, top: 100, bottom: 200 })).toEqual(only);
  });
});

// --- placement wiring: does applyPlacement actually measure the union? ------
// The tests above pin unionRect itself; this one pins that the CALL SITE uses
// it rather than #viewbar alone. Reuses the "clamps against the viewbar" /
// "no-op when bands don't intersect" harness above, but splits the two
// responsibilities across the two elements: the CUBE supplies the vertical
// overlap with the bar (the viewbar's own band misses it, so viewbar-only
// measurement would early-return same as the no-op case above), while the
// VIEWBAR supplies the union's left edge (it sits further left than the
// cube). That split means the asserted clamp is reachable only by unioning
// both rects — a hypothetical implementation that measured the cube alone
// would see no overlap-driven need to reach past it, and one that measured
// the viewbar alone would never trigger the clamp at all. Either mutation
// leaves bar.style.left empty instead of "290px" (checked below, not just
// reasoned about).
test("placement wiring: clamps using the viewbar's left edge, triggered by the cube's vertical overlap", async () => {
  const OriginalRO = globalThis.ResizeObserver;
  let roCallback;
  const observed = new Set();
  globalThis.ResizeObserver = class {
    constructor(fn) { roCallback = fn; }
    observe(el) { observed.add(el); }
    disconnect() {}
  };
  try {
    const container = document.createElement("div");
    const viewbar = document.createElement("div");
    viewbar.id = "viewbar";
    const cube = document.createElement("div");
    cube.className = "pf-viewcube-stack";
    container.append(viewbar, cube);
    document.body.append(container);
    container.getBoundingClientRect = () =>
      ({ left: 0, right: 1000, top: 0, bottom: 700, width: 1000, height: 700 });
    // viewbar: band (656-692) misses the bar's band (610-646) entirely — on
    // its own it would early-return, same as the "bands don't intersect" case
    // above — but it reaches further left (700) than the cube.
    viewbar.getBoundingClientRect = () =>
      ({ left: 700, right: 990, top: 656, bottom: 692, width: 290, height: 36 });
    // cube: band (590-650) DOES overlap the bar's band, but sits to the right
    // of the viewbar (900) — it alone would trigger a clamp, but a looser one
    // than the union produces.
    cube.getBoundingClientRect = () =>
      ({ left: 900, right: 990, top: 590, bottom: 650, width: 90, height: 60 });
    const ctl = attachAnimationControls(fakeViewer(), part, {
      container, applyValues: () => {}, getParamValues: () => ({}), getView: () => "box",
    });
    handles.push(ctl);
    const bar = container.querySelector(".pf-anim-bar");
    bar.getBoundingClientRect = () =>
      ({ left: 300, right: 700, top: 610, bottom: 646, width: 400, height: 36 });
    // Registered at setup, per the brief's "best-effort extra" — the per-pass
    // lookup in applyPlacement is what makes correctness NOT depend on this.
    expect(observed.has(cube)).toBe(true);

    roCallback(); await nextFrame();
    // union: left min(700,900)=700 (VIEWBAR), top min(656,590)=590 (CUBE),
    // bottom max(692,650)=692 (VIEWBAR). Intersection test passes only because
    // the cube's top (590) pulls the union's top below the bar's bottom (646).
    // centeredLeft 300 > limit (union.left 700)−10−400 = 290 → slides left.
    // A cube-only measurement (viewbarLeft 900) would find limit 490 ≥
    // centeredLeft 300 → no clamp at all. A viewbar-only measurement would
    // never reach the intersection test in the first place. Both leave
    // bar.style.left === "" instead of "290px".
    expect(bar.style.left).toBe("290px");
  } finally {
    globalThis.ResizeObserver = OriginalRO;
  }
});

// The regression the test above could not see, because every rect it stubs has
// area: Sketch mode hides .pf-viewcube-stack with the `hidden` property, which
// resolves to display:none, and a display:none element's
// getBoundingClientRect() is ALL ZEROS. Unioning that in pulled the cluster's
// left/top edges to 0, which (a) made the vertical-band early return
// unreachable and (b) planned the bar to {left: 12, maxWidth: 0} — so entering
// Sketch on any view with animations shoved the transport to the stage's left
// edge and squeezed it to nothing. The bar must be placed exactly as if the
// hidden cube were not there at all.
test("placement wiring: a hidden cube's zero rect is ignored, not unioned in", async () => {
  const OriginalRO = globalThis.ResizeObserver;
  let roCallback;
  globalThis.ResizeObserver = class {
    constructor(fn) { roCallback = fn; }
    observe() {}
    disconnect() {}
  };
  try {
    const container = document.createElement("div");
    const viewbar = document.createElement("div");
    viewbar.id = "viewbar";
    const cube = document.createElement("div");
    cube.className = "pf-viewcube-stack";
    cube.hidden = true; // what mount does on entering Sketch mode
    container.append(viewbar, cube);
    document.body.append(container);
    container.getBoundingClientRect = () =>
      ({ left: 0, right: 1000, top: 0, bottom: 700, width: 1000, height: 700 });
    // The viewbar alone overlaps the bar's band here, so the clamp it produces
    // is a positive assertion rather than an early return.
    viewbar.getBoundingClientRect = () =>
      ({ left: 700, right: 990, top: 620, bottom: 656, width: 290, height: 36 });
    // display:none → every field zero. jsdom's own rect is already all zeros,
    // but stub it so the test states the premise it depends on.
    cube.getBoundingClientRect = () =>
      ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
    const ctl = attachAnimationControls(fakeViewer(), part, {
      container, applyValues: () => {}, getParamValues: () => ({}), getView: () => "box",
    });
    handles.push(ctl);
    const bar = container.querySelector(".pf-anim-bar");
    bar.getBoundingClientRect = () =>
      ({ left: 300, right: 700, top: 610, bottom: 646, width: 400, height: 36 });

    roCallback(); await nextFrame();
    // Viewbar-only geometry: centeredLeft 300 > limit 700−10−400 = 290 → slide
    // to 290, and available (700−10−12 = 678) still fits the 400px bar, so no
    // cap. With the zero rect unioned in, viewbarLeft collapses to 0 and this
    // reads "12px" with max-width 0px instead.
    expect(bar.style.left).toBe("290px");
    expect(bar.style.maxWidth).toBe("");
    expect(bar.classList.contains("pf-squeezed")).toBe(false);
  } finally {
    globalThis.ResizeObserver = OriginalRO;
  }
});

// --- crowding: the cube gives way when the bar runs out of room --------------
// The bar caps its own width as a last resort, and under that cap its controls
// fall below the 44x44 tap-target floor (scripts/check-app.mjs catches it at
// 320px on hinged-box). Rather than let that stand, the cube stack gives way and
// the bar reclaims the space. `onCrowded` is how the transport says so.

describe("nominalClusterRect", () => {
  // The point of the nominal rect is that it does NOT depend on whether the cube
  // is currently displayed — see the fixed-point test below.
  const viewbar = { left: 208, right: 348, top: 584, bottom: 628 };

  it("puts the stack's published footprint directly above the viewbar, sharing its right edge", () => {
    // chrome.css anchors both to right: 12px, with the stack sitting on top of
    // the viewbar, so the stack's edges follow from the viewbar's.
    const r = nominalClusterRect(viewbar, null, { width: 101, height: 101 });
    expect(r).toEqual({ left: 208, right: 348, top: 483, bottom: 628 });
    // A stack narrower than the viewbar leaves the union's left edge on the
    // viewbar; a wider one moves it onto the stack.
    expect(nominalClusterRect(viewbar, null, { width: 200, height: 101 }).left).toBe(148);
  });

  it("falls back to the cube's measured rect when there is no viewbar (a host that drops it)", () => {
    const cube = { left: 247, right: 348, top: 483, bottom: 584 };
    expect(nominalClusterRect(null, cube, { width: 101, height: 101 })).toEqual(cube);
    // Nothing to anchor a nominal claim on and nothing measured either: no
    // decision to make.
    expect(nominalClusterRect(null, null, { width: 101, height: 101 })).toBeNull();
  });

  it("claims nothing for the stack when no size has been published", () => {
    expect(nominalClusterRect(viewbar, null, null)).toEqual(viewbar);
    expect(nominalClusterRect(viewbar, null, { width: 0, height: 0 })).toEqual(viewbar);
  });

  it("treats an empty measured rect as the absence of a claim, like unionRect does", () => {
    const zero = { left: 0, right: 0, top: 0, bottom: 0 };
    expect(nominalClusterRect(null, zero, null)).toBeNull();
    // A zero viewbar rect must not anchor the stack at the stage's top-left.
    expect(nominalClusterRect(zero, null, { width: 101, height: 101 })).toBeNull();
  });
});

// A 320px phone stage: the touch layout gives the bar (100% − 24px) and lifts it
// to bottom: 64px, right into the band the cube stack occupies above #viewbar.
// Rects are client-space with the stage's top-left at the origin.
function crowdedStage() {
  const container = document.createElement("div");
  const viewbar = document.createElement("div");
  viewbar.id = "viewbar";
  const cube = document.createElement("div");
  cube.className = "pf-viewcube-stack";
  // What viewcube-controls.js publishes (see its own test): the stack's real
  // size, readable even once it is display:none.
  cube.dataset.pfW = "101";
  cube.dataset.pfH = "101";
  container.append(viewbar, cube);
  document.body.append(container);
  container.getBoundingClientRect = () =>
    ({ left: 0, right: 360, top: 0, bottom: 640, width: 360, height: 640 });
  viewbar.getBoundingClientRect = () =>
    ({ left: 208, right: 348, top: 584, bottom: 628, width: 140, height: 44 });
  return { container, viewbar, cube };
}
// The bar as the touch layout renders it: 336 wide, 80 tall (two rows), its top
// at 496 — inside the nominal cluster's band (483…628), so the collision test
// fires and planAnimBarPlacement caps it (available 208−10−12 = 186 < 336).
const stubCrowdedBar = (bar) => {
  bar.getBoundingClientRect = () =>
    ({ left: 12, right: 348, top: 496, bottom: 576, width: 336, height: 80 });
};

// THE test. The naive implementation decides crowding from the MEASURED union,
// which the cube is part of: hiding the cube shrinks the union, the bar fits,
// crowding reports false, the cube comes back, and the bar is crowded again —
// two frames per cycle, each one a ResizeObserver notification, on screen as a
// flickering cube. A single-pass test cannot see it, so this one drives two
// passes whose ONLY difference is the cube's measured rect (a real rect, then
// the all-zeros one a display:none element reports) and pins that the answer
// does not move.
test("crowding is a fixed point: the cube's own visibility cannot change the answer", async () => {
  const OriginalRO = globalThis.ResizeObserver;
  let roCallback;
  globalThis.ResizeObserver = class {
    constructor(fn) { roCallback = fn; }
    observe() {}
    disconnect() {}
  };
  try {
    const { container, cube } = crowdedStage();
    const crowded = [];
    const ctl = attachAnimationControls(fakeViewer(), part, {
      container, applyValues: () => {}, getParamValues: () => ({}), getView: () => "box",
      onCrowded: (v) => crowded.push(v),
    });
    handles.push(ctl);
    const bar = container.querySelector(".pf-anim-bar");
    stubCrowdedBar(bar);

    // Pass 1 — cube on screen and measured.
    cube.getBoundingClientRect = () =>
      ({ left: 247, right: 348, top: 483, bottom: 584, width: 101, height: 101 });
    roCallback(); await nextFrame();
    expect(crowded).toEqual([true]);
    expect(bar.style.maxWidth).toBe("186px"); // the cap that shrinks the controls

    // Pass 2 — the cube is hidden, which is what the `true` above asks mount to
    // do. Its MEASURED rect is all zeros, so the bar is now placed as if the
    // cube were not there (that is how the space is reclaimed: no cap at all) —
    // and the crowding answer is unchanged, so nothing brings the cube back.
    cube.hidden = true;
    cube.getBoundingClientRect = () =>
      ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
    roCallback(); await nextFrame();
    expect(bar.style.maxWidth).toBe("");
    expect(bar.classList.contains("pf-squeezed")).toBe(false);
    expect(crowded).toEqual([true]); // NOT [true, false]
  } finally {
    globalThis.ResizeObserver = OriginalRO;
  }
});

test("crowding: reported on change only, and never for a bar that is not on screen", async () => {
  const OriginalRO = globalThis.ResizeObserver;
  let roCallback;
  globalThis.ResizeObserver = class {
    constructor(fn) { roCallback = fn; }
    observe() {}
    disconnect() {}
  };
  try {
    const { container, cube } = crowdedStage();
    cube.getBoundingClientRect = () =>
      ({ left: 247, right: 348, top: 483, bottom: 584, width: 101, height: 101 });
    const crowded = [];
    let activeView = "box";
    const ctl = attachAnimationControls(fakeViewer(), part, {
      container, applyValues: () => {}, getParamValues: () => ({}),
      getView: () => activeView, onCrowded: (v) => crowded.push(v),
    });
    handles.push(ctl);
    stubCrowdedBar(container.querySelector(".pf-anim-bar"));

    roCallback(); await nextFrame();
    roCallback(); await nextFrame();
    roCallback(); await nextFrame();
    expect(crowded).toEqual([true]); // the initial value, reported once

    // A view with no animations hides the bar, and a bar that is not on screen
    // cannot be crowded by anything — whatever the cluster's geometry says.
    activeView = "solo";
    ctl.viewChanged();
    await nextFrame();
    expect(crowded).toEqual([true, false]);
    roCallback(); await nextFrame();
    expect(crowded).toEqual([true, false]);

    activeView = "box";
    ctl.viewChanged();
    await nextFrame();
    expect(crowded).toEqual([true, false, true]);
  } finally {
    globalThis.ResizeObserver = OriginalRO;
  }
});

// A stage with room: the bar slides clear of the cluster instead of capping
// itself, its controls keep their full size, and the cube has no reason to go.
// Crowding is about the CAP, not about the clamp.
test("crowding: false when the bar only has to slide", async () => {
  const OriginalRO = globalThis.ResizeObserver;
  let roCallback;
  globalThis.ResizeObserver = class {
    constructor(fn) { roCallback = fn; }
    observe() {}
    disconnect() {}
  };
  try {
    const container = document.createElement("div");
    const viewbar = document.createElement("div");
    viewbar.id = "viewbar";
    const cube = document.createElement("div");
    cube.className = "pf-viewcube-stack";
    cube.dataset.pfW = "135";
    cube.dataset.pfH = "135";
    container.append(viewbar, cube);
    document.body.append(container);
    container.getBoundingClientRect = () =>
      ({ left: 0, right: 1000, top: 0, bottom: 700, width: 1000, height: 700 });
    viewbar.getBoundingClientRect = () =>
      ({ left: 700, right: 988, top: 644, bottom: 688, width: 288, height: 44 });
    cube.getBoundingClientRect = () =>
      ({ left: 853, right: 988, top: 509, bottom: 644, width: 135, height: 135 });
    const crowded = [];
    const ctl = attachAnimationControls(fakeViewer(), part, {
      container, applyValues: () => {}, getParamValues: () => ({}), getView: () => "box",
      onCrowded: (v) => crowded.push(v),
    });
    handles.push(ctl);
    const bar = container.querySelector(".pf-anim-bar");
    // Band 610…646 overlaps the nominal cluster (509…688), so this reaches
    // planAnimBarPlacement: centeredLeft 300 > limit 700−10−400 = 290, so the
    // bar slides — but available (700−10−12 = 678) still fits its 400px, so
    // there is no cap and nothing is crowded.
    bar.getBoundingClientRect = () =>
      ({ left: 300, right: 700, top: 610, bottom: 646, width: 400, height: 36 });
    roCallback(); await nextFrame();
    expect(bar.style.left).toBe("290px");
    expect(crowded).toEqual([false]);
  } finally {
    globalThis.ResizeObserver = OriginalRO;
  }
});

test("crowding: onCrowded defaults to a no-op, so an unwired caller is unaffected", async () => {
  const OriginalRO = globalThis.ResizeObserver;
  let roCallback;
  globalThis.ResizeObserver = class {
    constructor(fn) { roCallback = fn; }
    observe() {}
    disconnect() {}
  };
  try {
    const { container, cube } = crowdedStage();
    cube.getBoundingClientRect = () =>
      ({ left: 247, right: 348, top: 483, bottom: 584, width: 101, height: 101 });
    const ctl = attachAnimationControls(fakeViewer(), part, {
      container, applyValues: () => {}, getParamValues: () => ({}), getView: () => "box",
    });
    handles.push(ctl);
    const bar = container.querySelector(".pf-anim-bar");
    stubCrowdedBar(bar);
    roCallback(); await nextFrame();
    expect(bar.style.maxWidth).toBe("186px"); // it still placed the bar, it just told nobody
  } finally {
    globalThis.ResizeObserver = OriginalRO;
  }
});

test("setHidden takes the bar off the stage and drops its clearance to 0", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const rect = (o) => () => ({ left: 0, right: 800, width: 800, height: 0, ...o });
  container.getBoundingClientRect = rect({ top: 0, bottom: 600, height: 600 });
  let activeView = "box";
  const ctl = attachAnimationControls(fakeViewer(), part, {
    container,
    applyValues: () => {},
    getParamValues: () => ({}),
    getView: () => activeView,
  });
  const bar = container.querySelector(".pf-anim-bar");
  bar.getBoundingClientRect = rect({ top: 540, bottom: 580, left: 200, right: 600, width: 400, height: 40 });
  await new Promise((r) => requestAnimationFrame(r));
  expect(bar.style.display).toBe("");

  ctl.setHidden(true);
  await new Promise((r) => requestAnimationFrame(r));
  expect(bar.style.display).toBe("none");
  expect(container.style.getPropertyValue("--pf-anim-clear")).toBe("0px");

  ctl.setHidden(false);
  await new Promise((r) => requestAnimationFrame(r));
  expect(bar.style.display).toBe("");
  expect(container.style.getPropertyValue("--pf-anim-clear")).not.toBe("0px");
  ctl.detach();
  container.remove();
});

test("setHidden does not resurrect the bar for a view that declares no animations", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let activeView = "solo"; // the fixture's animation-free view
  const ctl = attachAnimationControls(fakeViewer(), part, {
    container,
    applyValues: () => {},
    getParamValues: () => ({}),
    getView: () => activeView,
  });
  const bar = container.querySelector(".pf-anim-bar");
  ctl.viewChanged();
  await new Promise((r) => requestAnimationFrame(r));
  expect(bar.style.display).toBe("none");

  // Leaving sketch mode must not reveal a bar the ACTIVE VIEW wants hidden —
  // the two reasons are independent, which is the whole point of the flag.
  ctl.setHidden(true);
  ctl.setHidden(false);
  await new Promise((r) => requestAnimationFrame(r));
  expect(bar.style.display).toBe("none");
  ctl.detach();
  container.remove();
});
