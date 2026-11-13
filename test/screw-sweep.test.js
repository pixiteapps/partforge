import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { screwStepsPerTurn } from "../src/framework/geometry/screw-profile.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

// An ISO-ish metric thread: 60 deg flanks, crest flat P/8, root flat P/4.
// PERIODIC form — spans exactly one pitch, first radius == last radius — so it
// yields the whole threaded rod in one op with no boolean. See the design spec.
const PITCH = 1.5, MAJOR_R = 5, TURNS = 6;
const H = (Math.sqrt(3) / 2) * PITCH;
const ROOT_R = MAJOR_R - (5 / 8) * H;
const CREST_FLAT = PITCH / 8, ROOT_FLAT = PITCH / 4;
const RISE = (PITCH - CREST_FLAT - ROOT_FLAT) / 2;
const ISO = [
  [ROOT_R,  0],
  [ROOT_R,  ROOT_FLAT],
  [MAJOR_R, ROOT_FLAT + RISE],
  [MAJOR_R, ROOT_FLAT + RISE + CREST_FLAT],
  [ROOT_R,  PITCH],
];

test("a periodic profile yields a watertight rod of the right size", () => {
  const rod = k.screwSweep({ profile: ISO, pitch: PITCH, turns: TURNS });
  expect(rod.genus()).toBe(0);                       // no through-holes, no fold artifacts
  const { size } = rod.boundingBox();
  expect(size[0]).toBeCloseTo(2 * MAJOR_R, 3);
  expect(size[1]).toBeCloseTo(2 * MAJOR_R, 3);
  expect(size[2]).toBeCloseTo(PITCH * TURNS, 3);
});

test("volume sits between the root and major cylinders", () => {
  // The single strongest shape check: a thread must add material over its root
  // cylinder and remove material from its major cylinder.
  const rod = k.screwSweep({ profile: ISO, pitch: PITCH, turns: TURNS });
  const h = PITCH * TURNS;
  expect(rod.volume()).toBeGreaterThan(Math.PI * ROOT_R ** 2 * h);
  expect(rod.volume()).toBeLessThan(Math.PI * MAJOR_R ** 2 * h);
});

test("volume is converged, not chord-starved", () => {
  // Regression guard for the densification bug: an undensified profile loses ~42%
  // of its volume. Doubling the turns must double the volume linearly.
  const one = k.screwSweep({ profile: ISO, pitch: PITCH, turns: 2 }).volume();
  const two = k.screwSweep({ profile: ISO, pitch: PITCH, turns: 4 }).volume();
  expect(two / one).toBeCloseTo(2, 2);
  expect(one).toBeGreaterThan(190);   // measured 195.18; a chord-starved build gives ~112
});

test("the thread advances one full turn per pitch of height", () => {
  // The crest is a FLAT PLATEAU 45 deg wide (360 * crestFlat / pitch), so the single
  // max-radius vertex in a slab is an arbitrary pick among ~120 equal-radius vertices.
  // Measure the plateau's circular mean instead — that is a stable phase.
  const rod = k.screwSweep({ profile: ISO, pitch: PITCH, turns: TURNS });
  const mesh = rod.toMesh();
  const crestPhaseAt = (zT) => {
    let sx = 0, sy = 0, n = 0;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const [x, y, z] = [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]];
      if (Math.abs(z - zT) > PITCH * 0.02) continue;
      if (Math.hypot(x, y) < MAJOR_R - 0.02) continue;   // crest plateau only
      const a = Math.atan2(y, x);
      sx += Math.cos(a); sy += Math.sin(a); n++;
    }
    if (n === 0) throw new Error(`no crest vertices found at z=${zT}`);
    return (Math.atan2(sy, sx) * 180) / Math.PI;
  };
  const z0 = (PITCH * TURNS) / 2;
  let delta = crestPhaseAt(z0 + PITCH / 4) - crestPhaseAt(z0);
  if (delta < -180) delta += 360;
  if (delta > 180) delta -= 360;
  // The crest's vertices sit on the twist divisions, so the measured phase is
  // quantized by one step (screwStepsPerTurn — 50 a turn, 7.2°, at this radius);
  // half a step either side of 90 is exact advance. Measured 93.29.
  const step = 360 / screwStepsPerTurn(ISO);
  expect(Math.abs(delta - 90)).toBeLessThan(step / 2);
});

test("lefthand mirrors the volume but reverses the advance", () => {
  const rh = k.screwSweep({ profile: ISO, pitch: PITCH, turns: TURNS });
  const lh = k.screwSweep({ profile: ISO, pitch: PITCH, turns: TURNS, lefthand: true });
  // Mirror symmetry holds in the limit, but the densified polygon is not itself
  // mirror-symmetric (densification starts at z=0 either way), so the two differ by
  // a tessellation artifact that grows with the step — measured 0.251% at the old
  // flat 5°, 0.506% at this radius's sized 7.2°. Assert relative, not absolute.
  expect(Math.abs(lh.volume() - rh.volume()) / rh.volume()).toBeLessThan(0.01);
  expect(lh.genus()).toBe(0);
});

test("an over-pitch profile is rejected rather than silently folded", () => {
  expect(() => k.screwSweep({ profile: [[4, 0], [6, 0], [6, 2.5], [4, 2.5]], pitch: 1.5, turns: 3 }))
    .toThrow(/exceeds pitch/);
});

test("a small thread is sized by its radius, not the old flat 5° (feedback #244)", () => {
  // An M3x0.5-sized rod: the step its radius needs (28 a turn) instead of 72, which
  // is ~6.5× fewer triangles for a surface still within 0.01 mm of the exact one.
  const P = 0.5, R = 1.5, h = (Math.sqrt(3) / 2) * P, root = R - (5 / 8) * h;
  const m3 = [[root, 0], [root, P / 4], [R, P / 4 + (P - P / 8 - P / 4) / 2],
    [R, P / 4 + (P - P / 8 - P / 4) / 2 + P / 8], [root, P]];
  const rod = k.screwSweep({ profile: m3, pitch: P, turns: 20 });
  expect(rod.genus()).toBe(0);
  const tris = rod.toMesh({ quality: "print" }).positions.length / 9;
  expect(tris).toBeLessThan(40000);   // measured 32,592; the old flat 5° was 210,528
  expect(rod.volume()).toBeGreaterThan(Math.PI * root ** 2 * P * 20);
});
