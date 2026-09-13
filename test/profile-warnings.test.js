// Kernel-level profile-validity warnings on the Manifold backend: a hand-authored
// profile that crosses itself reaches extrude/prism/revolve/sweep/loft/shape2d
// (and Shape2D boolean operands), builds anyway, and records ONE warning per
// distinct message per build on the same channel as feature-skip warnings.
// profile-warnings-occt.test.js is the B-rep twin; the messages must match.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { profileWarningMessages } from "../src/framework/geometry/profile-warnings.js";

const BOW = [[0, 0], [10, 10], [10, 0], [0, 10]];
const SQUARE = [[0, 0], [10, 0], [10, 10], [0, 10]];
const LATHE_BOW = [[0, 0], [10, 10], [10, 0], [0, 10]];   // [[r, z]] — r ≥ 0 throughout

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });
beforeEach(() => { k.takeBuildWarnings(); });

describe("factory ops warn on a self-crossing profile and still build", () => {
  it("extrude", () => {
    const s = k.extrude({ profile: BOW, h: 5 });
    expect(s.volume()).toBeGreaterThan(0);
    // Whole-string, not a prefix match: the OCCT twin pins the same shared pure
    // function, so the two backends' text can only agree if both are pinned to it.
    expect(k.takeBuildWarnings()).toEqual(profileWarningMessages("extrude: profile", BOW));
  });
  it("prism", () => {
    k.prism({ points: BOW, h: 5 });
    expect(k.takeBuildWarnings()).toEqual(profileWarningMessages("prism: profile", BOW));
  });
  it("revolve", () => {
    k.revolve({ profile: LATHE_BOW });
    expect(k.takeBuildWarnings()[0]).toMatch(/^revolve: profile self-intersects/);
  });
  it("sweep", () => {
    k.sweep({ profile: BOW, path: [[0, 0, 0], [0, 0, 20]] });
    expect(k.takeBuildWarnings()[0]).toMatch(/^sweep: profile self-intersects/);
  });
  it("loft names the ring", () => {
    k.loft({ rings: [{ polygon: SQUARE, z: 0 }, { polygon: BOW, z: 10 }] });
    expect(k.takeBuildWarnings()).toEqual(profileWarningMessages("loft: ring 1", BOW));
  });
  it("loft's segment ceiling is an aggregate over the rings", () => {
    // Each ring is well under PROFILE_VALIDATE_MAX_SEGMENTS (4000) on its own, so a
    // per-ring ceiling would validate all of them on every rebuild — the loftSmooth
    // cost this ceiling exists to bound. Summed, 4 × 1100 is over it and the whole
    // loft is skipped; two of the same rings are under it and the bowtie is reported.
    const N = 1100;
    const ring = (z) => ({ polygon: Array.from({ length: N }, (_, i) => {
      const a = (2 * Math.PI * i) / N;
      return [10 * Math.cos(a), 10 * Math.sin(a)];
    }), z });
    k.loft({ rings: [ring(0), ring(5), { polygon: BOW, z: 10 }, ring(15), ring(20)] });
    expect(k.takeBuildWarnings()).toEqual([]);
    k.loft({ rings: [ring(0), { polygon: BOW, z: 5 }, ring(10)] });
    expect(k.takeBuildWarnings()).toEqual(profileWarningMessages("loft: ring 1", BOW));
  });
  it("legacy positional extrude is covered too", () => {
    k.extrude(BOW, 5);
    expect(k.takeBuildWarnings()[0]).toMatch(/^extrude: profile self-intersects/);
  });
});

describe("Shape2D", () => {
  it("k.shape2d warns on lift", () => {
    k.shape2d(BOW);
    expect(k.takeBuildWarnings()).toEqual(profileWarningMessages("shape2d: profile", BOW));
  });
  it("a raw boolean operand warns (the reported part's path)", () => {
    const base = k.shape2d(SQUARE);
    k.takeBuildWarnings();
    base.union(BOW);
    expect(k.takeBuildWarnings()).toEqual(profileWarningMessages("shape2d: profile", BOW));
  });
  it("a Shape2D handed to extrude is NOT re-validated", () => {
    const s = k.shape2d(BOW);
    k.takeBuildWarnings();
    k.extrude({ profile: s, h: 5 });
    expect(k.takeBuildWarnings()).toEqual([]);
  });
  it("text2d's glyph lift is trusted (no per-glyph validation noise)", () => {
    // Assert the WIRING, not just the silence: a glyph that happened to validate
    // clean would pass a bare "no warnings" check with the trust gone.
    const spy = vi.spyOn(k.shape2d, "trusted");
    try {
      k.text2d("Bo", { size: 10 });
      expect(spy).toHaveBeenCalled();
    } finally { spy.mockRestore(); }
    expect(k.takeBuildWarnings()).toEqual([]);
  });
  it("Shape2D.regions() re-lifts its own regions trusted", () => {
    const spy = vi.spyOn(k.shape2d, "trusted");
    try {
      k.shape2d(SQUARE).union(k.shape2d(SQUARE).translate([40, 0])).regions();
      expect(spy).toHaveBeenCalled();
    } finally { spy.mockRestore(); }
    expect(k.takeBuildWarnings()).toEqual([]);
  });
});

describe("bounds", () => {
  it("a clean profile records nothing", () => {
    k.extrude({ profile: SQUARE, h: 5 });
    k.prism({ points: SQUARE, h: 5 });
    expect(k.takeBuildWarnings()).toEqual([]);
  });
  it("six placements of one bad profile record one warning", () => {
    for (let i = 0; i < 6; i++) k.extrude({ profile: BOW, h: 5 }).rotateZ(i * 60);
    expect(k.takeBuildWarnings()).toHaveLength(1);
  });
  it("the next build (after a drain) warns again", () => {
    k.extrude({ profile: BOW, h: 5 });
    expect(k.takeBuildWarnings()).toHaveLength(1);
    k.extrude({ profile: BOW, h: 5 });
    expect(k.takeBuildWarnings()).toHaveLength(1);
  });
  it("a hole touching its outer builds as drawn, with no warning", () => {
    // A notch: the hole's mouth lies ON the outer's bottom edge. validateProfile
    // files the outer/hole contacts under self-intersection (tagged `crosses`), but
    // nothing inverts — the solid is exactly 175 mm² × 3 mm.
    const notched = { outer: [[0, 0], [20, 0], [20, 10], [0, 10]], holes: [[[5, 0], [5, 5], [10, 5], [10, 0]]] };
    const s = k.extrude({ profile: notched, h: 3 });
    expect(s.volume()).toBeCloseTo(525, 3);
    expect(k.takeBuildWarnings()).toEqual([]);
  });
  it("an invalid profile still throws the op's own error, with no warning", () => {
    expect(() => k.extrude({ profile: [[0, 0], [1, 1]], h: 5 })).toThrow();
    expect(k.takeBuildWarnings()).toEqual([]);
  });
});
