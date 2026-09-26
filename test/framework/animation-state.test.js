// Playback state machine: intro gating, cue firing/disarming, stepped
// playback with stop-at-step-end, loop wrap, seek/reset semantics.
import { expect, test } from "vitest";
import { normalizeAnimation, createPlayback } from "../../src/framework/animation.js";

const open = normalizeAnimation("open", {
  camera: "front", duration: 2, easing: "linear", tracks: { lidAngle: [[0, 0], [1, 110]] },
});
const plain = normalizeAnimation("plain", { duration: 2, easing: "linear", tracks: { k: [[0, 0], [1, 100]] } });
const stepped = normalizeAnimation("assemble", {
  steps: [
    { label: "Lower", camera: "left", duration: 1, easing: "linear", tracks: { lift: [[0, 40], [1, 0]] } },
    { label: "Open", camera: "iso", duration: 1, easing: "linear", tracks: { angle: [[0, 0], [1, 110]] } },
  ],
});
const looped = normalizeAnimation("cycle", { duration: 2, loop: true, easing: "linear", tracks: { k: [[0, 0], [1, 100]] } });

test("play with a governing cue gates in intro; introDone starts playback", () => {
  const pb = createPlayback(open);
  const r = pb.play();
  expect(r.status).toBe("intro");
  expect(r.cue).toMatchObject({ t: 0, view: "front" });
  expect(pb.tick(0.5)).toBeNull(); // params hold during the intro
  expect(pb.introDone().status).toBe("playing");
  const f = pb.tick(0.5); // 0.5s of 2s → t=0.25
  expect(f.t).toBeCloseTo(0.25);
  expect(f.values.lidAngle).toBeCloseTo(27.5);
});

test("play without cues goes straight to playing and finishes at done", () => {
  const pb = createPlayback(plain);
  expect(pb.play().status).toBe("playing");
  const r = pb.tick(5);
  expect(r.status).toBe("done");
  expect(r.t).toBe(1);
  expect(r.values.k).toBe(100);
});

test("replay after done rewinds and re-arms the intro cue", () => {
  const pb = createPlayback(open);
  pb.play(); pb.introDone(); pb.tick(5);
  const r = pb.play();
  expect(r.status).toBe("intro");
  expect(r.t).toBe(0);
});

test("pause holds; resume does not re-fire the already-fired cue", () => {
  const pb = createPlayback(open);
  pb.play(); pb.introDone(); pb.tick(0.5);
  expect(pb.pause().status).toBe("paused");
  const r = pb.play();
  expect(r.status).toBe("playing"); // no second intro
  expect(r.cue).toBeNull();
});

test("seek pauses, and a later play re-honors the governing cue", () => {
  const pb = createPlayback(stepped);
  const s = pb.seek(0.75);
  expect(s.status).toBe("paused");
  expect(s.values.angle).toBeCloseTo(55);
  const r = pb.play();
  expect(r.status).toBe("intro");
  expect(r.cue).toMatchObject({ t: 0.5, view: "iso" });
});

test("a mid-timeline cue fires during tick without gating", () => {
  const pb = createPlayback(stepped);
  pb.play(); pb.introDone(); // consumes the t=0 "left" cue
  const r = pb.tick(1.1); // crosses t=0.5
  expect(r.status).toBe("playing");
  expect(r.cue).toMatchObject({ t: 0.5, view: "iso" });
});

test("disarmCues stops all cue traffic until reset", () => {
  const pb = createPlayback(stepped);
  pb.play(); pb.introDone();
  pb.disarmCues();
  expect(pb.tick(1.1).cue).toBeNull();
  pb.reset();
  expect(pb.play().status).toBe("intro"); // re-armed
});

test("stepNext plays exactly one step then pauses at its end", () => {
  const pb = createPlayback(stepped);
  const r = pb.stepNext(); // from idle t=0 (step 0) → plays step 1
  expect(r.stepIndex).toBe(1);
  expect(r.status).toBe("intro"); // step 2's iso cue gates
  pb.introDone();
  const done = pb.tick(5);
  expect(done.status).toBe("paused");
  expect(done.t).toBe(1);
});

test("stepPrev replays the previous step", () => {
  const pb = createPlayback(stepped);
  pb.seek(0.75);
  const r = pb.stepPrev();
  expect(r.t).toBe(0);
  expect(r.stepIndex).toBe(0);
});

test("loop wraps t and keeps playing", () => {
  const pb = createPlayback(looped);
  pb.play();
  const r = pb.tick(2.5); // 1.25 cycles
  expect(r.status).toBe("playing");
  expect(r.t).toBeCloseTo(0.25);
});

test("userEdited pauses only active playback", () => {
  const pb = createPlayback(plain);
  pb.userEdited();
  expect(pb.state().status).toBe("idle");
  pb.play(); pb.userEdited();
  expect(pb.state().status).toBe("paused");
});

test("reset returns to idle at t=0", () => {
  const pb = createPlayback(plain);
  pb.play(); pb.tick(1);
  const r = pb.reset();
  expect(r).toMatchObject({ t: 0, status: "idle", stepIndex: 0 });
});

// --- an intro cue is only retired once its tween actually settles --------------
// camera-tween's cancel() drops onComplete, so a cue retired at begin() would
// never be re-issued: pausing mid-sweep left the camera stranded wherever the
// cancelled tween stopped, for the rest of the run.

test("pausing mid-intro re-issues the cue on resume", () => {
  const pb = createPlayback(open);
  expect(pb.play().cue).toMatchObject({ t: 0, view: "front" });
  expect(pb.pause().status).toBe("paused");
  const again = pb.play();
  expect(again.status).toBe("intro");
  expect(again.cue).toMatchObject({ t: 0, view: "front" });
});

test("a settled intro cue is not re-issued by a later pause/play", () => {
  const pb = createPlayback(open);
  expect(pb.play().cue).toMatchObject({ t: 0, view: "front" });
  expect(pb.introDone().status).toBe("playing");
  pb.pause();
  const again = pb.play();
  expect(again.status).toBe("playing"); // no gate: nothing left to tween
  expect(again.cue).toBeNull();
});

test("seek(NaN) folds to 0 rather than stalling playback forever", () => {
  const pb = createPlayback(plain);
  expect(pb.seek(NaN).t).toBe(0);
  pb.play();
  const r = pb.tick(100); // well past the 2s duration
  expect(r.t).toBe(1);
  expect(r.status).toBe("done"); // an unclamped NaN never satisfies t >= 1
});

test("a pending step boundary outranks looping", () => {
  // Lint rejects loop on a stepped animation, so these rarely coexist — but an
  // explicit "play this step" must still stop where it was told rather than being
  // swallowed by the wrap and running forever.
  const loopedSteps = normalizeAnimation("x", { loop: true, steps: [
    { label: "One", duration: 1, easing: "linear", tracks: { k: [[0, 0], [1, 50]] } },
    { label: "Two", duration: 1, easing: "linear", tracks: { k: [[0, 50], [1, 100]] } },
  ] });
  const pb = createPlayback(loopedSteps);
  pb.playStep(0);
  let r;
  for (let i = 0; i < 20; i++) r = pb.tick(0.2) ?? r;
  expect(r.status).toBe("paused");
  expect(r.t).toBeCloseTo(0.5);
});

// `loop` and `autoplay` fail CLOSED: only a literal `true` turns them on. Lint
// reports a non-boolean, but a part can mount in a browser without ever having
// been linted, and coercing with `!!` reads `loop: "false"` as "loop forever" —
// the worst available reading of that typo.
test("only a literal true enables looping", () => {
  for (const loop of [1, "false", "no", {}, []]) {
    const a = normalizeAnimation("x", { loop, duration: 1, easing: "linear", tracks: { k: [[0, 0], [1, 100]] } });
    expect(a.loop, `loop: ${JSON.stringify(loop)}`).toBe(false);
    const pb = createPlayback(a);
    pb.play();
    let r;
    for (let i = 0; i < 15; i++) r = pb.tick(0.2) ?? r; // 3s over a 1s animation
    expect(r.status, `loop: ${JSON.stringify(loop)}`).toBe("done"); // not wrapping
    expect(r.t).toBe(1);
  }
  expect(normalizeAnimation("x", { loop: true, duration: 1, tracks: { k: [[0, 0], [1, 1]] } }).loop).toBe(true);
});

test("only a literal true enables autoplay", () => {
  for (const autoplay of [1, "false", "no", {}]) {
    const a = normalizeAnimation("x", { autoplay, duration: 1, tracks: { k: [[0, 0], [1, 1]] } });
    expect(a.autoplay, `autoplay: ${JSON.stringify(autoplay)}`).toBe(false);
  }
  expect(normalizeAnimation("x", { autoplay: true, duration: 1, tracks: { k: [[0, 0], [1, 1]] } }).autoplay).toBe(true);
});

test("pausing mid-sweep re-honors that cue on resume; after the sweep lands it does not", () => {
  const pb = createPlayback(stepped);
  pb.play(); pb.introDone();
  expect(pb.tick(1.1).cue).toMatchObject({ view: "iso" }); // t=0.55, 1 s sweep still moving
  pb.pause();
  const resumed = pb.play();
  expect(resumed.status).toBe("intro");
  expect(resumed.cue).toMatchObject({ view: "iso" });

  const settled = createPlayback(normalizeAnimation("s", {
    steps: [
      { camera: "left", duration: 1, tracks: { k: [[0, 0], [1, 1]] } },
      { camera: "iso", duration: 0.5, tracks: { k: [[0, 1], [1, 2]] } },
      { duration: 1, tracks: { k: [[0, 2], [1, 3]] } },
    ],
  }));
  settled.play(); settled.introDone();
  settled.tick(1.1); // iso fires at its step start
  settled.tick(0.6); // past iso's 0.5 s sweep
  settled.pause();
  expect(settled.play().status).toBe("playing"); // camera already there: no re-intro
});

test("stopping on a step boundary does not start the next step's sweep", () => {
  const pb = createPlayback(stepped);
  pb.playStep(0); pb.introDone();
  const r = pb.tick(5);
  expect(r.status).toBe("paused");
  expect(r.cue).toBeNull();
});
