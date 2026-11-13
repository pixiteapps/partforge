import { expect, test } from "vitest";
import {
  screwCrossSection as sized, screwStepsPerTurn, SCREW_MAX_STEPS, SCREW_MIN_STEPS,
} from "../src/framework/geometry/screw-profile.js";
import { SAGITTA_TOL } from "../src/framework/geometry/circle-segs.js";

// The densification mechanics below are pinned at the old flat 5° (72 steps a
// turn) so their point counts stay readable; the radius sizing has its own tests
// at the bottom of the file.
const screwCrossSection = (profile, pitch, opts = {}) => sized(profile, pitch, { stepsPerTurn: 72, ...opts });

test("a constant-z segment needs no subdivision and maps to itself", () => {
  // No z change → no polar sweep → no chordal error to correct.
  expect(screwCrossSection([[5, 0], [3, 0]], 2)).toEqual([[5, 0], [3, 0]]);
});

test("densifies each segment to the polar step", () => {
  // z spans 1 of a pitch of 2 → 180 deg of sweep → 180/5 = 36 segments, 37 points,
  // and the closing edge back down sweeps the same 180 deg for 35 more (its two
  // endpoints are already in the list).
  expect(screwCrossSection([[5, 0], [5, 1]], 2)).toHaveLength(37 + 35);
});

// The profile's own last point sits at index 18: z 0 → 0.5 of pitch 2 sweeps 90 deg,
// which is 18 steps of 5 deg. The closing edge's points follow it.
const LAST_PROFILE_POINT = 18;

test("right-hand maps +z to NEGATIVE polar angle", () => {
  // z = 0.5 of pitch 2 → psi = -360 * 0.5/2 = -90 deg → [0, -5].
  const [x, y] = screwCrossSection([[5, 0], [5, 0.5]], 2)[LAST_PROFILE_POINT];
  expect(x).toBeCloseTo(0, 6);
  expect(y).toBeCloseTo(-5, 6);
});

test("lefthand mirrors the polar angle", () => {
  const out = screwCrossSection([[5, 0], [5, 0.5]], 2, { lefthand: true });
  const [x, y] = out[LAST_PROFILE_POINT];
  expect(x).toBeCloseTo(0, 6);
  expect(y).toBeCloseTo(5, 6);
});

test("a full-pitch profile is periodic: the wrap point is dropped", () => {
  // 360 deg of sweep at 5 deg = 72 points; the 73rd would land on the 1st.
  const out = screwCrossSection([[5, 0], [5, 2]], 2);
  expect(out).toHaveLength(72);
  expect(out[0][0]).toBeCloseTo(5, 6);
});

// A sub-pitch ISO-style ridge: an M10x1.5 tooth occupying the lower half of the
// pitch, so its closing edge (last point back to first) sweeps a full 180 deg of the
// unused pitch. Undensified, that edge is a straight chord across the axis and the
// ridge comes out as a twisted half-disc — the same failure class as chord-starved
// flanks, but worse: 34.70 against a true 7.19.
const PITCH = 1.5, MAJOR_R = 5;
const ROOT_R = MAJOR_R - (5 / 8) * (Math.sqrt(3) / 2) * PITCH;
const CREST_FLAT = PITCH / 8, RISE = (PITCH - CREST_FLAT - PITCH / 4) / 2;
const RIDGE = [
  [ROOT_R,  0],
  [MAJOR_R, RISE],
  [MAJOR_R, RISE + CREST_FLAT],
  [ROOT_R,  0.75],
];

const shoelace = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
};

test("a sub-pitch profile densifies its closing edge too", () => {
  // The four profile edges give 38 points; the closing edge sweeps 180 deg = 36
  // steps, contributing its 35 interior points (both its ends are already listed).
  expect(screwCrossSection(RIDGE, PITCH)).toHaveLength(38 + 35);
});

test("the closing edge carries area, not a chord across the axis", () => {
  // Exact area by polar integration of the closed contour: 7.1942. A straight
  // closing chord gives 34.7022 (+382%) — pi * 5^2 / 2, a half-disc.
  expect(shoelace(screwCrossSection(RIDGE, PITCH))).toBeCloseTo(7.1851, 3);
});

test("rejects a profile taller than the pitch", () => {
  expect(() => screwCrossSection([[4, 0], [6, 0], [6, 2.5], [4, 2.5]], 1.5))
    .toThrow(/exceeds pitch/);
});

test("a periodic profile gets NO closing-edge densification", () => {
  // Its first and last points are the same polar point one pitch apart, so a
  // densified closing edge would trace a spurious full circle around the axis.
  // 360 deg of sweep at 5 deg is 72 steps, plus one for the per-edge rounding up:
  // 73 points, byte for byte what this returned before closing edges existed.
  const ISO = [
    [ROOT_R,  0],
    [ROOT_R,  PITCH / 4],
    [MAJOR_R, PITCH / 4 + RISE],
    [MAJOR_R, PITCH / 4 + RISE + CREST_FLAT],
    [ROOT_R,  PITCH],
  ];
  expect(screwCrossSection(ISO, PITCH)).toHaveLength(73);
  expect(screwCrossSection(ISO, PITCH, { lefthand: true })).toHaveLength(73);
});

test("rejects a full-pitch profile that is not periodic", () => {
  expect(() => screwCrossSection([[5, 0], [6, 0], [4, 2]], 2))
    .toThrow(/must be periodic/);
});

test("rejects a full-pitch profile whose ends are not its extreme z", () => {
  // extent is measured over ALL points, so a middle point can make the profile
  // full-pitch while the ends agree in radius — the wrap-point drop would then
  // silently delete a real vertex.
  expect(() => screwCrossSection([[5, 0], [5, 2], [5, 1]], 2))
    .toThrow(/must start and end at its extreme z values/);
});

test("rejects a negative radius, matching revolve's rule", () => {
  expect(() => screwCrossSection([[-1, 0], [5, 0], [5, 0.5]], 2))
    .toThrow("screwSweep: profile radius must be ≥ 0");
});

test("rejects a non-positive pitch and a too-short profile", () => {
  expect(() => screwCrossSection([[5, 0], [5, 1]], 0)).toThrow(/pitch must be > 0/);
  expect(() => screwCrossSection([[5, 0]], 2)).toThrow(/at least 2/);
});

// Feedback #244: the step used to be a flat 5° whatever the radius, and a thread's
// triangle count is quadratic in it, so small threads were enormous. It is now
// sized by the print tier's chord tolerance at the profile's largest radius.
test("the step is sized by the print chord tolerance at the profile's largest radius", () => {
  const sagitta = (r, n) => r * (1 - Math.cos(Math.PI / n));
  for (const r of [1.5, 3, 6]) {
    const n = screwStepsPerTurn([[r - 0.3, 0], [r, 0.25], [r - 0.3, 0.5]]);
    expect(sagitta(r, n)).toBeLessThanOrEqual(SAGITTA_TOL.print);
    expect(sagitta(r, n - 1)).toBeGreaterThan(SAGITTA_TOL.print); // the fewest that meet it
  }
  expect(screwStepsPerTurn([[1.3, 0], [1.5, 0.25], [1.3, 0.5]])).toBe(28); // M3-sized
  expect(screwStepsPerTurn([[2.7, 0], [3, 0.5], [2.7, 1]])).toBe(39); // M6-sized
});

test("the step never gets finer than the old 5°, nor coarser than 15°", () => {
  expect(SCREW_MAX_STEPS).toBe(72);
  expect(SCREW_MIN_STEPS).toBe(24);
  expect(screwStepsPerTurn([[40, 0], [42, 1], [40, 2]])).toBe(72); // a big worm keeps its density
  expect(screwStepsPerTurn([[0.2, 0], [0.4, 0.1], [0.2, 0.2]])).toBe(24); // a tiny thread floors
  expect(screwStepsPerTurn([[0, 0], [0, 1]])).toBe(24); // no radius: the floor, never a throw
});

test("the default cross-section uses the sized step", () => {
  // A full-pitch r = 5 profile: 360° at the sized step, the wrap point dropped.
  const n = screwStepsPerTurn([[5, 0], [5, 2]]);
  expect(n).toBeLessThan(72);
  expect(sized([[5, 0], [5, 2]], 2)).toHaveLength(n);
});
