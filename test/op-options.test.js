// test/op-options.test.js
// Pure unit tests for the options-object normalizers — no WASM, no kernel boot.
import { expect, test } from "vitest";
import { isPlainOptions, cylinderArgs, sphereArgs, boxArgs } from "../src/framework/geometry/op-options.js";
import { prismArgs, extrudeArgs, revolveArgs, loftArgs, sweepArgs, KERNEL_OP_SPECS, SOLID_OP_SPECS }
  from "../src/framework/geometry/op-options.js";

test("isPlainOptions accepts plain objects only", () => {
  expect(isPlainOptions({})).toBe(true);
  expect(isPlainOptions(Object.create(null))).toBe(true);
  expect(isPlainOptions([1, 2, 3])).toBe(false);
  expect(isPlainOptions(null)).toBe(false);
  expect(isPlainOptions(7)).toBe(false);
  expect(isPlainOptions("x")).toBe(false);
  expect(isPlainOptions(new Float32Array(3))).toBe(false);
  class Handle {}
  expect(isPlainOptions(new Handle())).toBe(false);
});

test("cylinderArgs resolves r/d and r1+r2/d1+d2 to [rBottom, rTop, h]", () => {
  expect(cylinderArgs({ r: 4, h: 10 })).toEqual([4, 4, 10]);
  expect(cylinderArgs({ d: 8, h: 10 })).toEqual([4, 4, 10]);
  expect(cylinderArgs({ r1: 3, r2: 1, h: 5 })).toEqual([3, 1, 5]);
  expect(cylinderArgs({ d1: 6, d2: 2, h: 5 })).toEqual([3, 1, 5]);
  expect(cylinderArgs({ r: 4, h: 10, center: true })).toEqual([4, 4, 10, { center: true }]);
});

test("cylinderArgs rejects bad radius vocabulary", () => {
  const BAD = "cylinder: pass exactly one of r/d, or r1+r2 / d1+d2";
  expect(() => cylinderArgs({ r: 4, d: 8, h: 1 })).toThrow(BAD);   // both
  expect(() => cylinderArgs({ h: 1 })).toThrow(BAD);               // neither
  expect(() => cylinderArgs({ r: 4, r1: 1, h: 1 })).toThrow(BAD);  // straight + cone
  expect(() => cylinderArgs({ r1: 1, h: 1 })).toThrow(BAD);        // one cone end
  expect(() => cylinderArgs({ r1: 1, d2: 2, h: 1 })).toThrow(BAD); // mixed cone vocab
  expect(() => cylinderArgs({ r: 4 })).toThrow("cylinder: h is required");
});

test("unknown keys error with a did-you-mean hint", () => {
  expect(() => cylinderArgs({ radius: 4, h: 1 }))
    .toThrow('cylinder: unknown option "radius" — did you mean r?');
  expect(() => cylinderArgs({ height: 4, r: 1 }))
    .toThrow('cylinder: unknown option "height" — did you mean h?');
  // no plausible hint → list valid keys
  expect(() => boxArgs({ frobnicate: 1 }))
    .toThrow('box: unknown option "frobnicate" (valid: size, center, min, max)');
});

test("sphereArgs takes exactly one of r/d", () => {
  expect(sphereArgs({ r: 5 })).toEqual([5]);
  expect(sphereArgs({ d: 10 })).toEqual([5]);
  expect(() => sphereArgs({ r: 5, d: 10 })).toThrow("sphere: pass exactly one of r/d");
  expect(() => sphereArgs({})).toThrow("sphere: pass exactly one of r/d");
});

test("boxArgs: size is centered in X/Y with base at z=0; center:true centers Z too", () => {
  expect(boxArgs({ size: [4, 6, 10] })).toEqual([[-2, -3, 0], [2, 3, 10]]);
  expect(boxArgs({ size: [4, 6, 10], center: true })).toEqual([[-2, -3, -5], [2, 3, 5]]);
  expect(boxArgs({ min: [0, 0, 0], max: [1, 2, 3] })).toEqual([[0, 0, 0], [1, 2, 3]]);
  expect(() => boxArgs({ size: [1, 1, 1], min: [0, 0, 0], max: [1, 1, 1] }))
    .toThrow("box: pass size or min+max, not both");
  expect(() => boxArgs({ min: [0, 0, 0] })).toThrow("box: max is required");
  expect(() => boxArgs({})).toThrow("box: size is required");
});

const TRI = [[0, 0], [10, 0], [0, 10]];

test("prism/extrude normalize with an options tail only when needed", () => {
  expect(prismArgs({ points: TRI, h: 5 })).toEqual([TRI, 5]);            // no empty {} tail
  expect(prismArgs({ points: TRI, h: 5, twist: 30, scaleTop: 0.5 })).toEqual([TRI, 5, { twist: 30, scaleTop: 0.5 }]);
  expect(extrudeArgs({ profile: TRI, h: 5 })).toEqual([TRI, 5]);
  expect(extrudeArgs({ profile: { outer: TRI }, h: 5, scaleTop: 0.5 })).toEqual([{ outer: TRI }, 5, { scaleTop: 0.5 }]);
  expect(() => prismArgs({ h: 5 })).toThrow("prism: points is required");
  expect(() => extrudeArgs({ profile: TRI })).toThrow("extrude: h is required");
});

test("revolve/loft/sweep normalize", () => {
  const RZ = [[0, 0], [5, 0], [5, 8], [0, 8]];
  expect(revolveArgs({ profile: RZ })).toEqual([RZ]);
  expect(revolveArgs({ profile: RZ, degrees: 90 })).toEqual([RZ, { degrees: 90 }]);
  const RINGS = [{ sides: 6, radius: 5, z: 0 }, { sides: 6, radius: 3, z: 10 }];
  expect(loftArgs({ rings: RINGS })).toEqual([RINGS]);
  expect(loftArgs({ rings: RINGS, ruled: true, closed: false })).toEqual([RINGS, { ruled: true, closed: false }]);
  const PATH = [[0, 0, 0], [0, 0, 20]];
  expect(sweepArgs({ profile: TRI, path: PATH })).toEqual([TRI, PATH]);
  expect(sweepArgs({ profile: TRI, path: PATH, cornerRadius: 2, smooth: true })).toEqual([TRI, PATH, { cornerRadius: 2, smooth: true }]);
  expect(() => sweepArgs({ profile: TRI })).toThrow("sweep: path is required");
  expect(() => loftArgs({})).toThrow("loft: rings is required");
});

test("KERNEL_OP_SPECS carries the semantic checks (both calling forms)", () => {
  expect(Object.keys(KERNEL_OP_SPECS).sort()).toEqual(
    // loftSmooth: the spline-interpolated loft compound op (see KERNEL-CONTRACT.md).
    // heightfield: depth-map relief solid (see KERNEL-CONTRACT.md).
    // tappedBore: a tapped hole as one cut tool (see KERNEL-CONTRACT.md).
    ["boredCylinder", "box", "cylinder", "extrude", "heightfield", "helixSweptTube", "implicit", "loft", "loftSmooth", "prism", "revolve", "roundedBox", "roundedCylinder", "screwSweep", "sphere", "sweep", "tappedBore", "torus"]);
  expect(() => KERNEL_OP_SPECS.prism.check(TRI, 5, { scaleTop: -1 })).toThrow("prism: scaleTop must be ≥ 0");
  expect(() => KERNEL_OP_SPECS.extrude.check(TRI, 5, { scaleTop: -1 })).toThrow("extrude: scaleTop must be ≥ 0");
  expect(() => KERNEL_OP_SPECS.revolve.check([[-1, 0]])).toThrow("revolve: profile radius must be ≥ 0");
  expect(KERNEL_OP_SPECS.prism.check(TRI, 5, { scaleTop: 0.5 })).toBeUndefined();
});

test("options-only compound ops validate keys and pass the object through", () => {
  const bored = { od: 8, h: 10, bore: 3 };
  expect(KERNEL_OP_SPECS.boredCylinder.toArgs(bored)).toEqual([bored]);
  expect(() => KERNEL_OP_SPECS.boredCylinder.toArgs({ od: 8, h: 10, boreDiameter: 3 }))
    .toThrow('boredCylinder: unknown option "boreDiameter" — did you mean bore?');
  expect(() => KERNEL_OP_SPECS.boredCylinder.toArgs({ od: 8, h: 10 })).toThrow("boredCylinder: bore is required");
  const helix = { pathR: 10, profileR: 1.5, pitch: 4, turns: 3, z0: 2, lefthand: true };
  expect(KERNEL_OP_SPECS.helixSweptTube.toArgs(helix)).toEqual([helix]);
  expect(() => KERNEL_OP_SPECS.helixSweptTube.toArgs({ pathR: 10, profileR: 1.5, pitch: 4 }))
    .toThrow("helixSweptTube: turns is required");
  expect(() => KERNEL_OP_SPECS.helixSweptTube.toArgs({ ...helix, radius: 2 }))
    .toThrow('helixSweptTube: unknown option "radius"');
  const screw = { profile: [[4, 0], [5, 0.5], [4, 1]], pitch: 2, turns: 3, lefthand: true };
  expect(KERNEL_OP_SPECS.screwSweep.toArgs(screw)).toEqual([screw]);
  expect(() => KERNEL_OP_SPECS.screwSweep.toArgs({ profile: [[4, 0]], pitch: 2 }))
    .toThrow("screwSweep: turns is required");
  expect(() => KERNEL_OP_SPECS.screwSweep.toArgs({ ...screw, chordTolerance: 0.02 }))
    .toThrow('screwSweep: unknown option "chordTolerance"');
  expect(() => KERNEL_OP_SPECS.screwSweep.check({ ...screw, pitch: 0 }))
    .toThrow("screwSweep: pitch must be > 0");
  expect(() => KERNEL_OP_SPECS.screwSweep.check({ ...screw, turns: 0 }))
    .toThrow("screwSweep: turns must be > 0");
  const smooth = { sections: [{ sides: 6, radius: 5, z: 0 }, { sides: 6, radius: 3, z: 8 }], closed: false };
  expect(KERNEL_OP_SPECS.loftSmooth.toArgs(smooth)).toEqual([smooth]);
  expect(() => KERNEL_OP_SPECS.loftSmooth.toArgs({ ...smooth, loop: true }))
    .toThrow('loftSmooth: unknown option "loop"');
});

test("box: center mixed with min/max gets its own message", () => {
  expect(() => boxArgs({ min: [0, 0, 0], max: [1, 1, 1], center: true }))
    .toThrow("box: center only applies to the size form");
});

test("did-you-mean recombines digit suffixes (radius1 → r1)", () => {
  expect(() => cylinderArgs({ radius1: 5, r2: 1, h: 3 }))
    .toThrow('cylinder: unknown option "radius1" — did you mean r1?');
});

test("SOLID_OP_SPECS: fillet/chamfer/shell", () => {
  expect(SOLID_OP_SPECS.fillet.toArgs({ r: 2 })).toEqual([2]);
  expect(SOLID_OP_SPECS.fillet.toArgs({ r: 2, edges: { dir: "Z" } })).toEqual([2, { dir: "Z" }]);
  expect(() => SOLID_OP_SPECS.fillet.toArgs({ edges: { dir: "Z" } })).toThrow("fillet: r is required");
  expect(SOLID_OP_SPECS.chamfer.toArgs({ d: 1, edges: { at: 0 } })).toEqual([1, { at: 0 }]);
  expect(SOLID_OP_SPECS.shell.toArgs({ t: 2, open: { face: "+Z" } })).toEqual([2, { face: "+Z" }]);
  expect(() => SOLID_OP_SPECS.shell.toArgs({ t: 2 })).toThrow("shell: open is required");
});
