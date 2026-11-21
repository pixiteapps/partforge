import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing.js";

// OCCT and Manifold must not boot in the same process — hence this separate file.
//
// A tapped hole that breaks through a curved wall (a collar's dowel bore) used to
// never finish on OCCT: the boolean built in seconds, then replicad's face merge
// ground on the result without end (occt-boolean.js). A regression here does not
// fail, it HANGS: the call is synchronous WASM and no timeout can interrupt it.
let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 60000);

const H = 10.5, BORE_R = 12.95, FLAT_X = 18.5, RC = 20;
const collar = () => k.cylinder({ r: RC, h: H }).cutAll([
  k.cylinder({ r: BORE_R, h: H + 2 }).at([0, 0, -1]),
  k.box({ min: [FLAT_X, -RC, -1], max: [RC + 2, RC, H + 1] }),
]);
// Starts 1 mm outside the flat and ends 1.5 mm inside the bore.
const tap = () => k.tappedBore({ d: 4.4665, pitch: 1.25, turns: 6, depth: 8.05, crest: 0.76675 })
  .along("-X").at([FLAT_X + 1, 0, H / 2]);
const faces = (solid) => solid._mat()._s.faces.length;
// The through-tapped collar, measured on the raw OCCT boolean.
const TAPPED_VOLUME = 7384.36;

test("a tapped hole through a curved wall cuts in seconds", () => {
  const start = Date.now();
  const tapped = collar().cut(tap());
  expect(tapped.volume()).toBeCloseTo(TAPPED_VOLUME, 0);
  expect(Date.now() - start).toBeLessThan(25000);
}, 120000);

test("the same hole cuts when the thread goes in before the bore", () => {
  const tapped = k.cylinder({ r: RC, h: H }).cut(tap()).cutAll([
    k.cylinder({ r: BORE_R, h: H + 2 }).at([0, 0, -1]),
    k.box({ min: [FLAT_X, -RC, -1], max: [RC + 2, RC, H + 1] }),
  ]);
  expect(tapped.volume()).toBeCloseTo(TAPPED_VOLUME, 0);
}, 120000);

test("it exports as STEP", async () => {
  const data = await k.toSTEP([{ name: "collar", solid: collar().cut(tap()) }]);
  expect(data.byteLength ?? data.length).toBeGreaterThan(100000);
}, 120000);

test("booleans on plain shapes still merge coplanar faces", () => {
  const joined = k.box({ min: [0, 0, 0], max: [10, 10, 10] }).union(k.box({ min: [10, 0, 0], max: [20, 10, 10] }));
  expect(faces(joined)).toBe(6);
});
