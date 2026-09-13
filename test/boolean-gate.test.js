// The boolean result gate (boolean-gate.js): a pure predicate over operand and
// result VOLUMES that refuses a boolean whose result is geometrically
// impossible — a union smaller than an input, a cut that grew its body, a
// negative volume — and, on the two signatures a volume inequality cannot
// separate from a legitimate result (the union's volume equals one operand's
// exactly; a cut came back empty), confirms with a lazily supplied overlap
// volume (after a free bounding-box enclosure test) whether the other operand
// was dropped. Both kernels' boolean ops run every result through it; this file
// pins the rules with plain numbers so the OCCT malfunctions it exists for
// (which no fixture can reproduce deterministically — the coincidence guard now
// refuses the reproducible one first) are covered without a kernel.
import { describe, expect, it, vi } from "vitest";
import { BOOLEAN_RESULT_INVALID, checkBooleanResult } from "../src/framework/geometry/boolean-gate.js";
import { BooleanResultError } from "../src/framework/geometry/errors.js";

// A probe set that must not be consulted: the volumes alone decide these cases.
const none = { overlap: () => { throw new Error("overlap must not be consulted here"); } };
// A probe that throws — the inconclusive answer.
const throwing = { overlap: () => { throw new Error("probe failed"); } };
const probes = (overlap, encloses) => ({ overlap: vi.fn(overlap), encloses: encloses && vi.fn(encloses) });

describe("checkBooleanResult — impossible volumes", () => {
  it("passes an ordinary union, cut and intersection", () => {
    expect(checkBooleanResult("union", [100, 40], 120, none)).toBeNull();
    expect(checkBooleanResult("cut", [100, 40], 70, none)).toBeNull();
    expect(checkBooleanResult("intersect", [100, 40], 30, none)).toBeNull();
  });

  it("refuses a negative-volume result on any op, as a BooleanResultError", () => {
    for (const op of ["union", "cut", "cutAll", "intersect"]) {
      const err = checkBooleanResult(op, [100, 40], -5, none);
      expect(err).toBeInstanceOf(BooleanResultError);
      expect(err.code).toBe(BOOLEAN_RESULT_INVALID);
      expect(err.message).toMatch(new RegExp(`^boolean result invalid: ${op} produced an impossible result`));
      expect(err.message).toContain("negative volume");
    }
  });

  it("refuses a union smaller than its largest operand", () => {
    const err = checkBooleanResult("union", [100, 40], 60, none);
    expect(err?.message).toContain("smaller than its largest operand");
    expect(err.message).toContain("60");
    expect(err.message).toContain("100");
  });

  it("refuses a cut larger than its body", () => {
    expect(checkBooleanResult("cut", [100, 40], 130, none)?.message).toContain("larger than its body");
  });

  it("refuses an intersection larger than its smallest operand", () => {
    expect(checkBooleanResult("intersect", [100, 40], 55, none)?.message).toContain("larger than its smallest operand");
  });

  it("slack is 1% of the operand each rule compares AGAINST, floored at 1e-6 mm³", () => {
    expect(checkBooleanResult("union", [100, 40], 99.5, none)).toBeNull();      // 0.5% under the largest
    expect(checkBooleanResult("union", [100, 40], 98.5, none)).not.toBeNull();  // 1.5% under
    expect(checkBooleanResult("cut", [100, 40], 100.9, none)).toBeNull();       // vs the body
    expect(checkBooleanResult("intersect", [100, 40], 40.3, none)).toBeNull();  // vs the smallest
    // a big tool must not switch the cut/intersect rules off: slack follows the
    // body / the smallest operand, not the largest
    expect(checkBooleanResult("cut", [5, 10000], 100, none)?.message).toContain("larger than its body");
    expect(checkBooleanResult("intersect", [1, 10000], 100, none)?.message).toContain("larger than its smallest");
    // tiny operands: the absolute floor keeps float dust from firing
    expect(checkBooleanResult("union", [1e-9, 1e-9], 5e-10, none)).toBeNull();
    expect(checkBooleanResult("cut", [100, 40], -1e-7, throwing)).toBeNull();
  });
});

describe("checkBooleanResult — the dropped-operand signature", () => {
  it("a union whose volume equals one operand's exactly asks for the overlap, and refuses when the other operand had material outside", () => {
    const p = probes(() => 5); // core ∩ ridge: only 5 of the ridge's 40 lie inside the core
    const err = checkBooleanResult("union", [100, 40], 100, p);
    expect(p.overlap).toHaveBeenCalledWith(0, 1);
    expect(err?.code).toBe(BOOLEAN_RESULT_INVALID);
    expect(err.message).toMatch(/^boolean result invalid: union dropped an operand/);
    expect(err.message).toContain("35");   // the material the union lost
    expect(err.message).toContain("tappedBore");
  });

  it("judges the lost material against the dropped operand's OWN size, so a thin ridge on a big core is not hidden", () => {
    // core 10000, ridge 50 (0.5% of the core): 38 of the ridge's 50 lie outside
    const err = checkBooleanResult("union", [10000, 50], 10000, probes(() => 12));
    expect(err?.message).toContain("dropped an operand");
  });

  it("passes when the equal-volume operand genuinely encloses the other", () => {
    const p = probes(() => 40);
    expect(checkBooleanResult("union", [100, 40], 100, p)).toBeNull();
    expect(p.overlap).toHaveBeenCalledTimes(1);
  });

  it("a bounding-box enclosure answers first, and the overlap is then never asked for", () => {
    const p = probes(() => { throw new Error("no probe expected"); }, (i, j) => i === 0 && j === 1);
    expect(checkBooleanResult("union", [100, 40], 100, p)).toBeNull();
    expect(p.encloses).toHaveBeenCalledWith(0, 1);
    expect(p.overlap).not.toHaveBeenCalled();
  });

  it("a false enclosure answer falls through to the overlap", () => {
    const p = probes(() => 5, () => false);
    expect(checkBooleanResult("union", [100, 40], 100, p)?.message).toContain("dropped an operand");
  });

  it("does not consult the probes when the volumes already prove the union right", () => {
    expect(checkBooleanResult("union", [100, 40], 120, none)).toBeNull();
  });

  it("ignores an operand with no volume (an empty solid unioned in is a no-op)", () => {
    expect(checkBooleanResult("union", [100, 0], 100, none)).toBeNull();
    expect(checkBooleanResult("union", [0, 0], 0, none)).toBeNull();
  });

  it("n-ary union: every other operand is checked against the one the result equals", () => {
    const p = probes((i, j) => (j === 2 ? 3 : 10));
    const err = checkBooleanResult("union", [100, 10, 10], 100, p);
    expect(p.overlap).toHaveBeenCalledWith(0, 1);
    expect(p.overlap).toHaveBeenCalledWith(0, 2);
    expect(err?.message).toContain("operand 2");
  });

  it("an overlap probe that throws is inconclusive, never a refusal", () => {
    expect(checkBooleanResult("union", [100, 40], 100, throwing)).toBeNull();
  });
});

describe("checkBooleanResult — a cut that emptied its body", () => {
  it("refuses an empty result when the tools cannot have covered the body", () => {
    const p = probes(() => 30); // body ∩ tool = 30 of the body's 100
    const err = checkBooleanResult("cut", [100, 40], 0, p);
    expect(p.overlap).toHaveBeenCalledWith(0, 1);
    expect(err?.message).toMatch(/^boolean result invalid: cut produced an impossible result/);
    expect(err.message).toContain("emptied its body");
  });

  it("passes an empty result when the tool encloses the body — by box, or by overlap", () => {
    const byBox = probes(() => { throw new Error("no probe expected"); }, (i, j) => i === 1 && j === 0);
    expect(checkBooleanResult("cut", [40, 100], 0, byBox)).toBeNull();
    expect(byBox.overlap).not.toHaveBeenCalled();
    expect(checkBooleanResult("cut", [40, 100], 0, probes(() => 40))).toBeNull();
  });

  it("cutAll sums each tool's overlap — an over-estimate, so it only refuses when even that cannot cover", () => {
    expect(checkBooleanResult("cutAll", [100, 70, 70], 0, probes((i, j) => (j === 1 ? 60 : 50)))).toBeNull(); // 60 + 50 ≥ 100
    expect(checkBooleanResult("cutAll", [100, 70, 70], 0, probes(() => 30))?.message).toContain("emptied its body"); // 30 + 30 < 100
  });

  it("an empty body cutting to nothing is fine, a non-empty result never asks, and a failed probe is inconclusive", () => {
    expect(checkBooleanResult("cut", [0, 40], 0, none)).toBeNull();
    expect(checkBooleanResult("cut", [100, 40], 70, none)).toBeNull();
    expect(checkBooleanResult("cut", [100, 40], 0, throwing)).toBeNull();
  });
});

describe("checkBooleanResult — inputs the gate declines to judge", () => {
  it("fewer than two operands, or an unknown op, is a pass", () => {
    expect(checkBooleanResult("union", [100], 100, none)).toBeNull();
    expect(checkBooleanResult("mystery", [100, 40], 500, none)).toBeNull();
  });

  it("a label renames the op in the message without changing the rule", () => {
    const err = checkBooleanResult("union", [100, 40], 60, none, "cutAll (tools)");
    expect(err?.message).toMatch(/^boolean result invalid: cutAll \(tools\) produced an impossible result/);
    expect(err.message).toContain("smaller than its largest operand");
  });

  it("a negative OPERAND is broken input, not this boolean's result: no judgement", () => {
    expect(checkBooleanResult("intersect", [-500, 100], 50, none)).toBeNull();
    expect(checkBooleanResult("union", [100, -40], 60, none)).toBeNull();
  });

  it("a non-finite volume anywhere is a pass (the kernel's own error, not the gate's)", () => {
    expect(checkBooleanResult("union", [100, NaN], 100, none)).toBeNull();
    expect(checkBooleanResult("cut", [100, 40], Infinity, none)).toBeNull();
  });
});
