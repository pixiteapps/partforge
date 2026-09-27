// test/framework/animation.test.js
// Timeline model: normalization (tracks→steps, camera desugaring) and
// evaluation (per-step easing, hold-outside-segment, cue lookup).
import { expect, test } from "vitest";
import {
  EASINGS, DEFAULT_EASING, normalizeAnimation, viewAnimations,
  evaluate, stepIndexAt, cueAt,
} from "../../src/framework/animation.js";

const open = {
  label: "Open lid", camera: "front", duration: 1.2,
  tracks: { lidAngle: [[0, 0], [1, 110]] },
};
const assemble = {
  label: "Assembly",
  steps: [
    { label: "Lower", camera: "left", duration: 1.0, tracks: { lidLift: [[0, 40], [1, 0]] } },
    { label: "Open", camera: "iso", duration: 1.0, tracks: { lidAngle: [[0, 0], [1, 110]] } },
  ],
};

test("single-track animation normalizes to one anonymous step", () => {
  const a = normalizeAnimation("open", open);
  expect(a.steps).toHaveLength(1);
  expect(a.totalDuration).toBeCloseTo(1.2);
  expect(a.stepStarts).toEqual([0]);
  expect(a.steps[0].easing).toBe(DEFAULT_EASING);
  expect(a.trackedKeys).toEqual(["lidAngle"]);
});

test("animation-level camera name desugars to a cue at t=0", () => {
  expect(normalizeAnimation("open", open).cues).toEqual([{ t: 0, view: "front", sweep: null }]);
});

test("per-step cameras desugar to cues at step starts", () => {
  const a = normalizeAnimation("assemble", assemble);
  expect(a.stepStarts).toEqual([0, 0.5]);
  expect(a.cues).toEqual([{ t: 0, view: "left", sweep: 1 }, { t: 0.5, view: "iso", sweep: 1 }]);
});

test("a per-step cue sweeps across its own step, a cue-list cue until the next cue", () => {
  const stepped = normalizeAnimation("s", { steps: [
    { camera: "top-front-left", duration: 0.5, tracks: { k: [[0, 0], [1, 1]] } },
    { duration: 2, tracks: { k: [[0, 1], [1, 2]] } },
    { camera: "iso", duration: 1.5, tracks: { k: [[0, 2], [1, 3]] } },
  ] });
  expect(stepped.cues.map((c) => c.sweep)).toEqual([0.5, 1.5]);
  const listed = normalizeAnimation("l", { duration: 4, camera: [[0, "iso"], [0.25, "top-back-left"]], tracks: { k: [[0, 0], [1, 1]] } });
  expect(listed.cues.map((c) => c.sweep)).toEqual([1, 3]);
});

test("cue-list camera passes through", () => {
  const a = normalizeAnimation("x", { duration: 1, camera: [[0, "iso"], [0.4, "top"]], tracks: { k: [[0, 0], [1, 1]] } });
  expect(a.cues).toEqual([{ t: 0, view: "iso", sweep: 0.4 }, { t: 0.4, view: "top", sweep: 0.6 }]);
});

test("evaluate interpolates linearly under linear easing", () => {
  const a = normalizeAnimation("x", { duration: 1, easing: "linear", tracks: { k: [[0, 0], [1, 100]] } });
  expect(evaluate(a, 0.25).values.k).toBeCloseTo(25);
  expect(evaluate(a, 1).values.k).toBe(100);
});

test("default easing is smooth: midpoint exact, quarter below linear", () => {
  const a = normalizeAnimation("x", { duration: 1, tracks: { k: [[0, 0], [1, 100]] } });
  expect(evaluate(a, 0.5).values.k).toBeCloseTo(50);
  expect(evaluate(a, 0.25).values.k).toBeLessThan(25);
});

test("params hold outside their segment (before: first value, after: last)", () => {
  const a = normalizeAnimation("assemble", assemble);
  // during step 1, lidAngle (tracked only in step 2) holds its first keyframe value
  expect(evaluate(a, 0.25).values.lidAngle).toBe(0);
  // during step 2, lidLift holds its final value from step 1
  expect(evaluate(a, 0.75).values.lidLift).toBe(0);
  expect(evaluate(a, 0.75).stepIndex).toBe(1);
});

test("stepIndexAt clamps and maps boundaries to the later step", () => {
  const a = normalizeAnimation("assemble", assemble);
  expect(stepIndexAt(a, 0)).toBe(0);
  expect(stepIndexAt(a, 0.5)).toBe(1);
  expect(stepIndexAt(a, 1)).toBe(1);
  expect(stepIndexAt(a, 2)).toBe(1);
});

test("cueAt returns the governing (most recent at-or-before) cue", () => {
  const a = normalizeAnimation("assemble", assemble);
  expect(cueAt(a, 0.3)).toMatchObject({ t: 0, view: "left" });
  expect(cueAt(a, 0.9)).toMatchObject({ t: 0.5, view: "iso" });
});

test("EASINGS endpoints are exact", () => {
  for (const fn of Object.values(EASINGS)) { expect(fn(0)).toBe(0); expect(fn(1)).toBe(1); }
});

test("normalizeAnimation carries autoplay as a boolean, default false", () => {
  expect(normalizeAnimation("x", { duration: 1, tracks: { k: [[0, 0], [1, 1]] } }).autoplay).toBe(false);
  expect(normalizeAnimation("x", { duration: 1, autoplay: true, tracks: { k: [[0, 0], [1, 1]] } }).autoplay).toBe(true);
});

// --- totality: the model runs inside the render loop, so it must not throw ------
// A throw from evaluate() reaches three's frame callback, and three re-arms
// requestAnimationFrame only after that callback returns — so one throw freezes
// the viewer for good. Lint reports each of these shapes, but an unlinted part
// must still degrade rather than take the app down.

test("a track with unusable keyframes is dropped from trackedKeys, not evaluated", () => {
  for (const bad of [null, undefined, 0, "", []]) {
    const a = normalizeAnimation("x", { duration: 1, tracks: { k: bad } });
    expect(a.trackedKeys, `tracks: { k: ${JSON.stringify(bad)} }`).toEqual([]);
    expect(() => evaluate(a, 0.5)).not.toThrow();
    expect(evaluate(a, 0.5).values).toEqual({});
  }
});

test("a usable track alongside an unusable one still evaluates", () => {
  const a = normalizeAnimation("x", { duration: 1, tracks: { good: [[0, 0], [1, 10]], bad: null } });
  expect(a.trackedKeys).toEqual(["good"]);
  expect(evaluate(a, 1).values).toEqual({ good: 10 });
});

test("easing is looked up by own key, so Object.prototype members fall back", () => {
  // `"toString" in EASINGS` is true, so an `in`-based lookup resolves a function
  // that returns garbage, and "__proto__" resolves to a non-function that throws.
  const linear = normalizeAnimation("ok", { duration: 1, easing: "linear", tracks: { k: [[0, 0], [1, 100]] } });
  for (const easing of ["__proto__", "toString", "isPrototypeOf", "constructor", "nonsense"]) {
    const a = normalizeAnimation("x", { duration: 1, easing, tracks: { k: [[0, 0], [1, 100]] } });
    expect(() => evaluate(a, 0.5), `easing: ${easing}`).not.toThrow();
    // Falls back to DEFAULT_EASING, which at the midpoint is the same 50 linear gives.
    expect(evaluate(a, 0.5).values.k, `easing: ${easing}`).toBe(evaluate(linear, 0.5).values.k);
    expect(evaluate(a, 0).values.k).toBe(0);
    expect(evaluate(a, 1).values.k).toBe(100);
  }
});

test("a non-finite t folds to 0 instead of propagating NaN", () => {
  const a = normalizeAnimation("x", { duration: 1, easing: "linear", tracks: { k: [[0, 0], [1, 100]] } });
  for (const t of [NaN, undefined, Infinity, -Infinity]) {
    const r = evaluate(a, t);
    expect(Number.isFinite(r.values.k), `t: ${String(t)}`).toBe(true);
  }
  expect(evaluate(a, NaN).values.k).toBe(0);
  expect(evaluate(a, Infinity).values.k).toBe(100); // clamps to 1, still finite
  expect(stepIndexAt(a, NaN)).toBe(0);
});

// --- opacity tracks + per-view normalization (spec 2026-08-10) --------------

const fadePart = {
  views: {
    box: { label: "Box" },
    assembly: {
      label: "Assembly",
      animations: {
        assemble: {
          label: "Assemble",
          steps: [
            { label: "Appear", duration: 1, easing: "linear",
              opacity: { lid: [[0, 0], [1, 1]] } },
            { label: "Lower", duration: 1, easing: "linear",
              tracks: { lidLift: [[0, 40], [1, 0]] } },
          ],
        },
        fade: { label: "Fade", duration: 2, easing: "linear",
          opacity: { base: [[0, 1], [1, 0]] } },
      },
    },
  },
};

test("viewAnimations maps each view to its own normalized set", () => {
  const byView = viewAnimations(fadePart);
  expect([...byView.keys()]).toEqual(["box", "assembly"]);
  expect(byView.get("box")).toEqual([]);
  expect(byView.get("assembly").map((a) => a.name)).toEqual(["assemble", "fade"]);
});

test("viewAnimations skips a malformed entry instead of throwing", () => {
  const bad = { views: { v: { label: "V", animations: { ok: { duration: 1, tracks: { x: [[0, 0], [1, 1]] } }, broken: null } } } };
  expect(viewAnimations(bad).get("v").map((a) => a.name)).toEqual(["ok"]);
});

test("top-level animations are ignored (clean break)", () => {
  const legacy = { views: { v: { label: "V" } }, animations: { open: { duration: 1, tracks: { x: [[0, 0], [1, 1]] } } } };
  expect(viewAnimations(legacy).get("v")).toEqual([]);
});

test("opacity tracks normalize and evaluate like param tracks", () => {
  const [assemble] = viewAnimations(fadePart).get("assembly");
  expect(assemble.opacityKeys).toEqual(["lid"]);
  expect(assemble.trackedKeys).toEqual(["lidLift"]);
  // mid step 1 (t=0.25 of the whole): lid fading in, linear → 0.5
  expect(evaluate(assemble, 0.25).opacity.lid).toBeCloseTo(0.5);
  // step 2 (t=0.75): lid holds its nearest keyframe (1); lidLift interpolates
  const r = evaluate(assemble, 0.75);
  expect(r.opacity.lid).toBe(1);
  expect(r.values.lidLift).toBeCloseTo(20);
});

test("bare single-phase form carries opacity (no steps wrapper)", () => {
  const fade = viewAnimations(fadePart).get("assembly")[1];
  expect(fade.steps).toHaveLength(1);
  expect(fade.opacityKeys).toEqual(["base"]);
  expect(evaluate(fade, 0.5).opacity.base).toBeCloseTo(0.5);
  expect(evaluate(fade, 1).opacity.base).toBe(0);
});

test("opacity tracked only in a LATER step holds its first keyframe earlier", () => {
  const lateFade = normalizeAnimation("x", { steps: [
    { label: "Wait", duration: 1, easing: "linear", tracks: { lidLift: [[0, 40], [1, 40]] } },
    { label: "Appear", duration: 1, easing: "linear", opacity: { lid: [[0, 0], [1, 1]] } },
  ] });
  expect(evaluate(lateFade, 0.25).opacity.lid).toBe(0); // hidden until its moment
});

test("an opacity-only animation is normalizable (no tracks anywhere)", () => {
  const fade = viewAnimations(fadePart).get("assembly")[1];
  expect(fade.trackedKeys).toEqual([]);
  expect(evaluate(fade, 0.3).values).toEqual({});
});
