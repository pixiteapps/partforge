// The boolean result gate on the OCCT backend — the kernel it exists for.
// OCCT and Manifold must not boot in the same process, hence the separate file.
//
// The silent failures the gate refuses (a fuse that returns one operand, a
// negative-volume result) have no deterministic fixture: the one reproducible
// construction is refused earlier by the coincidence guard, and the rest were
// seen on real parts under conditions no test can pin. So this file's job is
// the rest of the contract — every legitimate construction, including the ones
// that hit the gate's expensive signatures (an operand fully enclosed by the
// other, a cut that honestly empties its body, tappedBore's trusted union),
// still builds with the volumes the geometry implies; the backend really does
// consult the gate with real volumes (spied), including cutAll's tool fuse; a
// refusal propagates out of the op, frees nothing it should not, and is
// remembered by cache key so a rebuild does not re-pay the failing boolean.
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { bootOcctKernel } from "../src/testing.js";

const gate = vi.hoisted(() => ({ calls: [], answerNext: null }));
vi.mock("../src/framework/geometry/boolean-gate.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    checkBooleanResult: (...args) => {
      gate.calls.push(args);
      if (gate.answerNext) { const e = gate.answerNext; gate.answerNext = null; return e; }
      return actual.checkBooleanResult(...args);
    },
  };
});

let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 60000);
beforeEach(() => { gate.calls.length = 0; gate.answerNext = null; });

const box = (min, max) => k.box({ min, max });
const labels = () => gate.calls.map((c) => c[4] ?? c[0]);

test("an overlapping union and an overcut cut pass with the expected volumes, judged with real volumes", () => {
  const u = box([0, 0, 0], [10, 10, 10]).union(box([5, 0, 0], [15, 10, 10]));
  expect(u.volume()).toBeCloseTo(1500, 3);
  expect(labels()).toEqual(["union"]);
  const [, operands, result] = gate.calls[0];
  expect(operands).toEqual([expect.closeTo(1000, 3), expect.closeTo(1000, 3)]);
  expect(result).toBeCloseTo(1500, 3);
  const c = box([0, 0, 0], [10, 10, 10]).cut(k.cylinder({ r: 2, h: 14 }).translate([5, 5, -2]));
  expect(c.volume()).toBeCloseTo(1000 - Math.PI * 4 * 10, 1);
  expect(labels()).toEqual(["union", "cut"]);
});

test("intersect and cutAll pass; cutAll judges its tool fuse as a union first", () => {
  const i = box([0, 0, 0], [10, 10, 10]).intersect(box([5, 5, 5], [15, 15, 15]));
  expect(i.volume()).toBeCloseTo(125, 3);
  const c = box([0, 0, 0], [20, 10, 10]).cutAll([
    k.cylinder({ r: 1.5, h: 14 }).translate([5, 5, -2]),
    k.cylinder({ r: 1.5, h: 14 }).translate([15, 5, -2]),
  ]);
  expect(c.volume()).toBeCloseTo(2000 - 2 * Math.PI * 2.25 * 10, 1);
  expect(labels()).toEqual(["intersect", "cutAll (tools)", "cutAll"]);
  expect(gate.calls[1][0]).toBe("union"); // the tool fuse is judged by union's rules
  expect(gate.calls[2][1]).toHaveLength(3); // body + two tools
});

test("a single-tool cutAll is not judged as a fuse (nothing to compare)", () => {
  box([0, 0, 0], [10, 10, 10]).cutAll([k.cylinder({ r: 2, h: 14 }).translate([5, 5, -2])]).volume();
  expect(labels()).toEqual(["cutAll"]);
});

test("an operand fully enclosed by the other is the equality signature: the box test answers, no probe boolean runs", () => {
  const u = box([0, 0, 0], [10, 10, 10]).union(box([3, 3, 3], [7, 7, 7]));
  expect(u.volume()).toBeCloseTo(1000, 3);
  const [, , , probes] = gate.calls[0];
  expect(probes.encloses(0, 1)).toBe(true);
  expect(probes.encloses(1, 0)).toBe(false);
  expect(probes.overlap(0, 1)).toBeCloseTo(64, 3); // and the probe, when asked, is a real intersect
});

test("a cut that honestly empties its body passes", () => {
  const r = box([3, 3, 3], [7, 7, 7]).cut(box([0, 0, 0], [10, 10, 10]));
  expect(Math.abs(r.volume())).toBeLessThan(1e-6);
});

test("k.tappedBore's trusted union is judged under its own label and passes, and so is the tap cut", () => {
  const PITCH = 1.5, MAJOR_R = 5, TURNS = 3;
  const H = (Math.sqrt(3) / 2) * PITCH;
  const ROOT_R = MAJOR_R - (5 / 8) * H;
  const stock = k.cylinder({ r: MAJOR_R + 3, h: PITCH * TURNS + 4 }).translate([0, 0, -2]);
  const tapped = stock.cut(k.tappedBore({ d: ROOT_R * 2, pitch: PITCH, turns: TURNS }));
  const v = tapped.volume();
  expect(v).toBeGreaterThan(0);
  expect(v).toBeLessThan(stock.volume());
  expect(labels()).toContainEqual(expect.stringContaining("k.tappedBore"));
}, 120000);

test("a shelled body cut afterwards passes", () => {
  const cup = box([0, 0, 0], [20, 20, 20]).shell({ t: 2, open: { inPlane: "XY", at: 20 } });
  const drained = cup.cut(k.cylinder({ r: 3, h: 6 }).translate([10, 10, -2]));
  expect(drained.volume()).toBeGreaterThan(0);
  expect(drained.volume()).toBeLessThan(cup.volume());
});

test("a refusal propagates out of the op and is remembered by cache key", () => {
  const err = new Error("boolean result invalid: union dropped an operand — (stub)");
  err.code = "BOOLEAN_RESULT_INVALID";
  gate.answerNext = err;
  k.beginSubPart("gate-refusal");
  try {
    const a = box([0, 0, 0], [10, 10, 10]), b = box([5, 0, 0], [15, 10, 10]);
    expect(() => a.union(b)).toThrow(/dropped an operand/);
    expect(gate.calls).toHaveLength(1);
    // the rebuild: same key, same refusal, no second boolean and no second judgement
    expect(() => a.union(b)).toThrow(/dropped an operand/);
    expect(gate.calls).toHaveLength(1);
  } finally { k.endSubPart(); }
});
