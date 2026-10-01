// applyKerf's guard against the failures the real offset engine rarely produces on
// demand: the engine throwing, an arc consumed, a region split. Kept in its own file
// because it mocks contour-offset.js for every module this file loads (the house
// pattern — see test/inspect-single-build.test.js).
import { expect, test, vi } from "vitest";

const offsetMode = vi.hoisted(() => ({ mode: "real" }));
vi.mock("../src/framework/geometry/contour-offset.js", async (importOriginal) => {
  const real = await importOriginal();
  const lines = (ring) => ({ start: ring.start, segments: ring.segments.map((s) => ({ to: s.to })) });
  return {
    ...real,
    offsetRegions: (regions, delta, opts) => {
      if (offsetMode.mode === "throw") throw new Error("Shape2D.offset: could not close the offset outline");
      const out = real.offsetRegions(regions, delta, opts);
      if (offsetMode.mode === "strip-arcs") return out.map((rg) => ({ outer: lines(rg.outer), holes: rg.holes.map(lines) }));
      if (offsetMode.mode === "split") return [...out, ...out];
      return out;
    },
  };
});

const { applyKerf } = await import("../src/framework/export/drawing.js");

// one region with an exact-arc hole: rectangle 40 × 30, circle r 5 at (20, 15)
const plate = [{
  outer: { start: [0, 0], segments: [{ to: [40, 0] }, { to: [40, 30] }, { to: [0, 30] }, { to: [0, 0] }] },
  holes: [{ start: [25, 15], segments: [{ to: [15, 15], via: [20, 10] }, { to: [25, 15], via: [20, 20] }] }],
}];
const INTACT = 'cut kit options: kerf 0.20 mm could not keep the outline of "Lid" intact — lower kerf, or set it to 0 and compensate in your laser software';

test("the real engine passes the guard", () => {
  offsetMode.mode = "real";
  expect(() => applyKerf(plate, 0.2, { label: "Lid" })).not.toThrow();
});

test("an offset that throws becomes the named options error, with the engine's error as its cause", () => {
  offsetMode.mode = "throw";
  let err;
  try { applyKerf(plate, 0.2, { label: "Lid" }); } catch (e) { err = e; }
  expect(err.message).toBe(INTACT);
  expect(err.cause.message).toBe("Shape2D.offset: could not close the offset outline");
});

test("an offset that loses arcs is refused", () => {
  offsetMode.mode = "strip-arcs";
  expect(() => applyKerf(plate, 0.2, { label: "Lid" })).toThrow(INTACT);
});

test("an offset that splits a region is refused", () => {
  offsetMode.mode = "split";
  expect(() => applyKerf(plate, 0.2, { label: "Lid" })).toThrow(INTACT);
});
