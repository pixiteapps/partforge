import { describe, expect, it } from "vitest";
import { prepareMaterial, prepareLights, shade } from "../src/framework/softrender/shade.js";
import { dfgLut } from "../src/framework/softrender/dfgLut.js";
import { RENDER_STYLES, srgbHexToLinear } from "../src/framework/renderStyles.js";

const out = () => new Float32Array(3);
const noDir = (lights) => ({ ...lights, directional: [] });

describe("dfgLut", () => {
  it("matches three's table at known texels (half-float decode + clamp)", () => {
    // Row 15 (dotNV = 1), column 0: scale 1.0, bias 0.
    const [s, b] = dfgLut(0, 1);
    expect(s).toBeCloseTo(1, 6);
    expect(b).toBeCloseTo(0, 6);
    // Row 0, column 0 is 0x30b5 / 0x3ad1.
    const [s0, b0] = dfgLut(0, 0);
    expect(s0).toBeCloseTo(0.1471, 3);
    expect(b0).toBeCloseTo(0.8523, 3);
  });
});

describe("prepareMaterial", () => {
  it("splits base colour by metalness the way three does", () => {
    const m = prepareMaterial({ color: 0xffffff, metalness: 0.25, roughness: 0.01 });
    expect(m.diffuse).toEqual([0.75, 0.75, 0.75]);
    m.f0.forEach((c) => expect(c).toBeCloseTo(0.04 * 0.75 + 0.25, 9));
    expect(m.roughness).toBe(0.0525); // three's floor
  });
});

describe("shade", () => {
  const pose = { position: [0, 0, 10], up: [0, 1, 0], target: [0, 0, 0] };
  const L = prepareLights(RENDER_STYLES.cad.lights, pose);
  const white = prepareMaterial({ color: 0xffffff, metalness: 0, roughness: 1 });

  it("hemisphere only: a normal straight up gets sky · diffuse / π", () => {
    const o = out();
    shade([0, 1, 0], [0, 0, 1], white, noDir(L), o, 0);
    const sky = srgbHexToLinear(0xdce9ff).map((c) => c * 1.35);
    [0, 1, 2].forEach((i) => expect(o[i]).toBeCloseTo(sky[i] / Math.PI, 6));
  });

  it("a straight-down normal gets the ground colour", () => {
    const o = out();
    shade([0, -1, 0], [0, 0, 1], white, noDir(L), o, 0);
    const ground = srgbHexToLinear(0x687586).map((c) => c * 1.35);
    expect(o[0]).toBeCloseTo(ground[0] / Math.PI, 6);
  });

  it("one light, N = L = V: direct = diffuse/π + single GGX + multiscatter, in closed form", () => {
    const lights = { sky: [0, 0, 0], ground: [0, 0, 0], up: [0, 1, 0], directional: [{ dir: [0, 0, 1], color: [1, 1, 1] }] };
    const o = out();
    shade([0, 0, 1], [0, 0, 1], white, lights, o, 0);
    const fresnel = 2 ** (-5.55473 - 6.98316);
    const F = 0.04 * (1 - fresnel) + fresnel;
    const [a, b] = dfgLut(1, 1);
    const fss = 0.04 * a + b, ems = 1 - (a + b), favg = 0.04 + 0.96 / 21;
    const multi = ((fss * fss * favg) / (1 - ems * ems * favg + 1e-6)) * ems * ems;
    expect(o[0]).toBeCloseTo(1 / Math.PI + (F * 0.25) / Math.PI + multi, 6);
  });

  it("a light behind the surface adds nothing", () => {
    const m = prepareMaterial({ color: 0xffffff, metalness: 0, roughness: 0.5 });
    const lights = { sky: [0, 0, 0], ground: [0, 0, 0], up: [0, 1, 0], directional: [{ dir: [0, 0, -1], color: [1, 1, 1] }] };
    const o = out();
    shade([0, 0, 1], [0, 0, 1], m, lights, o, 0);
    expect([...o]).toEqual([0, 0, 0]);
  });

  it("prepareLights places cad lights camera-relative and pre-multiplies intensity", () => {
    expect(L.directional).toHaveLength(2);
    const k = L.directional[0].dir;
    expect(Math.hypot(...k)).toBeCloseTo(1);
    expect(k[0]).toBeGreaterThan(0); expect(k[1]).toBeGreaterThan(0); // up-right of the view axis
    expect(L.directional[0].color[0]).toBeCloseTo(1.45);
  });
});
