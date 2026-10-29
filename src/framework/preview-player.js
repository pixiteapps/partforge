// The preview player: plays the autoplay animation a preview GLB carries
// (decoded by gltf/decode-preview.js) off the viewer's own frame loop, with no
// part code running. The live driver (animation-controls.js) moves params and
// rebuilds; here every animated sub-part's motion is already baked as
// model-frame keyframes, so a frame is a pose per sub-part and nothing more.
//
// Timing, cues and looping are not reimplemented: createPlayback (animation.js)
// runs on a synthetic normalized animation with no tracked params and no
// opacity keys, so its snapshot contributes only status, t and the cue to fire.
// The player turns that t into poses and opacities itself.
//
// Three rules (spec §3):
//  - A looping animation wraps; a once-through one rests at its end pose and
//    the player does nothing further each frame.
//  - A user orbit disarms the remaining camera cues and never pauses the
//    motion (mid-intro it releases the intro gate, so playback still starts).
//  - Reduced motion means no player: start() writes nothing — no pose, no
//    opacity, no ground hold, no cue — so the visitor sees exactly what the
//    file draws without a player (the opening pose, every sub-part opaque; an
//    opacity fade-in must not leave a sub-part hidden for good).
//
// A host can pause, resume and — once a one-time animation has finished —
// replay it (the preview's play/pause button, preview-play-button.js). Pause
// stops any camera move where it is (viewer.cancelCameraTween, as the live
// driver does): a cancelled tween never fires its onComplete, and createPlayback
// re-honors an abandoned intro or sweep on the next play(). An orbit while
// paused stays paused. onChange(cb) reports every status change, so a control
// never polls.
//
// A host that wants the model to WAIT at its first frame (mountPreview's
// `autostart: false`, 0.169.0) calls prime() instead of start(): the t = 0 pose
// and opacity are drawn — exactly what start() draws first — and nothing
// advances until start(). restart() plays again from t = 0 from any state
// (waiting, playing, paused, done), re-arming the cues and the intro.
import { createPlayback } from "./animation.js";
import { invertRigid, mulMat4 } from "./geometry/pose.js";

// A frame after a stall (a hidden tab, a long GC) advances at most this many
// seconds, so the motion resumes where it was rather than jumping.
export const MAX_FRAME_DT = 0.1;
const INTRO_TWEEN_SECONDS = 0.6;

// Spherical interpolation between two unit quaternions [x, y, z, w].
export function slerp(a, b, u) {
  let [bx, by, bz, bw] = b;
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; } // shortest arc
  let wa = 1 - u, wb = u;
  if (cos < 0.9995) {
    const theta = Math.acos(cos), s = Math.sin(theta);
    wa = Math.sin((1 - u) * theta) / s;
    wb = Math.sin(u * theta) / s;
  }
  const q = [wa * a[0] + wb * bx, wa * a[1] + wb * by, wa * a[2] + wb * bz, wa * a[3] + wb * bw];
  const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return q.map((c) => c / len);
}

// Column-major mat16 for rotation q followed by translation p.
export function quatToMat4([x, y, z, w], [px, py, pz]) {
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 0,
    2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 0,
    2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), 0,
    px, py, pz, 1,
  ];
}

// The keyframed transform at `seconds`: translation lerped, rotation slerped
// between the bracketing keyframes, held before the first and after the last.
export function sampleTrack({ times, translations, rotations }, seconds) {
  const n = times.length;
  const tr = (i) => [translations[i * 3], translations[i * 3 + 1], translations[i * 3 + 2]];
  const rot = (i) => [rotations[i * 4], rotations[i * 4 + 1], rotations[i * 4 + 2], rotations[i * 4 + 3]];
  if (n === 1 || seconds <= times[0]) return quatToMat4(rot(0), tr(0));
  if (seconds >= times[n - 1]) return quatToMat4(rot(n - 1), tr(n - 1));
  let i = 0;
  while (i < n - 2 && seconds >= times[i + 1]) i++;
  const u = (seconds - times[i]) / (times[i + 1] - times[i] || 1);
  const a = tr(i), b = tr(i + 1);
  return quatToMat4(slerp(rot(i), rot(i + 1), u), [0, 1, 2].map((k) => a[k] + (b[k] - a[k]) * u));
}

// Linear opacity over [[t, v], …] keyframes in normalized t, clamped at the ends.
export function sampleOpacity(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i];
    if (t <= t1) {
      const [t0, v0] = keys[i - 1];
      return v0 + (v1 - v0) * ((t - t0) / (t1 - t0 || 1));
    }
  }
  return keys[keys.length - 1][1];
}

export function createPreviewPlayer(viewer, animation, { reducedMotion = false } = {}) {
  const { duration, tracks, rest, opacity = {} } = animation;
  const steps = animation.steps ?? [];
  const playback = createPlayback({
    name: animation.name,
    loop: animation.loop,
    totalDuration: duration,
    cues: animation.cues ?? [],
    steps: steps.map((s) => ({ label: s.label, duration: s.duration, easing: "linear", tracks: {}, opacity: {}, camera: null })),
    stepStarts: steps.map((s) => s.start),
    trackedKeys: [],
    opacityKeys: [],
  });
  // Pose = keyframed transform with the rest transform taken out: the mesh
  // already sits at its t = 0 placement, so the identity pose is the rest pose.
  const restInverse = Object.fromEntries(Object.keys(tracks).map((name) => [name, invertRigid(rest[name])]));

  let offFrame = null, offOrbit = null, started = false, disposed = false, held = false;
  const listeners = new Set();
  let lastStatus = playback.state().status;

  function snapshotState() {
    const { status, t } = playback.state();
    return { status, t };
  }
  function notify() {
    const now = snapshotState();
    if (now.status === lastStatus) return;
    lastStatus = now.status;
    for (const cb of [...listeners]) {
      try { cb(now); } catch (error) { console.warn("partforge: preview animation listener failed", error); }
    }
  }

  function apply(t) {
    const seconds = t * duration;
    for (const [name, track] of Object.entries(tracks)) viewer.setSubPose(name, mulMat4(sampleTrack(track, seconds), restInverse[name]));
    for (const [name, keys] of Object.entries(opacity)) if (keys?.length) viewer.setSubPartOpacity(name, sampleOpacity(keys, t));
  }

  // A snapshot from play(): an intro cue tweens and gates playback until it lands.
  function honorIntro(snap) {
    if (snap.status !== "intro" || !snap.cue) return;
    viewer.tweenCameraTo(snap.cue.view, {
      duration: INTRO_TWEEN_SECONDS,
      onComplete: () => { if (!disposed) { playback.introDone(); notify(); } },
    });
  }

  function onFrame(dt) {
    const snap = playback.tick(Math.min(dt, MAX_FRAME_DT));
    if (!snap) return; // not playing: intro, paused, or done — the last poses stand
    apply(snap.t);
    if (snap.cue) viewer.tweenCameraTo(snap.cue.view, { duration: snap.cue.sweep ?? INTRO_TWEEN_SECONDS });
    notify();
  }

  function onOrbit() {
    playback.disarmCues();
    if (playback.state().status === "intro") { playback.introDone(); notify(); }
  }

  // The t = 0 pose and opacity, with the ground held for what moves next.
  function firstFrame() {
    apply(0);
    if (!held) { viewer.holdGround(true); held = true; }
  }

  const player = {
    // Draw the first frame and wait there (no-op under reduced motion, once
    // started, or once disposed).
    prime() {
      if (started || disposed || reducedMotion) return;
      firstFrame();
    },
    start() {
      if (started || disposed) return;
      started = true;
      if (reducedMotion) return;
      firstFrame();
      offFrame = viewer.onFrame(onFrame);
      offOrbit = viewer.onCameraStart(onOrbit);
      honorIntro(playback.play());
      notify();
    },
    pause() {
      if (disposed || !offFrame) return;
      const { status } = playback.state();
      if (status !== "playing" && status !== "intro") return;
      viewer.cancelCameraTween(); // an intro tween or a cue's sweep stops where it is
      playback.pause();
      notify();
    },
    resume() {
      if (disposed || playback.state().status !== "paused") return;
      honorIntro(playback.play());
      notify();
    },
    // From `done` only (a one-time animation resting at its end pose): play it
    // again exactly as on arrival — t = 0 pose and opacity first, then the
    // re-armed intro cue (createPlayback's play() from done resets t and cues).
    replay() {
      if (disposed || playback.state().status !== "done") return;
      apply(0);
      honorIntro(playback.play());
      notify();
    },
    // From any state: back to t = 0 (pose, opacity, cues re-armed) and play,
    // its intro cue included. Starts a player that was waiting. Nothing under
    // reduced motion — the file's own opening pose is already the t = 0 pose.
    restart() {
      if (disposed || reducedMotion) return;
      if (!started) { player.start(); return; }
      viewer.cancelCameraTween();
      playback.reset();
      apply(0);
      honorIntro(playback.play());
      notify();
    },
    // True once start() has run (under reduced motion too).
    started: () => started,
    onChange(cb) {
      if (disposed) return () => {};
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      if (offFrame) { offFrame(); offOrbit(); offFrame = offOrbit = null; }
      if (held) { held = false; viewer.holdGround(false); } // primed or played
    },
    state: snapshotState,
  };
  return player;
}
