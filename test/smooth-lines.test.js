import { describe, it, expect } from "vitest";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { smoothLineMaterial } from "../src/framework/smooth-lines.js";

describe("smoothLineMaterial", () => {
  it("widens the quad and feathers its sides, and blends", () => {
    const m = smoothLineMaterial(new LineMaterial({ linewidth: 1 }));
    expect(m.defines.PF_SMOOTH_LINE).toBe("1.0");
    expect(m.vertexShader).toContain("offset *= linewidth + PF_SMOOTH_LINE;");
    expect(m.fragmentShader).toContain("fwidth( vUv.x )");
    expect(m.transparent).toBe(true);
  });
  it("survives clone() (the fade and cutaway copies) and is idempotent", () => {
    const m = smoothLineMaterial(new LineMaterial({ linewidth: 2 }));
    const c = m.clone();
    expect(c.defines.PF_SMOOTH_LINE).toBe("1.0");
    expect(c.fragmentShader).toBe(m.fragmentShader);
    const frag = m.fragmentShader;
    smoothLineMaterial(m);
    expect(m.fragmentShader).toBe(frag);
  });
  it("leaves anything else alone", () => {
    expect(smoothLineMaterial(null)).toBe(null);
    const o = { isLineMaterial: false };
    expect(smoothLineMaterial(o)).toBe(o);
  });
});
