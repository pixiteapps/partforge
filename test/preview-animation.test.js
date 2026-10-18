import { expect, test } from "vitest";
import hingedBox from "../src/parts/hinged-box.js";
import { samplePreviewAnimation, PREVIEW_SAMPLE_CAP } from "../src/framework/preview-animation.js";
import { composePose } from "../src/framework/geometry/pose.js";

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

test("a tracked key the build read makes the animation unbakeable", () => {
  const reads = (name) => (name === "lid" ? new Set(["width", "lidAngle"]) : new Set(["width"]));
  expect(samplePreviewAnimation(hingedBox, "box", {}, { buildReads: reads })).toBeNull();
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
