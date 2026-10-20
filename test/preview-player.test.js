// test/preview-player.test.js
import { expect, test } from "vitest";
import { createPreviewPlayer, MAX_FRAME_DT } from "../src/framework/preview-player.js";
import { composePose } from "../src/framework/geometry/pose.js";

const T = (z) => composePose([{ t: "translate", v: [0, 0, z] }]);
function fakeViewer() {
  const frame = new Set(), cam = new Set();
  return {
    poses: {}, opacity: {}, tweens: [], ground: null,
    onFrame: (cb) => { frame.add(cb); return () => frame.delete(cb); },
    onCameraStart: (cb) => { cam.add(cb); return () => cam.delete(cb); },
    setSubPose(n, m) { this.poses[n] = m; },
    setSubPartOpacity(n, v) { this.opacity[n] = v; },
    clearSubPartOpacities() { this.opacity = {}; },
    cancels: 0,
    tweenCameraTo(view, o) { this.tweens.push({ view, ...o }); },
    cancelCameraTween() { this.cancels++; },
    holdGround(on) { this.ground = on; },
    frame(dt) { for (const cb of [...frame]) cb(dt); },
    orbit() { for (const cb of [...cam]) cb(); },
  };
}
// Advance `seconds` in frames no longer than MAX_FRAME_DT, so the clamp never bites.
function run(v, seconds) { for (let i = 0; i < Math.round(seconds / 0.1); i++) v.frame(0.1); }
const lidUp = { // rises 0 → 20 mm over 2 s, loop false, one intro cue
  name: "rise", loop: false, duration: 2, cues: [{ t: 0, view: "front", sweep: null }], opacity: {}, steps: [{ label: null, start: 0, duration: 2 }], animated: ["lid"],
  tracks: { lid: { times: new Float32Array([0, 2]), translations: new Float32Array([0,0,0, 0,0,20]), rotations: new Float32Array([0,0,0,1, 0,0,0,1]) } },
  rest: { lid: T(0) },
};

test("start applies t=0, fires the intro cue, and plays only after it settles", () => {
  const v = fakeViewer();
  const p = createPreviewPlayer(v, lidUp);
  p.start();
  expect(v.ground).toBe(true);
  expect(v.tweens).toEqual([expect.objectContaining({ view: "front", duration: 0.6 })]);
  expect(p.state().status).toBe("intro");
  v.frame(0.5);
  expect(p.state().t).toBe(0);           // gated by the intro
  v.tweens[0].onComplete();
  run(v, 0.5);
  expect(p.state().t).toBeCloseTo(0.25);
  expect(v.poses.lid[14]).toBeCloseTo(5); // 20 mm × 0.25
});

test("a once-through animation rests at its end pose", () => {
  const v = fakeViewer();
  const p = createPreviewPlayer(v, { ...lidUp, cues: [] });
  p.start();
  for (let i = 0; i < 40; i++) v.frame(0.1);
  expect(p.state()).toEqual({ status: "done", t: 1 });
  expect(v.poses.lid[14]).toBeCloseTo(20);
  v.frame(0.1);
  expect(v.poses.lid[14]).toBeCloseTo(20);
});

test("a looping animation wraps", () => {
  const v = fakeViewer();
  const p = createPreviewPlayer(v, { ...lidUp, cues: [], loop: true });
  p.start();
  for (let i = 0; i < 25; i++) v.frame(0.1); // 2.5 s → t = 0.25
  expect(p.state().status).toBe("playing");
  expect(p.state().t).toBeCloseTo(0.25);
});

test("a frame longer than 100 ms is clamped", () => {
  const v = fakeViewer();
  const p = createPreviewPlayer(v, { ...lidUp, cues: [] });
  p.start();
  v.frame(60);
  expect(p.state().t).toBeCloseTo(MAX_FRAME_DT / 2);
});

test("a user orbit disarms the remaining cues and never pauses the motion", () => {
  const v = fakeViewer();
  const anim = { ...lidUp, cues: [{ t: 0.5, view: "iso", sweep: 1 }] };
  const p = createPreviewPlayer(v, anim);
  p.start();
  v.orbit();
  for (let i = 0; i < 20; i++) v.frame(0.1);
  expect(v.tweens).toEqual([]);
  expect(p.state().status).toBe("done");
});

test("a mid-timeline cue sweeps for its declared seconds", () => {
  const v = fakeViewer();
  const p = createPreviewPlayer(v, { ...lidUp, cues: [{ t: 0.5, view: "iso", sweep: 1 }] });
  p.start();
  for (let i = 0; i < 12; i++) v.frame(0.1);
  expect(v.tweens).toEqual([expect.objectContaining({ view: "iso", duration: 1 })]);
});

test("opacity interpolates from the extra's keyframes", () => {
  const v = fakeViewer();
  const p = createPreviewPlayer(v, { ...lidUp, cues: [], opacity: { lid: [[0, 0], [1, 1]] } });
  p.start();
  expect(v.opacity.lid).toBe(0);
  for (let i = 0; i < 10; i++) v.frame(0.1);
  expect(v.opacity.lid).toBeCloseTo(0.5);
});

test("rotation slerps between keyframes", () => {
  // a 180° X rotation over 2 s: at t=0.5 the pose's rotation block is 90° about X (m[5] ≈ 0, m[6] ≈ 1)
  const v = fakeViewer();
  const flip = {
    ...lidUp, cues: [],
    tracks: { lid: { times: new Float32Array([0, 2]), translations: new Float32Array([0,0,0, 0,0,0]), rotations: new Float32Array([0,0,0,1, 1,0,0,0]) } },
  };
  const p = createPreviewPlayer(v, flip);
  p.start();
  expect(v.poses.lid[5]).toBeCloseTo(1);
  for (let i = 0; i < 10; i++) v.frame(0.1);
  expect(p.state().t).toBeCloseTo(0.5);
  expect(v.poses.lid[5]).toBeCloseTo(0);
  expect(v.poses.lid[6]).toBeCloseTo(1);
  expect(v.poses.lid[9]).toBeCloseTo(-1);
});

test("reduced motion writes nothing: no pose, no opacity, no ground hold, never plays", () => {
  // An assemble-style fade (lid from opacity 0): writing t = 0 would leave the
  // lid invisible for good. The visitor sees what the file draws without a player.
  const v = fakeViewer();
  const p = createPreviewPlayer(v, { ...lidUp, opacity: { lid: [[0, 0], [1, 1]] } }, { reducedMotion: true });
  p.start();
  v.frame(1);
  expect(p.state().status).toBe("idle");
  expect(v.tweens).toEqual([]);
  expect(v.opacity).toEqual({});
  expect(v.poses).toEqual({});
  expect(v.ground).toBeNull();
  p.dispose();
  expect(v.ground).toBeNull();
});

test("pause/resume and dispose", () => {
  const v = fakeViewer();
  const p = createPreviewPlayer(v, { ...lidUp, cues: [] });
  p.start(); run(v, 0.5); p.pause(); run(v, 0.5);
  expect(p.state().t).toBeCloseTo(0.25);
  p.resume(); run(v, 0.5);
  expect(p.state().t).toBeCloseTo(0.5);
  p.dispose();
  expect(v.ground).toBe(false);
  run(v, 0.5);
  expect(p.state().t).toBeCloseTo(0.5);
});

test("replay from done restarts at t=0 and re-fires the intro cue", () => {
  const v = fakeViewer();
  const p = createPreviewPlayer(v, lidUp);
  p.start();
  v.tweens[0].onComplete();
  run(v, 2.5);
  expect(p.state()).toEqual({ status: "done", t: 1 });
  expect(v.poses.lid[14]).toBeCloseTo(20);
  p.replay();
  expect(p.state()).toEqual({ status: "intro", t: 0 });
  expect(v.poses.lid[14]).toBeCloseTo(0);       // the opening pose, before the intro lands
  expect(v.tweens).toHaveLength(2);
  expect(v.tweens[1]).toEqual(expect.objectContaining({ view: "front", duration: 0.6 }));
  v.tweens[1].onComplete();
  run(v, 0.5);
  expect(p.state().status).toBe("playing");
  expect(p.state().t).toBeCloseTo(0.25);
});

test("replay does nothing unless the animation is done", () => {
  const v = fakeViewer();
  const p = createPreviewPlayer(v, { ...lidUp, cues: [] });
  p.replay();                       // before start
  expect(p.state().status).toBe("idle");
  p.start(); run(v, 0.5);
  p.replay();                       // mid-play
  expect(p.state().t).toBeCloseTo(0.25);
  p.pause(); p.replay();            // paused
  expect(p.state().status).toBe("paused");
});

test("onChange fires on every status transition and stops after off() or dispose", () => {
  const v = fakeViewer();
  const p = createPreviewPlayer(v, lidUp);
  const seen = [];
  const off = p.onChange((s) => seen.push(s.status));
  const other = [];
  p.onChange((s) => other.push(s.status));
  p.start();
  v.tweens[0].onComplete();
  run(v, 0.5);
  p.pause();
  p.pause();                         // no change, no event
  p.resume();
  run(v, 2);
  p.replay();
  v.tweens.at(-1).onComplete();
  expect(seen).toEqual(["intro", "playing", "paused", "playing", "done", "intro", "playing"]);
  off();
  p.pause();
  expect(seen).toHaveLength(7);
  expect(other.at(-1)).toBe("paused");
  p.dispose();
  p.resume();
  expect(other.at(-1)).toBe("paused");
});

test("an orbit mid-intro reports intro → playing", () => {
  const v = fakeViewer();
  const p = createPreviewPlayer(v, lidUp);
  const seen = [];
  p.onChange((s) => seen.push(s.status));
  p.start();
  v.orbit();
  expect(seen).toEqual(["intro", "playing"]);
});

test("pause during the intro stops the camera where it is and is not stuck", () => {
  const v = fakeViewer();
  const p = createPreviewPlayer(v, lidUp);
  p.start();
  expect(p.state().status).toBe("intro");
  p.pause();
  expect(v.cancels).toBe(1);                   // the intro tween is stopped in place
  expect(p.state().status).toBe("paused");
  v.tweens[0].onComplete();                    // a stale completion cannot start playback
  run(v, 0.5);
  expect(p.state()).toEqual({ status: "paused", t: 0 });
  p.resume();                                  // re-honors the intro
  expect(p.state().status).toBe("intro");
  expect(v.tweens).toHaveLength(2);
  v.tweens[1].onComplete();
  run(v, 0.5);
  expect(p.state().status).toBe("playing");
  expect(p.state().t).toBeCloseTo(0.25);
});

test("pause mid-sweep stops the camera move too", () => {
  const v = fakeViewer();
  const p = createPreviewPlayer(v, { ...lidUp, cues: [{ t: 0.5, view: "iso", sweep: 1 }] });
  p.start();
  run(v, 1.2);
  expect(v.tweens).toHaveLength(1);
  p.pause();
  expect(v.cancels).toBe(1);
});

test("an orbit while paused stays paused; resume then plays with the user's camera", () => {
  const v = fakeViewer();
  const p = createPreviewPlayer(v, lidUp);
  p.start();
  p.pause();
  v.orbit();
  run(v, 0.5);
  expect(p.state()).toEqual({ status: "paused", t: 0 });
  p.resume();
  expect(p.state().status).toBe("playing"); // the orbit disarmed the cues: no intro
  expect(v.tweens).toHaveLength(1);
});
