import { expect, test } from "vitest";
import { normalizeCollisions, isAllowed } from "../src/framework/collide/declaration.js";
import { pairKey, CONTACT_EPS } from "../src/framework/collide/pairs.js";
import * as gaps from "../src/framework/oracle/gaps.js";

test("normalizes an absent block to null", () => {
  expect(normalizeCollisions({})).toBeNull();
  expect(normalizeCollisions(undefined)).toBeNull();
});

test("defaults clearance and pose", () => {
  const d = normalizeCollisions({ collisions: {} });
  expect(d.clearance).toBe(1e-3);
  expect(d.pose).toBe(true);
  expect(d.allow.size).toBe(0);
});

test("takes declared clearance and pose", () => {
  const d = normalizeCollisions({ collisions: { clearance: 0.2, pose: false } });
  expect(d.clearance).toBe(0.2);
  expect(d.pose).toBe(false);
});

test("allow is order-insensitive", () => {
  const d = normalizeCollisions({ collisions: { allow: ["lid×base"] } });
  expect(isAllowed(d, "base", "lid")).toBe(true);
  expect(isAllowed(d, "lid", "base")).toBe(true);
  expect(isAllowed(d, "lid", "hinge")).toBe(false);
  expect(isAllowed(null, "lid", "base")).toBe(false);
});

test("gaps.js re-exports the pair leaf", () => {
  expect(gaps.pairKey).toBe(pairKey);
  expect(gaps.CONTACT_EPS).toBe(CONTACT_EPS);
});
