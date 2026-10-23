import { expect, test } from "vitest";
import { resolveProfile, overhangAngleFor, PROFILES } from "../src/framework/oracle/dfm-profiles.js";

const FDM_PLA = {
  bed: [220, 220, 250], minWall: 1.2, clearance: 0.2, overhang: 45, bedContact: 50,
  fits: { press: -0.1, push: 0.05, slip: 0.25, moving: 0.35, printInPlace: 0.45 },
  holeUndersize: 0.25, bridge: 10,
};

test("resolves a built-in profile by name", () => {
  expect(resolveProfile("fdm-pla")).toEqual(FDM_PLA);
  expect(Object.keys(PROFILES)).toContain("resin");
  expect(resolveProfile("resin").overhang).toBeUndefined(); // resin prints on supports
  expect(resolveProfile("resin").bridge).toBeUndefined();   // and bridges nothing
});

test("every profile carries the five fit classes, an undersize and a positive minWall", () => {
  for (const [name, p] of Object.entries(PROFILES)) {
    expect(Object.keys(p.fits).sort(), name).toEqual(["moving", "press", "printInPlace", "push", "slip"]);
    expect(p.fits.press, name).toBeLessThan(0);
    expect(p.fits.push, name).toBeLessThan(p.fits.slip);
    expect(p.fits.slip, name).toBeLessThan(p.fits.moving);
    expect(p.fits.moving, name).toBeLessThan(p.fits.printInPlace);
    expect(p.holeUndersize, name).toBeGreaterThan(0);
    expect(p.minWall, name).toBeGreaterThan(0);
  }
});

test("overhangAngleFor: opt-in needs BOTH the orientation key and a profile that carries an angle", () => {
  const fdm = { verify: { process: "fdm-pla" } };
  expect(overhangAngleFor(fdm)).toBeNull();                                                     // no orientation → not checked
  expect(overhangAngleFor({ verify: { process: "fdm-pla", orientation: "print" } })).toBe(45);
  expect(overhangAngleFor({ verify: { process: "resin", orientation: "print" } })).toBeNull();  // no angle to check against
  expect(overhangAngleFor({ verify: { orientation: "print" } })).toBeNull();                    // no profile at all
  expect(overhangAngleFor({ verify: { process: { base: "resin", overhang: 30 }, orientation: "print" } })).toBe(30);
  expect(overhangAngleFor({ verify: { process: "fdm-pla", orientation: "print" } }, "resin")).toBeNull(); // a process override wins
  expect(() => overhangAngleFor({ verify: { orientation: "sideways" } })).toThrow(/unknown verify.orientation/);
  // an author's own overhangArea expectation arms it too — profile angle, else the 45° default
  const asserted = { expanded: [{ expect: { body: { overhangArea: "<=1" } } }] };
  expect(overhangAngleFor({ verify: { process: "resin" } }, undefined, asserted)).toBe(45);
  expect(overhangAngleFor({ verify: {} }, undefined, asserted)).toBe(45);
  expect(overhangAngleFor({ verify: { process: { base: "fdm-pla", overhang: 30 } } }, undefined, asserted)).toBe(30);
  expect(overhangAngleFor({ verify: {} }, undefined, { expanded: [{ expect: { _view: { overhangArea: 1 } } }] })).toBeNull(); // _view is not a sub-part
});

test("accepts an inline profile object", () => {
  expect(resolveProfile({ bed: [100, 100, 100], minWall: 1 })).toEqual({ bed: [100, 100, 100], minWall: 1 });
});

test("merges overrides onto a named base", () => {
  expect(resolveProfile({ base: "fdm-pla", minWall: 2 })).toEqual({ ...FDM_PLA, minWall: 2 });
  expect(resolveProfile({ base: "fdm-pla", overhang: null }).overhang).toBeNull(); // an inline profile can switch it off
  // a calibrated printer overrides the whole fits table; a partial object replaces, never merges
  expect(resolveProfile({ base: "fdm-pla", fits: { press: -0.05, push: 0.02, slip: 0.15, moving: 0.25, printInPlace: 0.35 } }).fits.slip).toBe(0.15);
});

test("throws on an unknown profile name", () => {
  expect(() => resolveProfile("fdm-unobtainium")).toThrow();
  expect(() => resolveProfile(42)).toThrow();
});
