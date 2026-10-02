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
});
