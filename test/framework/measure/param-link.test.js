// Heuristic dimension->param linking: read-keys ∩ value match, unique or null.
import { expect, test } from "vitest";
import { linkParam, paramMatches } from "../../../src/framework/measure/param-link.js";

const params = { bore_d: 8, height: 30, wall: 2.5, slots: 4 };

test("unique value match links", () => {
  expect(linkParam(["bore_d", "wall"], params, { diameter: 8, depth: 12 })).toBe("bore_d");
});

test("radius-style param matches a measured diameter at value/2", () => {
  expect(linkParam(["wall"], { wall: 4 }, { diameter: 8 })).toBe("wall");
});

test("ambiguous match -> null (never guess)", () => {
  expect(linkParam(["a", "b"], { a: 8, b: 8 }, { diameter: 8 })).toBeNull();
});

test("no candidates or no match -> null", () => {
  expect(linkParam([], params, { diameter: 8 })).toBeNull();
  expect(linkParam(["height"], params, { diameter: 8.2 })).toBeNull();
});

test("matches within the 0.01 quantum only", () => {
  expect(linkParam(["wall"], { wall: 2.5 }, { width: 2.504 })).toBe("wall");
  expect(linkParam(["wall"], { wall: 2.5 }, { width: 2.52 })).toBeNull();
});

test("non-numeric params and the partial flag are ignored", () => {
  expect(linkParam(["style"], { style: "hex" }, { diameter: 8, partial: false })).toBeNull();
});

test("radius match uses the same half-quantum tolerance as direct match", () => {
  expect(linkParam(["wall"], { wall: 4 }, { diameter: 8.004 })).toBe("wall");
  expect(linkParam(["wall"], { wall: 4 }, { diameter: 8.009 })).toBeNull();
});

test("direct and radius matches compete for uniqueness", () => {
  // height matches diameter directly; wall matches at value*2 — ambiguous, so null
  expect(linkParam(["height", "wall"], { height: 8, wall: 4 }, { diameter: 8 })).toBeNull();
});

test("angle and percent controls never match a length (⌀30 does not flash 30°)", () => {
  const units = { bore_d: "mm", tilt: "°", spin: "deg", turn: "rad", fill: "%", plain: undefined };
  const unitOf = (k) => units[k];
  const params = { bore_d: 30, tilt: 30, spin: 30, turn: 30, fill: 30, plain: 30 };
  expect(paramMatches(Object.keys(params), params, { diameter: 30 }, unitOf).sort()).toEqual(["bore_d", "plain"]);
  expect(linkParam(["bore_d", "tilt"], params, { diameter: 30 }, unitOf)).toBe("bore_d");
});
