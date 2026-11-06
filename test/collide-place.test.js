// collide/place.js answers a place() that only moves its solid with a light token, and
// hands everything else to the full place-scope probe. Held here to read exactly what the
// probe's rule alone reads, on every reference part's sub-parts, in every view, at the
// defaults and at sampled params.
import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { placeMatrix } from "../src/framework/collide/place.js";
import { CANONICAL, probeSubPartPose } from "../src/framework/pose-probe-core.js";
import { composePose, isRigid } from "../src/framework/geometry/pose.js";
import { resolveParams, viewSubParts } from "../src/framework/part-model.js";

const PARTS = readdirSync(new URL("../src/parts/", import.meta.url)).filter((f) => f.endsWith(".js"));

/** The rule before the light token: the probe alone. */
function probeMatrix(sp, view, p, d) {
  const probe = probeSubPartPose(sp, { view, purpose: "display", p, d }, { scope: "place" });
  if (!probe?.trusted || probe.baseHash !== CANONICAL) return null;
  const m = Array.from(composePose(probe.pose));
  return isRigid(m) ? m : null;
}

let seed = 4242;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
function sampled(part) {
  const out = { ...part.defaults };
  for (const g of part.parameters ?? []) for (const c of g.controls ?? []) {
    if (typeof out[c.key] === "number" && Number.isFinite(c.min) && Number.isFinite(c.max)) out[c.key] = c.min + rnd() * (c.max - c.min);
  }
  return out;
}

describe("placeMatrix", () => {
  it.each(PARTS)("%s: the light token reads what the probe reads", async (file) => {
    const part = (await import(`../src/parts/${file}`)).default;
    let compared = 0;
    for (const params of [part.defaults, sampled(part), sampled(part)]) {
      let r;
      try { r = resolveParams(part, { ...part.defaults, ...params }); } catch { continue; }
      for (const view of Object.keys(part.views ?? { assembly: 1 })) {
        let names;
        try { names = viewSubParts(part, view, r.p); } catch { continue; }
        for (const name of names) {
          expect(placeMatrix(part.parts[name], view, r.p, r.d), `${view} ${name}`).toEqual(probeMatrix(part.parts[name], view, r.p, r.d));
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(0);
  });

  it("falls back to the probe for anything but a rigid move", () => {
    const at = (place) => placeMatrix({ build: () => null, place }, "assembly", {}, {});
    expect(at((s) => s.translate([1, 2, 3]).rotateZ(90))).toEqual(probeMatrix({ build: () => null, place: (s) => s.translate([1, 2, 3]).rotateZ(90) }, "assembly", {}, {}));
    expect(at((s) => s.scale(2))).toBeNull();                       // reshapes
    expect(at((s) => s.translate([s.boundingBox().min[0], 0, 0]))).toBeNull(); // queries
    expect(at((s) => s.translate([NaN, 0, 0]))).toBeNull();         // non-finite
    expect(at(() => ({}))).toBeNull();                              // not a solid
    expect(at((s) => { throw new Error("no"); })).toBeNull();
    expect(at((s) => s.along("-Y").at([0, 0, 5]))).toEqual(probeMatrix({ build: () => null, place: (s) => s.along("-Y").at([0, 0, 5]) }, "assembly", {}, {}));
  });
});
