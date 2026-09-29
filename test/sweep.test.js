import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { sweepMesh, resolveSweepStations } from "../src/framework/geometry/sweep.js";
import { circlePolygon } from "../src/framework/geometry/polygon.js";

let wasm;
beforeAll(async () => { wasm = await Module(); wasm.setup(); });

const w = 6;
const SQ = [[-w / 2, -w / 2], [w / 2, -w / 2], [w / 2, w / 2], [-w / 2, w / 2]];
const L = 20;

test("sweepMesh builds watertight manifolds for straight, mitered, and arc-fan paths (ofMesh does not throw)", () => {
  expect(() => sweepMesh(wasm, SQ, [[0, 0, 0], [0, 0, L]])).not.toThrow();                        // straight
  expect(() => sweepMesh(wasm, SQ, [[-L, 0, 0], [0, 0, 0], [0, L, 0]])).not.toThrow();            // sharp miter
  expect(() => sweepMesh(wasm, circlePolygon(3), [[0, 0, 0], [0, 0, L], [L, 0, L]], { cornerRadius: 6 })).not.toThrow(); // arc fan
});

test("sweep is oriented outward: subtracting it from an enclosing blank REMOVES material", () => {
  const blank = wasm.Manifold.cube([80, 80, 40], true);
  const cut = blank.subtract(sweepMesh(wasm, SQ, [[-L, 0, 0], [0, 0, 0], [0, L, 0]]));
  expect(cut.volume()).toBeLessThan(blank.volume()); // an un-corrected inverted winding would ADD material
});

// ── resolveSweepStations (pure — fold + validation, no WASM) ─────────────────────
test("resolveSweepStations emits one station per vertex for a sharp-miter open path", () => {
  const { stations, closed } = resolveSweepStations(SQ, [[-L, 0, 0], [0, 0, 0], [0, L, 0]]);
  expect(stations.length).toBe(3); // start + corner + end
  expect(closed).toBe(false);
  for (const ring of stations) expect(ring.length).toBe(SQ.length); // shared vertex count N
});

test("resolveSweepStations validates profile, path, and zero-length segments", () => {
  expect(() => resolveSweepStations([[0, 0], [1, 1]], [[0, 0, 0], [0, 0, 1]])).toThrow(/≥3/);
  expect(() => resolveSweepStations(SQ, [[0, 0, 0]])).toThrow(/≥2/);
  expect(() => resolveSweepStations(SQ, [[0, 0, 0], [0, 0, 0]])).toThrow(/zero length/);
  expect(() => resolveSweepStations(SQ, [[0, 0, 0], [0, 0, NaN]])).toThrow(/finite/);
});

test("resolveSweepStations throws on a 180° reversal (ambiguous miter)", () => {
  expect(() => resolveSweepStations(SQ, [[-L, 0, 0], [0, 0, 0], [-L, 0, 0]])).toThrow(/180°|reversal/);
});

test("resolveSweepStations throws when the profile is too wide for a sharp bend (fold guard)", () => {
  // a tight L: profile half-width (~4.24) reach across a 90° miter vs a very short leg
  expect(() => resolveSweepStations(SQ, [[-3, 0, 0], [0, 0, 0], [0, 3, 0]])).toThrow(/too wide|too sharp/);
});

test("resolveSweepStations throws when cornerRadius is below the profile half-width (inner-wall fold)", () => {
  // circlePolygon(3) → half-width 3; a 2mm corner radius would fold the inner wall
  expect(() => resolveSweepStations(circlePolygon(3), [[-L, 0, 0], [0, 0, 0], [0, L, 0]], { cornerRadius: 2 }))
    .toThrow(/half-width|fold/);
});

test("resolveSweepStations throws when cornerRadius is too large for the segments", () => {
  expect(() => resolveSweepStations(circlePolygon(3), [[-6, 0, 0], [0, 0, 0], [0, 6, 0]], { cornerRadius: 12 }))
    .toThrow(/too large|shorter segment/);
});
