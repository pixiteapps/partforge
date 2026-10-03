// test/lint-animations.test.js
// Static animations-block validation. Each fixture perturbs one thing on a
// minimal valid part; assertions check the finding id lands on the right path.
// Animations are VIEW-OWNED (spec 2026-08-10-per-view-animations): every block
// lives at `views.<view>.animations`, and every finding path says so.
import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";
import lattice from "./fixtures/lattice-lid-part.js";

const base = (overrides = {}) => ({
  meta: { title: "T" },
  parameters: [{ id: "s", title: "S", advanced: [
    { key: "a", label: "A", min: 0, max: 100, step: 1 },
  ] }],
  defaults: { a: 0, txt: "hi" },
  parts: { p: { views: ["v"], build: (k) => k.box({ size: [1, 1, 1] }) } },
  views: { v: { label: "V" } },
  ...overrides,
});
// One view carrying an animations block, replacing the default `views` map.
const withAnim = (view, anims) => base({ views: { [view]: { label: view.toUpperCase(), animations: anims } } });
const ids = (r) => [...r.errors, ...r.warnings].map((f) => f.rule);
const findingsFor = (part, id) => {
  const r = lintPart(part);
  return [...r.errors, ...r.warnings, ...r.notes].filter((f) => f.rule === id);
};

const valid = { duration: 1, tracks: { a: [[0, 0], [1, 100]] } };

test("a valid animation lints clean", () => {
  const r = lintPart(withAnim("v", { x: valid }));
  expect(ids(r).filter((i) => i.startsWith("animation"))).toEqual([]);
});

test("animations must be a plain object of plain objects", () => {
  expect(ids(lintPart(base({ views: { v: { label: "V", animations: [] } } })))).toContain("animations-not-object");
  expect(ids(lintPart(withAnim("v", { x: 5 })))).toContain("animations-not-object");
});

test("animations-not-object reports at the view-owned path", () => {
  const f = findingsFor(base({ views: { v: { label: "V", animations: [] } } }), "animations-not-object");
  expect(f[0].path).toBe("views.v.animations");
  expect(findingsFor(withAnim("v", { x: 5 }), "animations-not-object")[0].path).toBe("views.v.animations.x");
});

test("tracks XOR steps", () => {
  expect(ids(lintPart(withAnim("v", { x: { duration: 1 } })))).toContain("animation-tracks-or-steps");
  expect(ids(lintPart(withAnim("v", { x: { duration: 1, tracks: { a: [[0, 0], [1, 1]] }, steps: [] } }))))
    .toContain("animation-tracks-or-steps");
});

test("track params must exist and be numeric", () => {
  expect(ids(lintPart(withAnim("v", { x: { duration: 1, tracks: { nope: [[0, 0], [1, 1]] } } }))))
    .toContain("animation-unknown-param");
  expect(ids(lintPart(withAnim("v", { x: { duration: 1, tracks: { txt: [[0, 0], [1, 1]] } } }))))
    .toContain("animation-param-not-numeric");
});

test("keyframes: sorted, 0/1 endpoints, finite pairs", () => {
  for (const kf of [[[0, 0]], [[0.2, 0], [1, 1]], [[0, 0], [0.9, 1]], [[0, 0], [0.5, 1], [0.4, 2], [1, 3]], [[0, 0], [1, "x"]]]) {
    expect(ids(lintPart(withAnim("v", { x: { duration: 1, tracks: { a: kf } } })))).toContain("animation-keyframes-invalid");
  }
});

test("keyframe values must sit inside the control's range", () => {
  expect(ids(lintPart(withAnim("v", { x: { duration: 1, tracks: { a: [[0, 0], [1, 500]] } } }))))
    .toContain("animation-value-out-of-range");
});

test("durations positive; loop only on single-step; labels unique; easing known; description a string", () => {
  expect(ids(lintPart(withAnim("v", { x: { duration: 0, tracks: { a: [[0, 0], [1, 1]] } } }))))
    .toContain("animation-duration-invalid");
  expect(ids(lintPart(withAnim("v", { x: { loop: true, steps: [
    { label: "one", duration: 1, tracks: { a: [[0, 0], [1, 1]] } },
    { label: "two", duration: 1, tracks: { a: [[0, 1], [1, 0]] } },
  ] } })))).toContain("animation-loop-invalid");
  expect(ids(lintPart(withAnim("v", { x: { steps: [
    { label: "same", duration: 1, tracks: { a: [[0, 0], [1, 1]] } },
    { label: "same", duration: 1, tracks: { a: [[0, 1], [1, 0]] } },
  ] } })))).toContain("animation-step-label-duplicate");
  expect(ids(lintPart(withAnim("v", { x: { ...valid, easing: "bouncy" } })))).toContain("animation-easing-unknown");
  expect(ids(lintPart(withAnim("v", { x: { ...valid, description: 42 } })))).toContain("animation-description-invalid");
});

test("camera: canonical names, sorted in-range cues, one mechanism per animation", () => {
  expect(ids(lintPart(withAnim("v", { x: { ...valid, camera: "sideways" } })))).toContain("animation-camera-invalid");
  expect(ids(lintPart(withAnim("v", { x: { ...valid, camera: [[0.5, "iso"], [0.2, "front"]] } })))).toContain("animation-camera-invalid");
  expect(ids(lintPart(withAnim("v", { x: { ...valid, camera: [[0, "iso"], [2, "front"]] } })))).toContain("animation-camera-invalid");
  expect(ids(lintPart(withAnim("v", { x: { camera: "iso", steps: [
    { label: "one", camera: "front", duration: 1, tracks: { a: [[0, 0], [1, 1]] } },
  ] } })))).toContain("animation-camera-invalid");
  // valid forms stay clean
  expect(ids(lintPart(withAnim("v", { x: { ...valid, camera: [[0, "iso"], [0.5, "front"]] } })))
    .filter((i) => i === "animation-camera-invalid")).toEqual([]);  // view-cube corners and edges are camera angles too
  expect(ids(lintPart(withAnim("v", { x: { ...valid, camera: [[0, "top-front-left"], [0.5, "back-right"]] } })))
    .filter((i) => i === "animation-camera-invalid")).toEqual([]);
  expect(ids(lintPart(withAnim("v", { x: { ...valid, camera: "top-left-front" } })))).toContain("animation-camera-invalid");
});

test("classification: pose-only tracks are silent, geometry tracks get a note", () => {
  const poseOnly = base({
    parts: { p: { views: ["v"],
      build: (k) => k.box({ size: [10, 10, 10] }),
      place: (s, { p }) => s.rotate(-p.a, [0, 0, 0], [1, 0, 0]),
    } },
    views: { v: { label: "V", animations: { x: { duration: 1, tracks: { a: [[0, 0], [1, 100]] } } } } },
  });
  expect(lintPart(poseOnly).notes.map((f) => f.rule)).toEqual([]);

  const rebuilds = base({
    parts: { p: { views: ["v"], build: (k, p) => k.box({ size: [10, 10, 10 + p.a] }) } },
    views: { v: { label: "V", animations: { x: { duration: 1, tracks: { a: [[0, 0], [1, 100]] } } } } },
  });
  const notes = lintPart(rebuilds).notes;
  expect(notes.map((f) => f.rule)).toContain("animation-track-rebuilds");
  expect(notes[0].severity).toBe("note");
});

test("classification: a round-trip track on a geometry param still gets a note", () => {
  const rebuilds = base({
    parts: { p: { views: ["v"], build: (k, p) => k.box({ size: [10, 10, 10 + p.a] }) } },
    views: { v: { label: "V", animations: { x: { duration: 1, tracks: { a: [[0, 0], [0.5, 100], [1, 0]] } } } } },
  });
  const r = lintPart(rebuilds);
  expect(r.notes.map((f) => f.rule)).toContain("animation-track-rebuilds");
  expect(r.ok).toBe(true); // notes never gate
});

test("classification: a round-trip track on a pose-only param stays silent", () => {
  const poseOnly = base({
    parts: { p: { views: ["v"],
      build: (k) => k.box({ size: [10, 10, 10] }),
      place: (s, { p }) => s.rotate(-p.a, [0, 0, 0], [1, 0, 0]),
    } },
    views: { v: { label: "V", animations: { x: { duration: 1, tracks: { a: [[0, 0], [0.5, 100], [1, 0]] } } } } },
  });
  expect(lintPart(poseOnly).notes.map((f) => f.rule)).toEqual([]);
});

test("classification probes only the owning view's sub-parts", () => {
  // `lid` rebuilds on `a`, but it lives in view "other" — the animation in view
  // "v" cannot make it move, so classifying that track against it would be a
  // false note.
  const part = base({
    parts: {
      p: { views: ["v"],
        build: (k) => k.box({ size: [10, 10, 10] }),
        place: (s, { p }) => s.rotate(-p.a, [0, 0, 0], [1, 0, 0]),
      },
      lid: { views: ["other"], build: (k, p) => k.box({ size: [10, 10, 10 + p.a] }) },
    },
    views: {
      v: { label: "V", animations: { x: { duration: 1, tracks: { a: [[0, 0], [1, 100]] } } } },
      other: { label: "O" },
    },
  });
  expect(findingsFor(part, "animation-track-rebuilds")).toHaveLength(0);
});

test("autoplay must be boolean and unique", () => {
  expect(ids(lintPart(withAnim("v", { x: { ...valid, autoplay: "yes" } })))).toContain("animation-autoplay-invalid");
  const two = withAnim("v", {
    a: { duration: 1, autoplay: true, tracks: { a: [[0, 0], [1, 1]] } },
    b: { duration: 1, autoplay: true, tracks: { a: [[0, 1], [1, 0]] } },
  });
  expect(ids(lintPart(two))).toContain("animation-autoplay-invalid");
  expect(ids(lintPart(withAnim("v", { x: { ...valid, autoplay: true } }))).filter((i) => i === "animation-autoplay-invalid")).toEqual([]);
});

test("an easing named after an Object.prototype member is rejected", () => {
  // `easing in EASINGS` is true for every prototype member, so an `in`-based
  // check waved these through to a runtime that then threw mid-frame.
  for (const easing of ["__proto__", "toString", "constructor", "isPrototypeOf"]) {
    const r = lintPart(withAnim("v", { x: { ...valid, easing } }));
    expect(ids(r), `easing: ${easing}`).toContain("animation-easing-unknown");
  }
});

// --- lint and the runtime have to agree about what a valid block is -----------

const twoStep = (extra) => ({ ...extra, steps: [
  { label: "One", duration: 1, tracks: { a: [[0, 0], [1, 50]] } },
  { label: "Two", duration: 1, tracks: { a: [[0, 50], [1, 100]] } },
] });

test("a truthy non-boolean `loop` is rejected, not waved through", () => {
  // The runtime fails closed, so `loop: 1` silently means "don't loop" rather than
  // looping — the author still needs to be told the value was not understood.
  for (const loop of [1, "yes", {}, []]) {
    expect(ids(lintPart(withAnim("v", { x: twoStep({ loop }) }))), `loop: ${JSON.stringify(loop)}`)
      .toContain("animation-loop-invalid");
  }
  expect(ids(lintPart(withAnim("v", { x: { ...valid, loop: false } })))).not.toContain("animation-loop-invalid");
  expect(ids(lintPart(withAnim("v", { x: { ...valid, loop: true } })))).not.toContain("animation-loop-invalid");
});

test("a truthy non-boolean `loop` is caught on a SINGLE-step animation too", () => {
  // The multi-step rule would flag `loop: 1` anyway (it tests truthiness), so this
  // single-phase case is what actually pins the type check: nothing else can fire.
  expect(ids(lintPart(withAnim("v", { x: { ...valid, loop: 1 } })))).toContain("animation-loop-invalid");
  expect(ids(lintPart(withAnim("v", { x: { ...valid, loop: "yes" } })))).toContain("animation-loop-invalid");
});

test("a non-boolean `loop` reports once, not twice", () => {
  const found = ids(lintPart(withAnim("v", { x: twoStep({ loop: 1 }) }))).filter((i) => i === "animation-loop-invalid");
  expect(found).toHaveLength(1); // the type error supersedes the multi-step check
});

test("a camera-only step is allowed — it holds the pose and moves the camera", () => {
  const part = withAnim("v", { x: { steps: [
    { label: "Look", camera: "iso", duration: 1 },
    { label: "Move", duration: 1, tracks: { a: [[0, 0], [1, 100]] } },
  ] } });
  expect(ids(lintPart(part))).not.toContain("animation-tracks-or-steps");
});

test("an animation where no step has tracks is still rejected", () => {
  const part = withAnim("v", { x: { steps: [
    { label: "Look", camera: "iso", duration: 1 },
    { label: "Also look", camera: "front", duration: 1 },
  ] } });
  expect(ids(lintPart(part))).toContain("animation-tracks-or-steps");
});

test("an explicit `camera: null` reads as no camera, not as a malformed one", () => {
  const part = withAnim("v", { x: { camera: null, steps: [
    { label: "One", camera: "iso", duration: 1, tracks: { a: [[0, 0], [1, 50]] } },
    { label: "Two", camera: "front", duration: 1, tracks: { a: [[0, 50], [1, 100]] } },
  ] } });
  expect(ids(lintPart(part))).not.toContain("animation-camera-invalid");
});

// --- view-owned animations + opacity (spec 2026-08-10-per-view-animations) ----

test("every animation finding path is view-scoped", () => {
  const f = findingsFor(withAnim("v", { x: { duration: 1 } }), "animation-tracks-or-steps");
  expect(f[0].path).toBe("views.v.animations.x");
});

test("animation-not-in-view: top-level animations are an error", () => {
  const part = base({ animations: { open: { duration: 1, tracks: { w: [[0, 0], [1, 1]] } } } });
  const f = findingsFor(part, "animation-not-in-view");
  expect(f).toHaveLength(1);
  expect(f[0].severity).toBe("error");
  expect(f[0].path).toBe("animations");
  expect(f[0].hint).toMatch(/views\.<name>\.animations/);
});

test("animation-opacity-unknown-part: opacity keys must be sub-parts of the owning view", () => {
  // lid exists but is not in view "v"; ghost doesn't exist at all
  const part = base({
    parts: { base: { views: ["v"], build: () => {} }, lid: { views: ["other"], build: () => {} } },
    views: {
      v: { label: "V", animations: { a: { duration: 1, opacity: { lid: [[0, 0], [1, 1]], ghost: [[0, 0], [1, 1]] } } } },
      other: { label: "O" },
    },
  });
  const f = findingsFor(part, "animation-opacity-unknown-part");
  expect(f.map((x) => x.path)).toEqual([
    "views.v.animations.a.opacity.lid",
    "views.v.animations.a.opacity.ghost",
  ]);
});

test("animation-opacity-range: values outside 0..1 are an error", () => {
  const part = withAnim("v", { a: { duration: 1, opacity: { base: [[0, 0], [1, 1.5]] } } });
  expect(findingsFor(part, "animation-opacity-range")).toHaveLength(1);
});

test("opacity keyframe SHAPE problems reuse animation-keyframes-invalid", () => {
  const part = withAnim("v", { a: { duration: 1, opacity: { base: [[0.2, 0], [1, 1]] } } }); // doesn't start at 0
  const f = findingsFor(part, "animation-keyframes-invalid");
  expect(f.map((x) => x.path)).toContain("views.v.animations.a.opacity.base");
});

test("a mis-shaped opacity track is not ALSO reported as out of range", () => {
  // animation-opacity-range only walks valid-shaped keyframes; the shape rule owns it.
  const part = withAnim("v", { a: { duration: 1, opacity: { p: [[0, 0], [1, 9]] } } });
  expect(findingsFor(part, "animation-opacity-range")).toHaveLength(1);
  const bad = withAnim("v", { a: { duration: 1, opacity: { p: [[0.2, 0], [1, 9]] } } });
  expect(findingsFor(bad, "animation-opacity-range")).toHaveLength(0);
});

test("an opacity-only animation is NOT 'animates nothing'", () => {
  const part = withAnim("v", { a: { duration: 1, opacity: { base: [[0, 0], [1, 1]] } } });
  expect(findingsFor(part, "animation-tracks-or-steps")).toHaveLength(0);
});

test("a step with only opacity is legal; a step with nothing is not", () => {
  const part = withAnim("v", { a: { steps: [
    { label: "Fade", duration: 1, opacity: { base: [[0, 0], [1, 1]] } },
    { label: "Empty", duration: 1 },
  ] } });
  const f = findingsFor(part, "animation-tracks-or-steps");
  expect(f).toHaveLength(1);
  expect(f[0].path).toBe("views.v.animations.a.steps[1].tracks");
});

test("opacity keys are sub-parts, not params — the param rules never walk them", () => {
  // "p" is a real sub-part of view "v" but is NOT in `defaults`; if the param
  // rules walked opacity it would read as an unknown/non-numeric param.
  const found = ids(lintPart(withAnim("v", { a: { duration: 1, opacity: { p: [[0, 0], [1, 1]] } } })));
  expect(found).not.toContain("animation-unknown-param");
  expect(found).not.toContain("animation-param-not-numeric");
  expect(found).not.toContain("animation-value-out-of-range");
});

test("autoplay is per view: two views may each declare one", () => {
  const part = base({
    views: {
      a: { label: "A", animations: { x: { duration: 1, autoplay: true, tracks: { w: [[0, 0], [1, 1]] } } } },
      b: { label: "B", animations: { y: { duration: 1, autoplay: true, tracks: { w: [[0, 0], [1, 1]] } } } },
    },
  });
  expect(findingsFor(part, "animation-autoplay-invalid")).toHaveLength(0);
});

// Place-only pose (spec 2026-10-03-place-only-pose §8): the place-scope probe
// decides whether a track can play at frame rate; build() may query freely.
const trackNotes = (r) => r.notes.filter((f) => f.rule === "animation-track-rebuilds");
const latticeWithTracks = (tracks) => ({ ...lattice, views: { assembly: { ...lattice.views.assembly,
  animations: { cycle: { label: "Cycle", duration: 2, tracks } } } } });

test("the Lattice Lid (#161): a querying build behind a rigid place() earns no rebuild note", () => {
  const r = lintPart(lattice);
  expect(r.errors).toEqual([]);
  expect(trackNotes(r)).toEqual([]);
});

test("a place() the probe cannot read earns the untrusted note, and only that case does", () => {
  const part = { ...lattice, parts: { ...lattice.parts, insert: { ...lattice.parts.insert,
    place: (s, { p }) => s.translate([0, 0, p.lift + s.boundingBox().size[2]]) } } };
  const n = trackNotes(lintPart(part));
  expect(n.map((f) => f.message)).toEqual(expect.arrayContaining([expect.stringContaining("place()` cannot be probed")]));
  // the readable lid place beside it does not change that; the untrusted note is the only kind here
  expect(n.every((f) => f.message.includes("cannot be probed"))).toBe(true);
  expect(n[0].hint).toMatch(/`build\(\)` may query freely/);
});

test("a track read by build() earns the rebuild note (build-scope hash moves)", () => {
  // `wall` feeds the body's and the lid's query-free builds, so their build-scope
  // hashes differ between the keyframe values.
  const n = trackNotes(lintPart(latticeWithTracks({ wall: [[0, 2], [1, 3]] })));
  expect(n).toHaveLength(1);
  expect(n[0].message).toContain('track "wall" rebuilds geometry');
});

test("a track read by an untrusted build earns the rebuild note by its recorded read", () => {
  // Only the insert reads cellR, and its build queries (untrusted build probe) —
  // the note comes from the read the probe recorded, not from a hash.
  const n = trackNotes(lintPart(latticeWithTracks({ cellR: [[0, 2], [1, 3]] })));
  expect(n).toHaveLength(1);
  expect(n[0].message).toContain('track "cellR" rebuilds geometry');
});

test("a param no build() reads plays as a pose even behind an untrusted build", () => {
  expect(trackNotes(lintPart(latticeWithTracks({ openAngle: [[0, 0], [1, 90]] })))).toEqual([]);
});

test("a readable place() that reshapes on both purposes still classifies pose-only tracks as poses", () => {
  // posed delivery: the full-scope delta fast path plays it, as before
  const part = base({
    parts: { p: { views: ["v"], build: (k) => k.box({ size: [10, 10, 10] }),
      place: (s, { p }) => s.scale(2).rotate(-p.a, [0, 0, 0], [1, 0, 0]) } },
    views: { v: { label: "V", animations: { x: { duration: 1, tracks: { a: [[0, 0], [1, 100]] } } } } },
  });
  expect(findingsFor(part, "animation-track-rebuilds")).toEqual([]);
});
