// The native leaf sampler (native/implicit_mesh.cpp, ip_sample) must store the SAME
// BYTES as sparse.js's evaluateLeaves for the same plan — every leaf's float32
// samples (outer-layer raise and exact-zero nudge included) and the clipped flag.
import { afterEach, describe, expect, test } from "vitest";
import { core, setCoreForTesting } from "../src/framework/core/core.js";
import { NativeSession } from "../src/framework/core/implicit-core.js";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { planLeaves, evaluateLeaves } from "../src/framework/geometry/implicit/sparse.js";
import { nativeCases, sessionFor } from "./fixtures/implicit-native-cases.js";

afterEach(() => setCoreForTesting(undefined));

const bytes = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

describe("native leaf sampling", () => {
  for (const { name, spec, images, edges } of nativeCases()) {
    for (const edge of edges) {
      test(`${name} at ${edge} mm: every leaf's samples and clipped match evaluateLeaves`, () => {
        const plan = planLeaves(lowerSpec(spec, { images }), edge);
        const js = evaluateLeaves(plan);
        const s = sessionFor(plan);
        try {
          const nat = s.sample(plan);
          expect(nat.vals.length).toBe(js.leaves.length);
          for (let L = 0; L < js.leaves.length; L++) {
            if (Buffer.compare(bytes(nat.vals[L]), bytes(js.leaves[L].vals)) !== 0) {
              const a = js.leaves[L].vals, b = nat.vals[L];
              const q = a.findIndex((v, k) => !Object.is(v, b[k]));
              throw new Error(`leaf ${L} sample ${q}: native ${b[q]} vs JS ${a[q]}`);
            }
          }
          expect(nat.clipped).toBe(js.clipped);
        } finally { s.destroy(); }
      }, 120_000);
    }
  }

  test("the cases reach the zero nudge", () => {
    // Guard against a case list that never exercises the nudge (the raise: the clipped test below).
    const c = lowerSpec(nativeCases().find((k) => k.name === "touching mirrorHalfBox").spec, { images: new Map() });
    const js = evaluateLeaves(planLeaves(c, 0.5));
    expect(js.leaves.some((l) => l.vals.some((v) => v < 0 && v > -1e-5))).toBe(true);
  });

  test("a clipped plan reports clipped", () => {
    const plan = planLeaves(lowerSpec({ root: { kind: "sphere", r: 5 } }, { images: new Map() }), 1);
    const shrunk = { ...plan, n: plan.n.map((v) => v - 4), leaves: plan.leaves.filter((l) => l.i0 < plan.n[0] - 6 && l.j0 < plan.n[1] - 6 && l.l0 < plan.n[2] - 6) };
    shrunk.origin = plan.origin.map((v) => v + 2);
    const js = evaluateLeaves(shrunk);
    expect(js.clipped).toBe(true);
    expect(js.leaves.some((l) => l.vals.some((v) => v === 0.5))).toBe(true);   // the outer-layer raise to 0.5·edge
    const s = sessionFor(shrunk);
    try {
      const nat = s.sample(shrunk);
      expect(nat.clipped).toBe(true);
      for (let L = 0; L < js.leaves.length; L++) expect(Buffer.compare(bytes(nat.vals[L]), bytes(js.leaves[L].vals))).toBe(0);
    } finally { s.destroy(); }
  });

  test("a plan naming a program the session lacks is refused, not run", () => {
    const plan = planLeaves(lowerSpec({ root: { kind: "sphere", r: 3 } }, { images: new Map() }), 1);
    const s = new NativeSession(core());
    try {
      expect(() => s.sample(plan)).toThrow(/refused/);
      expect(() => s.sample({ ...plan, edge: NaN })).toThrow(/plan/);
    } finally { s.destroy(); }
    expect(core().poisoned).toBe(false);
  });
});
