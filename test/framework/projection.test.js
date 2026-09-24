// The perspective <-> orthographic framing pair. Getting this wrong is visible
// as a jump in part size the instant the user hits the projection toggle, so
// the round trip is asserted in both directions and through a dolly.
import { describe, expect, it } from "vitest";
import { orthoFrustum, perspectiveDistance, isFaceAligned, isFaceAlignedState, hasLeftAxis } from "../../src/framework/projection.js";

const FOV = 45;

describe("orthoFrustum", () => {
  it("matches the perspective frustum's half-height at the target distance", () => {
    const { halfH } = orthoFrustum({ fovDeg: FOV, distance: 100, aspect: 1 });
    expect(halfH).toBeCloseTo(100 * Math.tan((FOV * Math.PI) / 360), 10);
  });

  it("widens with aspect and leaves the height alone", () => {
    const square = orthoFrustum({ fovDeg: FOV, distance: 50, aspect: 1 });
    const wide = orthoFrustum({ fovDeg: FOV, distance: 50, aspect: 2 });
    expect(wide.halfH).toBeCloseTo(square.halfH, 10);
    expect(wide.halfW).toBeCloseTo(square.halfW * 2, 10);
  });

  it("emits a symmetric frustum", () => {
    const f = orthoFrustum({ fovDeg: FOV, distance: 30, aspect: 1.5 });
    expect(f.left).toBeCloseTo(-f.right, 12);
    expect(f.bottom).toBeCloseTo(-f.top, 12);
    expect(f.right).toBeCloseTo(f.halfW, 12);
    expect(f.top).toBeCloseTo(f.halfH, 12);
  });
});

describe("perspectiveDistance", () => {
  it("round-trips an unzoomed frustum back to the original distance", () => {
    const { halfH } = orthoFrustum({ fovDeg: FOV, distance: 137.5, aspect: 1.77 });
    expect(perspectiveDistance({ halfH, zoom: 1, fovDeg: FOV })).toBeCloseTo(137.5, 8);
  });

  it("treats an ortho zoom as a proportionally closer camera", () => {
    const { halfH } = orthoFrustum({ fovDeg: FOV, distance: 100, aspect: 1 });
    expect(perspectiveDistance({ halfH, zoom: 2, fovDeg: FOV })).toBeCloseTo(50, 8);
    expect(perspectiveDistance({ halfH, zoom: 0.5, fovDeg: FOV })).toBeCloseTo(200, 8);
  });

  it("defaults zoom to 1", () => {
    const { halfH } = orthoFrustum({ fovDeg: FOV, distance: 42, aspect: 1 });
    expect(perspectiveDistance({ halfH, fovDeg: FOV })).toBeCloseTo(42, 8);
  });
});

// Automatic projection: ortho only on a face view, left by a rotation.
describe("isFaceAligned", () => {
  it("accepts the six axes, at any length", () => {
    for (const d of [[1, 0, 0], [-3, 0, 0], [0, 2, 0], [0, -1, 0], [0, 0, 9], [0, 0, -1]]) {
      expect(isFaceAligned(d)).toBe(true);
    }
  });
  it("accepts OrbitControls' 1e-6 rad pole clamp, rejects edges, corners and a visible tilt", () => {
    expect(isFaceAligned([Math.sin(1e-6), Math.cos(1e-6), 0])).toBe(true);
    expect(isFaceAligned([1, 1, 0])).toBe(false);
    expect(isFaceAligned([1, 1, 1])).toBe(false);
    const oneDeg = (Math.PI / 180);
    expect(isFaceAligned([Math.sin(oneDeg), 0, Math.cos(oneDeg)])).toBe(false);
  });
  it("rejects the degenerate and the malformed", () => {
    expect(isFaceAligned([0, 0, 0])).toBe(false);
    expect(isFaceAligned([NaN, 0, 1])).toBe(false);
    expect(isFaceAligned(null)).toBe(false);
  });
});

describe("isFaceAlignedState", () => {
  it("reads a { pos, target } camera state", () => {
    expect(isFaceAlignedState({ pos: [5, 5, 40], target: [5, 5, 0] })).toBe(true);
    expect(isFaceAlignedState({ pos: [18, 12, 18], target: [0, 0, 0] })).toBe(false);
  });
  it("is false for a missing or malformed state", () => {
    expect(isFaceAlignedState(null)).toBe(false);
    expect(isFaceAlignedState({ pos: [0, 0, 1] })).toBe(false);
    expect(isFaceAlignedState({ pos: [0, 1], target: [0, 0, 0] })).toBe(false);
  });
});

describe("hasLeftAxis", () => {
  it("is false for the same direction at any length (a pan or an ortho zoom)", () => {
    expect(hasLeftAxis([0, 0, 50], [0, 0, 1])).toBe(false);
  });
  it("is true once the direction turns past half a degree", () => {
    const tilt = (deg) => [Math.sin((deg * Math.PI) / 180), 0, Math.cos((deg * Math.PI) / 180)];
    expect(hasLeftAxis(tilt(0.4), [0, 0, 1])).toBe(false);
    expect(hasLeftAxis(tilt(0.6), [0, 0, 1])).toBe(true);
  });
});
