import { expect, test } from "vitest";
import { resolveProfile, overhangAngleFor, PROFILES } from "../src/framework/oracle/dfm-profiles.js";

test("resolves a built-in profile by name", () => {
  expect(resolveProfile("fdm-pla")).toEqual({ bed: [220, 220, 250], minWall: 1.2, clearance: 0.2, overhang: 45 });
  expect(Object.keys(PROFILES)).toContain("resin");
  expect(resolveProfile("resin").overhang).toBeUndefined(); // resin prints on supports
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
  expect(resolveProfile({ base: "fdm-pla", minWall: 2 })).toEqual({ bed: [220, 220, 250], minWall: 2, clearance: 0.2, overhang: 45 });
  expect(resolveProfile({ base: "fdm-pla", overhang: null }).overhang).toBeNull(); // an inline profile can switch it off
});

test("throws on an unknown profile name", () => {
  expect(() => resolveProfile("fdm-unobtainium")).toThrow();
  expect(() => resolveProfile(42)).toThrow();
});
