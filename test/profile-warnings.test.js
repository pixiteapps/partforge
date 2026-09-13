// Kernel-level profile-validity warnings on the Manifold backend: a hand-authored
// profile that crosses itself reaches extrude/prism/revolve/sweep/loft/shape2d
// (and Shape2D boolean operands), builds anyway, and records ONE warning per
// distinct message per build on the same channel as feature-skip warnings.
// profile-warnings-occt.test.js is the B-rep twin; the messages must match.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";

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
    const w = k.takeBuildWarnings();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^extrude: profile self-intersects near \(5\.0000, 5\.0000\)/);
  });
  it("prism", () => {
    k.prism({ points: BOW, h: 5 });
    expect(k.takeBuildWarnings()[0]).toMatch(/^prism: profile self-intersects/);
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
    const w = k.takeBuildWarnings();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^loft: ring 1 self-intersects/);
  });
  it("legacy positional extrude is covered too", () => {
    k.extrude(BOW, 5);
    expect(k.takeBuildWarnings()[0]).toMatch(/^extrude: profile self-intersects/);
  });
});

describe("Shape2D", () => {
  it("k.shape2d warns on lift", () => {
    k.shape2d(BOW);
    expect(k.takeBuildWarnings()[0]).toMatch(/^shape2d: profile self-intersects/);
  });
  it("a raw boolean operand warns (the reported part's path)", () => {
    const base = k.shape2d(SQUARE);
    k.takeBuildWarnings();
    base.union(BOW);
    expect(k.takeBuildWarnings()[0]).toMatch(/^shape2d: profile self-intersects/);
  });
  it("a Shape2D handed to extrude is NOT re-validated", () => {
    const s = k.shape2d(BOW);
    k.takeBuildWarnings();
    k.extrude({ profile: s, h: 5 });
    expect(k.takeBuildWarnings()).toEqual([]);
  });
  it("text2d's glyph lift is trusted (no per-glyph validation noise)", () => {
    k.text2d("Bo", { size: 10 });
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
  it("an invalid profile still throws the op's own error, with no warning", () => {
    expect(() => k.extrude({ profile: [[0, 0], [1, 1]], h: 5 })).toThrow();
    expect(k.takeBuildWarnings()).toEqual([]);
  });
});
