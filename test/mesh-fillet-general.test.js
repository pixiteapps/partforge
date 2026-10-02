// test/mesh-fillet-general.test.js
// General chains (edges between two curved faces) blend on Manifold. Volume ground
// truth is OCCT where OCCT actually built the feature (reference JSON, null = OCCT
// skipped).
// Sensitivity: dropping the tee's concave junction alone shifts its fillet-1 volume
// change by ~25%, so the 10% tolerance catches a missing or wrong general tool.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { FIXTURES, GENUS, CASES, tightBend, dRodSlant, coarseKernel } from "./fixtures/fillet-general-fixtures.js";
import { meshFilletWork, generalStations, GENERAL_WORK_BUDGET, MAX_GENERAL_STATIONS, MAX_MEMBER_STATIONS } from "../src/framework/geometry/mesh-fillet.js";

const REF = JSON.parse(readFileSync(new URL("./fixtures/fillet-general-reference.json", import.meta.url), "utf8"));
const relErr = (v, e) => Math.abs(v - e) / Math.abs(e);
let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const run = (solid, mode, m, edges) => (mode === "fillet" ? solid._filletRaw(m, edges) : solid._chamferRaw(m, edges));

describe("general-chain fillet and chamfer on Manifold", () => {
  for (const name of Object.keys(FIXTURES)) {
    for (const [mode, m] of CASES) {
      // domeBoss at 2 mm is left out: the dome's BASE rim (an ordinary arc chain, no
      // general chain involved) already fails at 2 mm, fillet and chamfer alike — see
      // the known-bug test below.
      if (name === "domeBoss" && m === 2) continue;
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
  it("dome base rim at 2 mm leaves 25 shells (pins a pre-existing arc-path defect)", () => {
    // The plain dome — no boss, no general chain — through the existing arc path
    // leaves 25 shells (genus −24) at 2 mm, fillet and chamfer alike (the fillet also
    // ~8% under OCCT). This pins the DEFECT: when the arc path is fixed this test
    // fails, and should flip to genus 0 with domeBoss 2 mm rejoining the matrix above.
    const dome = k.sphere({ r: 20 }).intersect(k.box({ size: [60, 60, 30] }));
    expect(dome._filletRaw(2, { inPlane: "XY", at: 0 }).genus()).toBe(-24);
    expect(dome._chamferRaw(2, { inPlane: "XY", at: 0 }).genus()).toBe(-24);
  });
  // Coarse tessellation (spec Testing + Risk 1): the same fixtures rebuilt from
  // 32-gon prisms and a 32 × 32 loft sphere (coarseKernel), where a station's
  // averaged normal sits up to 0.1 rad off its facets. Volume is held to the same
  // OCCT reference: OCCT's ΔV is of the TRUE cylinders, the coarse base is ~0.6%
  // smaller, and a blend's ΔV is local to its edge, so the true-surface reference
  // stays meaningful. Measured worst case: slantCut fillet 1 at 9.1% — its rim crosses
  // the 32-gon's facet ridges at a slant, and the coarse cut converges on the fine one
  // as ~1/n² (8.4 / 3.6 / 1.4% above it at 32 / 48 / 64 segments). Every other case
  // is within 6%. Genus is exact. Before the facet-tilt lift and chord extension in
  // generalTool, 8 of these 16 cases came out with stray shells or handles.
  // domeBoss stays in at 2 mm here: the coarse dome's base rim does not trip the
  // arc-path defect pinned above.
  describe("coarse tessellation (32 segments)", () => {
    let kc;
    beforeAll(() => { kc = coarseKernel(k, 32); });
    for (const name of Object.keys(FIXTURES)) {
      for (const [mode, m] of CASES) {
        it(`${name} ${mode} ${m}`, () => {
          const base = FIXTURES[name](kc);
          expect(base.genus()).toBe(GENUS[name]);
          const out = run(base, mode, m);
          expect(out.genus()).toBe(GENUS[name]);
          const dV = out.volume() - base.volume();
          const ref = REF[name][`${mode}${m}`];
          if (ref != null) expect(relErr(dV, ref)).toBeLessThan(0.1);
          else expect(Number.isFinite(dV) && dV !== 0).toBe(true);
        });
      }
    }
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
  // Station bounds (mesh-fillet.js generalStations / MAX_GENERAL_STATIONS). Interior
  // stations are sized against the member-length MEDIAN, which a sliver-dominated
  // path makes tiny: this open path — sliver, 10 mm, sliver — asked for 500 003
  // stations before the per-member cap, every one a ring through ofMesh.
  const flank = [[0, 0, 1], [0, 1, 0]];
  const sliverPath = { kind: "general", closed: false, convex: true, flanks: [flank, flank, flank],
    points: [[0, 0, 0], [1e-5, 0, 0], [10 + 1e-5, 0, 0], [10 + 2e-5, 0, 0]] };
  it("a sliver–long–sliver path gets a bounded station count", () => {
    expect(generalStations(sliverPath)).toHaveLength(4 + MAX_MEMBER_STATIONS);
    // duplicate points make the median 0, which used to ask for infinitely many
    const dup = { ...sliverPath, points: [[0, 0, 0], [0, 0, 0], [10, 0, 0], [10, 0, 0]] };
    expect(generalStations(dup)).toHaveLength(4 + MAX_MEMBER_STATIONS);
  });
  it("a chain needing more sections than the cap reroutes before building tools", () => {
    // a 36 000-gon cross hole in a 64-gon tube: each rim smooths to ~18 000 stations
    const ngon = (r, n) => Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)]);
    const base = coarseKernel(k, 64).cylinder({ r: 10, h: 60, center: true }).rotateAbout({ axis: "Y", deg: 90 })
      .cut(k.prism({ points: ngon(3, 36000), h: 40 }).at([0, 0, -20]));
    const w = meshFilletWork(base, { magnitude: 0.5 });
    expect(w.maxStations).toBeGreaterThan(MAX_GENERAL_STATIONS);
    let err;
    try { base._filletRaw(0.5); } catch (e) { err = e; }
    expect(err?.code).toBe("NEEDS_OCCT");
    expect(err.message).toMatch(new RegExp(`too many sections for the mesh fillet \\(\\d+ stations > ${MAX_GENERAL_STATIONS}\\)`));
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
