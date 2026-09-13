// Deviation facts (measure.js) + the ref* verify gate (verify-metrics.js) —
// Task 12: holds a parametric rebuild to its imported reference. Manifold-
// booting only (kernel.import needs the mesh-import backend), own file per the
// OCCT/Manifold same-process ban.
import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { measure } from "../src/framework/oracle/measure.js";
import { verify } from "../src/framework/oracle/verify.js";
import { meshToStl } from "../src/framework/geometry/mesh-stl.js";
import { cubeSoup } from "./helpers/cube-soup.js";

const scanImport = () => { const c = cubeSoup(10); return meshToStl(c.positions, c.indices); };

const part = (bodyBuild) => ({
  meta: { title: "dev" },
  imports: { scan: scanImport },
  defaults: {},
  views: { main: {} },
  parts: {
    ref: { views: ["main"], exportable: false, build: (k) => k.import("scan") },
    body: { views: ["main"], reference: "scan", build: bodyBuild },
  },
  verify: { expect: { body: { refXorVolume: "<=50mm3", refVolumeDeltaPct: "<=2", refBboxDelta: "<=[0.5,0.5,0.5]" } } },
});

let kernel;
beforeAll(async () => { kernel = await bootManifoldKernel({ imports: { scan: scanImport } }); });

describe("deviation gate", () => {
  it("an exact rebuild passes", () => {
    // cubeSoup(10) is origin-cornered — [0,10]^3, matched exactly here.
    const p = part((k) => k.box({ min: [0, 0, 0], max: [10, 10, 10] }));
    const r = measure(kernel, p, "main");
    const body = r.subparts.find((s) => s.name === "body");
    expect(body.deviation.xorVolume).toBeLessThan(1);
    expect(verify(kernel, p, { view: "main", seed: { params: {}, result: r } }).ok).toBe(true);
  });

  it("a drifted rebuild fails the gate", () => {
    const p = part((k) => k.box({ min: [0, 0, 0], max: [10, 10, 12] }));
    const v = verify(kernel, p, { view: "main" });
    expect(v.ok).toBe(false);
    expect(v.failures.some((f) => f.metric === "refXorVolume")).toBe(true);
  });

  it("no reference declared → no deviation facts, metrics skip", () => {
    const p = part((k) => k.box({ min: [0, 0, 0], max: [10, 10, 10] }));
    delete p.parts.body.reference;
    const r = measure(kernel, p, "main");
    expect(r.subparts.find((s) => s.name === "body").deviation).toBeNull();
    const v = verify(kernel, p, { view: "main" });
    expect(v.failures).toEqual([]); // ref* checks report status "skip", not fail…
    // …and a part whose EVERY declared check skipped has verified nothing: the
    // verdict is withheld (vacuous verify), with the notice that says why.
    expect(v.ok).toBeNull();
    expect(v.warnings.find((w) => w.metric === "expectations")?.message).toBe("no expectation could be evaluated");
  });
});
