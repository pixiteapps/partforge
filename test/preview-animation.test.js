import { describe, expect, test } from "vitest";
import hingedBox from "../src/parts/hinged-box.js";
import { samplePreviewAnimation, PREVIEW_SAMPLE_CAP } from "../src/framework/preview-animation.js";
import { composePose, isRigid } from "../src/framework/geometry/pose.js";

const allReads = (part) => () => new Set(["width", "depth", "height", "wall"]); // the hinged box's build reads
// structuredClone refuses functions, so clone the two levels the tests patch by hand.
const withLid = (patch) => ({ ...hingedBox, parts: { ...hingedBox.parts, lid: { ...hingedBox.parts.lid, ...patch } } });
const withAnimations = (animations) => ({ ...hingedBox, views: { box: { ...hingedBox.views.box, animations } } });
const cycle = hingedBox.views.box.animations.cycle, assemble = hingedBox.views.box.animations.assemble, open = hingedBox.views.box.animations.open;

test("the hinged box's autoplay cycle bakes: lid moves, base holds, t spans 0..1", () => {
  const out = samplePreviewAnimation(hingedBox, "box", {}, { buildReads: allReads(hingedBox) });
  expect(out.anim.name).toBe("cycle");
  expect(out.samples[0].t).toBe(0);
  expect(out.samples.at(-1).t).toBe(1);
  expect(out.samples.length).toBeGreaterThan(30);
  expect(out.samples.length).toBeLessThanOrEqual(PREVIEW_SAMPLE_CAP);
  // the lid is open (110°) halfway through, closed at both ends
  const mid = out.samples.find((s) => Math.abs(s.t - 0.5) < 1e-9);
  expect(mid.poses.lid).not.toEqual(out.samples[0].poses.lid);
  expect(out.samples.at(-1).poses.lid.map((v) => +v.toFixed(6))).toEqual(out.samples[0].poses.lid.map((v) => +v.toFixed(6)));
  expect(out.samples[0].poses.base).toEqual(out.samples.at(-1).poses.base);
  // base is the place pose at the params handed in (defaults: lidAngle 0, lidLift 0)
  expect(out.base.lid.map((v) => +v.toFixed(6))).toEqual(composePose([{ t: "translate", v: [0, 0, 24] }]).map((v) => +v.toFixed(6)));
  expect(Object.keys(out.base).sort()).toEqual(["base", "lid"]);
});

test("samples include every track keyframe time", () => {
  const out = samplePreviewAnimation(hingedBox, "box", {}, { buildReads: allReads(hingedBox) });
  expect(out.samples.some((s) => Math.abs(s.t - 0.5) < 1e-9)).toBe(true); // cycle's middle keyframe
});

test("a view with no autoplay animation returns null", () => {
  const part = withAnimations({ open });
  expect(samplePreviewAnimation(part, "box", {}, { buildReads: allReads(part) })).toBeNull();
});

test("a tracked key that changes the build's geometry makes the animation unbakeable", () => {
  const part = withLid({ build: (k, p) => k.box({ min: [0, 0, 0], max: [p.width, p.depth, p.wall + p.lidAngle / 10] }) });
  const reads = (name) => (name === "lid" ? new Set(["width", "depth", "wall", "lidAngle"]) : new Set(["width"]));
  expect(samplePreviewAnimation(part, "box", {}, { buildReads: reads })).toBeNull();
});

// Reads over-report: with a one-function derive, a build reading any d.* is
// recorded as reading every param derive read. The geometry is the deciding test.
describe("a tracked key in the reads whose geometry never changes", () => {
  const readsLidAngle = () => new Set(["width", "lidAngle"]);
  const oneFunction = {
    ...hingedBox,
    derive: (p) => ({ w: p.width, angle: p.lidAngle }),
    parts: {
      ...hingedBox.parts,
      lid: {
        ...hingedBox.parts.lid,
        build: (k, p, d) => k.box({ min: [0, 0, 0], max: [d.w, p.depth, p.wall] }),
        views: { box: (s, p, d) => s.translate([0, 0, p.height]).rotate(-d.angle, [0, p.depth, p.height], [1, 0, 0]) },
      },
    },
  };

  test("bakes, with the same poses as reads that leave the key out", () => {
    const out = samplePreviewAnimation(oneFunction, "box", {}, { buildReads: readsLidAngle });
    const clean = samplePreviewAnimation(oneFunction, "box", {}, { buildReads: allReads(oneFunction) });
    expect(out.anim.name).toBe("cycle");
    expect(out.samples).toEqual(clean.samples);
  });

  test("a build that queries the solid cannot be shown unchanged, so it stays still", () => {
    const part = { ...oneFunction, parts: { ...oneFunction.parts, lid: {
      ...oneFunction.parts.lid,
      build: (k, p, d) => { const s = k.box({ min: [0, 0, 0], max: [d.w, p.depth, p.wall] }); return s.isEmpty() ? s : s; },
    } } };
    expect(samplePreviewAnimation(part, "box", {}, { buildReads: readsLidAngle })).toBeNull();
  });

  test("a trailing transform inside build that follows the key stays still", () => {
    // The file's mesh holds the build's own pose at the defaults; a matrix over
    // place() alone could not reproduce one that moves.
    const part = { ...oneFunction, parts: { ...oneFunction.parts, lid: {
      ...oneFunction.parts.lid,
      build: (k, p, d) => k.box({ min: [0, 0, 0], max: [d.w, p.depth, p.wall] }).translate([d.angle, 0, 0]),
    } } };
    expect(samplePreviewAnimation(part, "box", {}, { buildReads: readsLidAngle })).toBeNull();
  });

  test("a geometry change only part-way through the timeline is caught", () => {
    const part = { ...oneFunction, parts: { ...oneFunction.parts, lid: {
      ...oneFunction.parts.lid,
      build: (k, p, d) => k.box({ min: [0, 0, 0], max: [d.w, p.depth, d.angle > 100 ? 9 : p.wall] }),
    } } };
    expect(samplePreviewAnimation(part, "box", {}, { buildReads: readsLidAngle })).toBeNull();
  });
});

test("unknown build reads (null) are not bakeable", () => {
  expect(samplePreviewAnimation(hingedBox, "box", {}, { buildReads: () => null })).toBeNull();
});

test("a reshaping place() (scale) is not bakeable", () => {
  const part = withLid({ views: { box: (s, p) => s.scale([1, 1, 1 + p.lidAngle / 100]) } });
  expect(samplePreviewAnimation(part, "box", {}, { buildReads: allReads(part) })).toBeNull();
});

test("a sub-part whose enabled flag follows a tracked param is not bakeable", () => {
  const part = withLid({ enabled: (p) => p.lidAngle < 50 });
  expect(samplePreviewAnimation(part, "box", {}, { buildReads: allReads(part) })).toBeNull();
});

test("a camera-only autoplay bakes with every pose constant and an empty opacity map", () => {
  const part = withAnimations({ spin: { autoplay: true, steps: [
    { label: "a", camera: "front", duration: 1 }, { label: "b", camera: "iso", duration: 1, tracks: { lidLift: [[0, 0], [1, 0]] } },
  ] } });
  const out = samplePreviewAnimation(part, "box", {}, { buildReads: allReads(part) });
  expect(out.anim.cues.length).toBe(2);
  expect(new Set(out.samples.map((s) => JSON.stringify(s.poses.lid))).size).toBe(1);
});

test("opacity is sampled alongside poses", () => {
  const part = withAnimations({ cycle: { ...cycle, autoplay: false }, assemble: { ...assemble, autoplay: true } });
  const out = samplePreviewAnimation(part, "box", {}, { buildReads: allReads(part) });
  expect(out.samples[0].opacity.lid).toBe(0);
  expect(out.samples.at(-1).opacity.lid).toBe(1);
});

test("a long animation is capped at PREVIEW_SAMPLE_CAP samples", () => {
  const part = withAnimations({ cycle: { ...cycle, duration: 600 } });
  const out = samplePreviewAnimation(part, "box", {}, { buildReads: allReads(part) });
  expect(out.samples.length).toBeLessThanOrEqual(PREVIEW_SAMPLE_CAP);
  expect(out.samples.at(-1).t).toBe(1);
});

test("base is place() alone: a build() ending in its own translate() leaves it out", () => {
  // The sampler reads the PLACE-scope probe. The full scope would fold the
  // build's trailing translate into the pose, and the file (positions = base ·
  // build) would then apply it twice. The round trip is pinned in
  // test/framework/gltf-decode-animation.test.js.
  const part = withLid({ build: (k, p) => k.box({ min: [0, 0, 0], max: [p.width, p.depth, p.wall] }).translate([5, 3, 0]) });
  const out = samplePreviewAnimation(part, "box", {}, { buildReads: allReads(part) });
  const round = (m) => m.map((v) => +v.toFixed(6) + 0);
  expect(round(out.base.lid)).toEqual(round(composePose([{ t: "translate", v: [0, 0, 24] }])));
  const mid = out.samples.find((s) => Math.abs(s.t - 0.5) < 1e-9);
  expect(round(mid.poses.lid)).toEqual(round(composePose([
    { t: "translate", v: [0, 0, 24] }, { t: "rotate", deg: -110, center: [0, 40, 24], axis: [1, 0, 0] }, { t: "translate", v: [0, 0, 0] },
  ])));
});

// The sampler's output must always pass the encoder's refusals: an encoder throw
// costs the forge its whole preview, a null only its motion.
test.each([["a string", "slow"], ["NaN", NaN]])("a step whose duration is %s is not bakeable", (_, duration) => {
  const part = withAnimations({ spin: { autoplay: true, steps: [{ label: "a", duration, tracks: { lidAngle: [[0, 0], [1, 30]] } }] } });
  expect(samplePreviewAnimation(part, "box", {}, { buildReads: allReads(part) })).toBeNull();
});

test("a place() rotating about a zero-length axis is not bakeable", () => {
  const part = withLid({ views: { box: (s, p) => s.translate([0, 0, p.height]).rotate(-p.lidAngle, [0, p.depth, p.height], [0, 0, 0]) } });
  expect(samplePreviewAnimation(part, "box", {}, { buildReads: allReads(part) })).toBeNull();
});

test("every pose the sampler returns passes the encoder's rigidity test", () => {
  const out = samplePreviewAnimation(hingedBox, "box", {}, { buildReads: allReads(hingedBox) });
  for (const s of out.samples) for (const m of Object.values(s.poses)) expect(isRigid(m)).toBe(true);
  for (const m of Object.values(out.base)) expect(isRigid(m)).toBe(true);
});
