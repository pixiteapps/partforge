import { describe, it, expect, beforeAll } from "vitest";
import { rangePoses, sweepRanges } from "../src/framework/oracle/ranges.js";
import * as testing from "../src/testing.js";
import { bootManifoldKernel } from "../src/testing.js";
import cageHand from "../src/parts/cage-hand.js";

const part = {
  parameters: [
    { id: "s", title: "S", controls: [
      { key: "a", label: "A", min: 0, max: 10 },
      { key: "b", label: "B", min: -5, max: 5 },
      { key: "c", label: "C", type: "checkbox" },
    ] },
  ],
  defaults: { a: 2, b: 0, c: 0 },
};

const FIRST = ["defaults", "a=min", "a=max", "b=min", "b=max", "all min", "all max"];

describe("rangePoses", () => {
  it("is exported from partforge/testing", () => {
    expect(testing.rangePoses).toBe(rangePoses);
    expect(testing.sweepRanges).toBe(sweepRanges);
  });

  it("lists the defaults, each control's ends, all ends, then the random poses", () => {
    const poses = rangePoses(part);
    expect(poses.map((q) => q.name)).toEqual([...FIRST, ...Array.from({ length: 24 }, (_, i) => `random ${i + 1}`)]);
    expect(poses[0].params).toEqual({});
    expect(poses.find((q) => q.name === "a=max").params).toEqual({ a: 10 });
    expect(poses.find((q) => q.name === "b=max").params).toEqual({ b: 5 });
    expect(poses.find((q) => q.name === "all min").params).toEqual({ a: 0, b: -5 });
    for (const q of poses) {
      expect(q.params).not.toHaveProperty("c");
      if (q.params.a !== undefined) { expect(q.params.a).toBeGreaterThanOrEqual(0); expect(q.params.a).toBeLessThanOrEqual(10); }
      if (q.params.b !== undefined) { expect(q.params.b).toBeGreaterThanOrEqual(-5); expect(q.params.b).toBeLessThanOrEqual(5); }
      // only keys that differ from the defaults
      for (const [k, v] of Object.entries(q.params)) expect(v).not.toBe(part.defaults[k]);
    }
  });

  it("repeats with one seed and changes with another", () => {
    expect(rangePoses(part, { seed: 7 })).toEqual(rangePoses(part, { seed: 7 }));
    expect(rangePoses(part, { seed: 7 })).not.toEqual(rangePoses(part, { seed: 8 }));
  });

  it("gives the first seven only with random: 0, and the defaults alone with no ranged control", () => {
    expect(rangePoses(part, { random: 0 }).map((q) => q.name)).toEqual(FIRST);
    const none = { parameters: [{ id: "s", controls: [{ key: "c", type: "checkbox" }] }], defaults: { c: 0 } };
    expect(rangePoses(none).map((q) => q.name)).toEqual(["defaults"]);
  });
});

describe("sweepRanges", () => {
  // A kernel-free part: build returns a stand-in solid, and throws the subdiv
  // self-intersection message (in the form subdiv/index.js writes it) past a = 8.
  const THROUGH = "subdiv: the body passes through itself between k.s1 and k.s2";
  const stub = {
    ...part,
    parts: { x: {
      build: (k, p) => {
        if (p.a > 8) throw new Error(THROUGH);
        return { toMesh: () => ({ positions: new Float32Array(0), indices: new Uint32Array(0) }) };
      },
      views: { main: true },
    } },
    views: { main: {} },
  };

  it("lists exactly the poses that throw, with the error, and counts the faces named", () => {
    let cleaned = 0;
    const kernel = { cleanup: () => { cleaned++; } };
    const r = sweepRanges(kernel, stub, undefined, { random: 24, seed: 3 });
    const poses = rangePoses(stub, { random: 24, seed: 3 });
    const bad = poses.filter((q) => ({ ...stub.defaults, ...q.params }).a > 8);
    expect(bad.length).toBeGreaterThan(0);
    expect(r.view).toBe("main");
    expect(r.poses).toBe(poses.length);
    expect(cleaned).toBe(poses.length);
    expect(r.failed).toEqual(bad.map((q) => ({ name: q.name, params: q.params, error: THROUGH })));
    expect(r.faces).toEqual([{ id: "k.s1", count: bad.length }, { id: "k.s2", count: bad.length }]);
  });

  it("gives no faces when no error names one", () => {
    const r = sweepRanges({}, { ...stub, parts: { x: { build: () => { throw new Error("boom"); }, views: { main: true } } } }, "main", { random: 0 });
    expect(r.failed.length).toBe(FIRST.length);
    expect(r.failed[0].error).toBe("boom");
    expect(r.faces).toEqual([]);
  });
});

describe("sweepRanges on the cage hand", () => {
  let k;
  beforeAll(async () => { k = await bootManifoldKernel(); }, 120000);

  it("builds every listed pose and the defaults build", () => {
    const r = sweepRanges(k, cageHand, undefined, { random: 6 });
    expect(r.poses).toBe(1 + 2 * 11 + 2 + 6);
    expect(r.failed.map((f) => f.name)).not.toContain("defaults");
  }, 300000);
});
