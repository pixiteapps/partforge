// k.cage and k.subdiv on the Manifold kernel and the two geometry-free probes. OCCT's
// refusal lives in subdiv-occt.test.js (OCCT and Manifold never boot in one process).
import { beforeAll, describe, expect, it } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import { createProbeKernel, createValidatingProbe } from "../src/framework/geometry/probe.js";
import { probeSubPartPose } from "../src/framework/pose-probe-core.js";
import { createCage, isCage, meshSubdiv, SUBDIV_TOLERANCE, SUBDIV_MAX_TRIANGLES } from "../src/framework/geometry/subdiv/index.js";
import { ORGANIC } from "../src/framework/geometry/shading-policy.js";

// One wasm module, one kernel per tier (so a second call on a tier can hit its cache).
let wasm;
const kernels = new Map();
beforeAll(async () => { wasm = await Module(); wasm.setup(); });
const kernelAt = async (tier) => {
  if (!kernels.has(tier)) kernels.set(tier, createManifoldKernel(wasm, { quality: tier }));
  return kernels.get(tier);
};
const warningsOf = (k) => k.takeBuildWarnings().map((w) => String(w.message ?? w));

describe("k.subdiv on Manifold", () => {
  it("builds a smooth solid that takes ordinary ops", async () => {
    const k = await kernelAt("preview");
    const c = k.cage({ box: { size: [40, 20, 20], segs: [2, 1, 1] } });
    c.extrude("+x:0,0", { by: 15, scale: 0.6 });
    const s = k.subdiv(c);
    expect(s.volume()).toBeGreaterThan(0);
    expect(s.cut(k.box({ size: [100, 100, 20], center: [0, 0, -15] })).volume()).toBeLessThan(s.volume());
  });

  it("previews and prints the same body", async () => {
    const build = async (tier) => {
      const k = await kernelAt(tier);
      const c = k.cage({ box: { size: [40, 20, 20] } });
      return k.subdiv(c).volume();
    };
    const [a, b] = [await build("preview"), await build("print")];
    expect(Math.abs(a - b) / b).toBeLessThan(0.03);
  });

  it("copies the cage when called (Review Focus 5)", async () => {
    const k = await kernelAt("preview");
    const c = k.cage({ box: { size: [20, 20, 20] } });
    const first = k.subdiv(c), v = first.volume();
    c.extrude("+z:0,0", { by: 20 });
    expect(first.volume()).toBe(v);
    expect(k.subdiv(c).volume()).toBeGreaterThan(v);
    expect(() => k.subdiv(c.snapshot())).toThrow("subdiv: expected a cage from k.cage(...)");
  });

  // The dent goes in through +x and out past -x; the body keeps a positive volume. (The
  // brief's by -40, scale 0.5 dent turns the body inside out: see the next test.)
  const throughItself = (k) => { const c = k.cage({ box: { size: [20, 20, 20] } }); c.extrude("+x:0,0", { by: -25, scale: 0.3 }); return c; };

  it("errors at print and warns at preview on a body through itself", async () => {
    const print = await kernelAt("print");
    expect(() => print.subdiv(throughItself(print))).toThrow(/^subdiv: the body passes through itself between -x:0,0 and \+x:0,0>\.s\d/);
    const preview = await kernelAt("preview");
    preview.takeBuildWarnings();
    expect(preview.subdiv(throughItself(preview)).volume()).toBeGreaterThan(0);
    expect(warningsOf(preview).some((w) => /^subdiv: the body passes through itself between /.test(w))).toBe(true);
  });

  it("names the crossing, not the lost volume, when a body through itself turns inside out", async () => {
    for (const tier of ["preview", "print"]) {
      const k = await kernelAt(tier);
      const c = k.cage({ box: { size: [20, 20, 20] } });
      c.extrude("+x:0,0", { by: -40, scale: 0.5 });
      expect(() => k.subdiv(c)).toThrow(/^subdiv: the body passes through itself between /);
    }
  });

  it("re-records a cached body's warnings on a hit", async () => {
    const k = await kernelAt("preview");
    k.beginSubPart("hit");   // the cache only keeps solids inside a sub-part bracket
    k.takeBuildWarnings();
    const first = k.subdiv(throughItself(k));
    const w1 = warningsOf(k).filter((w) => /^subdiv: /.test(w));
    const hitsBefore = k.cacheStats().hits;
    const second = k.subdiv(throughItself(k));
    expect(second).toBe(first);
    expect(k.cacheStats().hits).toBe(hitsBefore + 1);
    expect(warningsOf(k).filter((w) => /^subdiv: /.test(w))).toEqual(w1);
    expect(w1.length).toBeGreaterThan(0);
    k.endSubPart();
  });

  it("is ORGANIC shaded and returns a real cage from k.cage", async () => {
    const k = await kernelAt("preview");
    const c = k.cage({ box: { size: [10, 10, 10] } });
    expect(isCage(c)).toBe(true);
    expect(c.centroid("+z:0,0")).toEqual([0, 0, 5]);
    const s = k.subdiv(c);
    const ids = [...new Set(s._m.getMesh().runOriginalID)];
    expect(ids).toHaveLength(1);
    expect(k._shadingPolicy(ids[0])).toBe(ORGANIC);
  });
});

describe("meshSubdiv", () => {
  const box = () => createCage({ box: { size: [40, 20, 20], segs: [2, 1, 1] } }).snapshot();

  it("warns when the tolerance cannot be met within the triangle limit (via its maxTriangles option)", () => {
    const out = meshSubdiv(box(), "print", { maxTriangles: 200 });
    expect(out.indices.length).toBeGreaterThan(0);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(
      /^subdiv: the surface is within [0-9.e+]+ mm of smooth, not the 0\.05 mm this quality asks for — use fewer, larger cage faces$/);
  });

  it("asks for more faces when level 5 is not fine enough (a large body with few faces)", () => {
    const cube = (segs) => createCage({ box: { size: [200, 200, 200], segs } }).snapshot();
    const out = meshSubdiv(cube([1, 1, 1]), "print");
    expect(out.indices.length / 3).toBe(12_288);   // level 5
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(
      /^subdiv: the surface is within [0-9.e+]+ mm of smooth, not the 0\.05 mm this quality asks for — split the cage into more faces \(more segs, or more steps on an extrude\)$/);
    // The remedy works: two faces per side meet it.
    expect(meshSubdiv(cube([2, 2, 2]), "print").warnings).toEqual([]);
  });

  it("limits preview to 200,000 triangles and print to 1,500,000", () => {
    expect(SUBDIV_MAX_TRIANGLES).toEqual({ preview: 200_000, print: 1_500_000 });
    // 1,944 faces at 5 m: level 3 (248,832 triangles) is past the preview limit, so
    // preview stops at level 2 and says to use fewer, larger faces.
    const big = createCage({ box: { size: [5000, 5000, 5000], segs: [18, 18, 18] } }).snapshot();
    expect(big.faces).toHaveLength(1944);
    const out = meshSubdiv(big, "preview");
    expect(out.indices.length / 3).toBe(62_208);   // level 2
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/ — use fewer, larger cage faces$/);
  });

  it("names a face that folds through itself once", () => {
    const c = createCage({ box: { size: [20, 20, 20], segs: [2, 2, 2] } });
    c.extrude("+x:0,0", { by: -30, scale: 1.5 });
    const out = meshSubdiv(c.snapshot(), "preview");
    const through = out.warnings.find((w) => w.startsWith("subdiv: the body passes through itself"));
    expect(through).toMatch(/[:;] -y:1,0 folds through itself(;|$)/);
    expect(through).not.toMatch(/(\S+) and \1(;|$)/);
  });

  it("meets the tolerance with no warning on an ordinary cage", () => {
    for (const tier of ["preview", "print"]) expect(meshSubdiv(box(), tier).warnings).toEqual([]);
    expect(SUBDIV_TOLERANCE.print).toBe(0.05);
  });

  it("refuses a body with no volume", () => {
    const snap = box();
    snap.faces = snap.faces.map((f) => f.slice().reverse());   // inside out
    expect(() => meshSubdiv(snap, "preview")).toThrow("subdiv: the body has no volume");
  });
});

describe("k.cage and k.subdiv under the probes", () => {
  it("the lint/routing probes record both ops, answer cage questions for real, and record the cage's state", () => {
    for (const make of [createProbeKernel, createValidatingProbe]) {
      const probe = make();
      const { kernel: k } = probe;
      const c = k.cage({ box: { size: [10, 10, 10] } });
      expect(c.centroid("+z:0,0")).toEqual([0, 0, 5]);
      const s1 = k.subdiv(c);
      c.move("+z:0,0", [0, 0, 3]);
      k.subdiv(c);
      expect(s1.volume()).toBe(1);   // the probe's solid handle chains as usual
      expect(probe.used.has("cage")).toBe(true);
      expect(probe.used.has("subdiv")).toBe(true);
      expect(probe.solidUsed.has("subdiv")).toBe(true);
      expect(() => k.subdiv("not a cage")).not.toThrow();
    }
    const v = createValidatingProbe();
    const c = v.kernel.cage({ box: { size: [10, 10, 10] } });
    v.kernel.subdiv(c);
    c.move("+z:0,0", [0, 0, 3]);
    v.kernel.subdiv(c);
    const subdivs = v.calls.filter((call) => call.op === "subdiv");
    expect(subdivs[0].args[0]).not.toBe(subdivs[1].args[0]);   // the recorded call carries the cage's state
    expect(subdivs.every((call) => !call.fn)).toBe(true);       // a cage is data, not a function argument
    expect(v.issues).toEqual([]);
    expect(v.queried).toEqual([]);                               // a cage's answers are real, not fabricated
    expect(v.passedFunction()).toBe(false);
  });

  it("the pose probe answers cage questions for real and hashes the cage's state", () => {
    let centroid;
    const sp = {
      build: (k, p) => {
        const c = k.cage({ box: { size: [10, 10, 10] } });
        centroid = c.centroid("+z:0,0");
        if (p.lift) c.move("+z:0,0", [0, 0, p.lift]);
        return k.subdiv(c);
      },
    };
    const run = (lift) => probeSubPartPose(sp, { view: "v", p: { lift }, d: {} }, { scope: "build" });
    const a = run(0), b = run(3), a2 = run(0);
    expect(centroid).toEqual([0, 0, 5]);
    expect(a.trusted).toBe(true);
    expect(b.trusted).toBe(true);
    expect(a.baseHash).toBe(a2.baseHash);
    expect(a.baseHash).not.toBe(b.baseHash);
    expect(a.skinnable).toBe(false);   // no _implicit flag: nothing to skin
    const odd = probeSubPartPose({ build: (k) => k.subdiv(42) }, { view: "v", p: {}, d: {} }, { scope: "build" });
    expect(odd.shapeHash).toBeDefined();   // a non-cage argument does not throw in the probe
  });
});
