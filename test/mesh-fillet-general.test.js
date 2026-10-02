// test/mesh-fillet-general.test.js
// General chains (edges between two curved faces) blend on Manifold. Volume ground
// truth is OCCT where OCCT actually built the feature (reference JSON, null = OCCT
// skipped).
// Sensitivity: dropping the tee's concave junction alone shifts its fillet-1 volume
// change by ~25%, so the 10% tolerance catches a missing or wrong general tool.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { FIXTURES, GENUS, CASES, tightBend, dRodSlant } from "./fixtures/fillet-general-fixtures.js";
import { meshFilletWork, GENERAL_WORK_BUDGET } from "../src/framework/geometry/mesh-fillet.js";

const REF = JSON.parse(readFileSync(new URL("./fixtures/fillet-general-reference.json", import.meta.url), "utf8"));
const relErr = (v, e) => Math.abs(v - e) / Math.abs(e);
let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const run = (solid, mode, m, edges) => (mode === "fillet" ? solid._filletRaw(m, edges) : solid._chamferRaw(m, edges));

describe("general-chain fillet and chamfer on Manifold", () => {
  for (const name of Object.keys(FIXTURES)) {
    for (const [mode, m] of CASES) {
      // domeBoss fillet 2 is left out: the dome's BASE rim (an ordinary arc chain, no
      // general chain involved) already fails at r=2 — see the known-bug test below.
      if (name === "domeBoss" && mode === "fillet" && m === 2) continue;
      it(`${name} ${mode} ${m}: builds, watertight, volume matches OCCT where OCCT built it`, () => {
        const base = FIXTURES[name](k);
        const out = run(base, mode, m);
        expect(out.genus()).toBe(GENUS[name]);
        const dV = out.volume() - base.volume();
        const ref = REF[name][`${mode}${m}`];
        if (ref != null) expect(relErr(dV, ref)).toBeLessThan(0.1);
        else expect(Number.isFinite(dV) && dV !== 0).toBe(true);
      });
    }
  }
  it("a bend tighter than the section still reroutes", () => {
    expect(() => run(tightBend(k), "fillet", 2)).toThrow(/bend too tight|NEEDS_OCCT|general chain/);
  });
  it("a selector that picks only ordinary edges ignores the general chain", () => {
    const base = FIXTURES.slantCut(k);
    const out = run(base, "fillet", 1, { inPlane: "XY", at: 0 });
    expect(out.genus()).toBe(0);
    expect(out.volume()).toBeLessThan(base.volume());
  });
  it("a general run meeting a straight run at corners stays watertight", () => {
    const base = dRodSlant(k);
    let out;
    try { out = run(base, "fillet", 1); } catch (e) { expect(e.code).toBe("NEEDS_OCCT"); return; }
    expect(out.genus()).toBe(0);
    expect(out.volume()).toBeLessThan(base.volume());
  });
  it.fails("dome base rim fillet 2 is one shell (pre-existing arc-path defect)", () => {
    // The plain dome — no boss, no general chain — through the existing arc path
    // leaves 25 shells at r=2 (and ~8% under OCCT). Pinned here so a fix shows up.
    const dome = k.sphere({ r: 20 }).intersect(k.box({ size: [60, 60, 30] }));
    expect(dome._filletRaw(2, { inPlane: "XY", at: 0 }).genus()).toBe(0);
  });
  it("print quality builds the fixtures watertight", async () => {
    const kp = await bootManifoldKernel({ quality: "print" });
    for (const [name, make] of Object.entries(FIXTURES)) expect(make(kp)._filletRaw(1).genus(), name).toBe(GENUS[name]);
  });
  // Work budget (mesh-fillet.js GENERAL_WORK_BUDGET): a selection containing a
  // general chain whose estimated blend work is too large reroutes before any tool
  // is built. A tube with 64 alternating cross holes: 128 general rims plus their
  // ordinary neighbours — ~304 000 work units at preview, ~17 s to fillet at r=0.5
  // with the budget lifted (measured 2026-10-02).
  const holeyTube = (kk) => {
    const N = 64;
    const holes = Array.from({ length: N }, (_, i) => kk.cylinder({ r: 2, h: 40, center: true })
      .rotateAbout({ axis: i % 2 ? "X" : "Y", deg: i % 2 ? 90 : 0 }).at([(i - (N - 1) / 2) * 10, 0, 0]));
    return kk.cylinder({ r: 10, h: 10 * N, center: true }).rotateAbout({ axis: "Y", deg: 90 }).cutAll(holes);
  };
  it("a general selection over the work budget reroutes before building tools", () => {
    const base = holeyTube(k);
    expect(meshFilletWork(base, { magnitude: 0.5 }).work).toBeGreaterThan(GENERAL_WORK_BUDGET);
    let err;
    try { base._filletRaw(0.5); } catch (e) { err = e; }
    expect(err?.name).toBe("KernelCapabilityError");
    expect(err.code).toBe("NEEDS_OCCT");
    expect(err.message).toMatch(new RegExp(`too complex for the mesh fillet \\(work \\d+ > budget ${GENERAL_WORK_BUDGET}\\)`));
    expect(() => base._chamferRaw(0.5)).toThrow(/too complex for the mesh chamfer/);
  });
  it("the general-chain fixtures sit far under the work budget at both qualities", async () => {
    const kp = await bootManifoldKernel({ quality: "print" });
    for (const kk of [k, kp]) {
      for (const [name, make] of Object.entries({ ...FIXTURES, dRodSlant })) {
        for (const [mode, m] of CASES) {
          const w = meshFilletWork(make(kk), { mode, magnitude: m });
          expect(w.general, name).toBe(true);
          expect(w.work, `${name} ${mode} ${m}`).toBeLessThan(GENERAL_WORK_BUDGET / 50);
        }
      }
    }
  });
});
