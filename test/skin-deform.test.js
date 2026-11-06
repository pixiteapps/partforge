import { expect, test } from "vitest";
import { frameMotions, skinVertices } from "../src/framework/skin/deform.js";
import { implicitCallId } from "../src/framework/geometry/implicit/call-id.js";
import { xformPoint, xformDir } from "../src/framework/geometry/xform.js";
import { TWO_BONE } from "./fixtures/skin-fixtures.js";

const id = implicitCallId(TWO_BONE(0), []);
const frames = [null, `${id}:root`, `${id}:child`];

// Two triangles: corners 0-2 on root (frame 1), 3-5 on child (frame 2).
const positions = Float32Array.of(0, 1, 0, 1, 2, 0, 0, 3, 1, 0, 25, 0, 1, 26, 0, 0, 27, 1);
const normals = Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 1);
const mkBase = (frameB = [0, 0, 0, 0, 0, 0], weight = [1, 1, 1, 1, 1, 1]) => ({
  positions, normals,
  bindings: {
    frameA: Uint16Array.of(1, 1, 1, 2, 2, 2),
    frameB: Uint16Array.from(frameB),
    weight: Float32Array.from(weight),
    frames,
  },
});
const blank = () => ({ positions: new Float32Array(18), normals: new Float32Array(18) });

test("a pure rotation of one frame moves exactly that bone's corners by that rotation", () => {
  const motions = frameMotions([TWO_BONE(0)], [TWO_BONE(90)], frames);
  const out = skinVertices(mkBase(), motions, blank());
  for (let i = 0; i < 9; i++) {
    expect(out.positions[i]).toBe(positions[i]);
    expect(out.normals[i]).toBe(normals[i]);
  }
  const t = [0, 0, 0];
  for (let c = 3; c < 6; c++) {
    xformPoint(t, motions[2], positions[c * 3], positions[c * 3 + 1], positions[c * 3 + 2]);
    for (let k = 0; k < 3; k++) expect(Math.abs(out.positions[c * 3 + k] - t[k])).toBeLessThan(1e-4);
    xformDir(t, motions[2], normals[c * 3], normals[c * 3 + 1], normals[c * 3 + 2]);
    for (let k = 0; k < 3; k++) expect(Math.abs(out.normals[c * 3 + k] - t[k])).toBeLessThan(1e-6);
  }
  // 90 degrees about x at (0,20,0): (0,25,0) -> (0,20,5)
  expect(out.positions[10]).toBeCloseTo(20, 4);
  expect(out.positions[11]).toBeCloseTo(5, 4);
});

test("deforming twice from one base gives identical results and leaves the base untouched", () => {
  const motions = frameMotions([TWO_BONE(0)], [TWO_BONE(40)], frames);
  const base = mkBase([2, 2, 2, 1, 1, 1], [0.5, 0.25, 0.75, 0.5, 0.5, 0.5]);
  const before = Buffer.from(positions.buffer.slice(0)).toString("hex");
  const a = skinVertices(base, motions, blank());
  const b = skinVertices(base, motions, blank());
  expect(Buffer.from(a.positions.buffer).equals(Buffer.from(b.positions.buffer))).toBe(true);
  expect(Buffer.from(a.normals.buffer).equals(Buffer.from(b.normals.buffer))).toBe(true);
  expect(Buffer.from(positions.buffer).toString("hex")).toBe(before);
});

test("a blended corner is the weighted mix of both motions", () => {
  const motions = frameMotions([TWO_BONE(0)], [TWO_BONE(90)], frames);
  const base = mkBase([2, 0, 0, 0, 0, 0], [0.25, 1, 1, 1, 1, 1]);
  const out = skinVertices(base, motions, blank());
  const pa = [0, 0, 0], pb = [0, 0, 0];
  xformPoint(pa, motions[1], 0, 1, 0);
  xformPoint(pb, motions[2], 0, 1, 0);
  for (let k = 0; k < 3; k++) expect(out.positions[k]).toBeCloseTo(0.25 * pa[k] + 0.75 * pb[k], 5);
  const nl = Math.hypot(out.normals[0], out.normals[1], out.normals[2]);
  expect(nl).toBeCloseTo(1, 5);
});

test("unbound corners and corners naming a missing motion stay put", () => {
  const motions = frameMotions([TWO_BONE(0)], [TWO_BONE(90)], frames);
  const base = mkBase();
  base.bindings.frameA = Uint16Array.of(0, 1, 1, 2, 2, 2);
  motions[2] = null;
  const out = skinVertices(base, motions, blank());
  for (const c of [0, 3, 4, 5]) {
    for (let k = 0; k < 3; k++) {
      expect(out.positions[c * 3 + k]).toBe(positions[c * 3 + k]);
      expect(out.normals[c * 3 + k]).toBe(normals[c * 3 + k]);
    }
  }
});

test("frameMotions is null when a frame or call is missing from the live specs", () => {
  const noChild = { ...TWO_BONE(90), frames: { root: { at: [0, 0, 0] } } };
  expect(frameMotions([TWO_BONE(0)], [noChild], frames)).toBeNull();
  expect(frameMotions([TWO_BONE(0)], [], frames)).toBeNull();
  expect(frameMotions([TWO_BONE(0)], [TWO_BONE(90)], [null, "nope:root"])).toBeNull();
});
