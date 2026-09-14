import { test, expect } from "vitest";
import { validateProfile } from "../src/framework/geometry/contour-ops.js";

test("a clean region validates ok", () => {
  const region = { outer: [[0, 0], [20, 0], [20, 20], [0, 20]], holes: [[[5, 5], [5, 15], [15, 15], [15, 5]]] };
  expect(validateProfile(region)).toEqual({ ok: true, issues: [] });
});

test("a bowtie self-intersects", () => {
  const bow = [[0, 0], [10, 10], [10, 0], [0, 10]];
  const r = validateProfile(bow);
  expect(r.ok).toBe(false);
  expect(r.issues[0].type).toBe("self-intersection");
  expect(r.issues[0].point[0]).toBeCloseTo(5, 6);
});

test("a hole touching its outer is a cross-contour contact, tagged `crosses`", () => {
  // The hole's mouth sits ON the outer's bottom edge. The solid builds exactly as
  // drawn; validateProfile still files the contact under self-intersection, so the
  // `crosses` key is what separates it from a contour crossing ITSELF (the bowtie
  // below carries no such key). profile-warnings.js reports only the latter.
  const r = validateProfile({ outer: [[0, 0], [20, 0], [20, 10], [0, 10]], holes: [[[5, 0], [5, 5], [10, 5], [10, 0]]] });
  const hits = r.issues.filter((i) => i.type === "self-intersection");
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.every((i) => i.crosses === 1)).toBe(true);
  expect(validateProfile([[0, 0], [10, 10], [10, 0], [0, 10]]).issues
    .filter((i) => i.type === "self-intersection")
    .every((i) => !("crosses" in i))).toBe(true);
});

test("a CW outer is a winding issue (when passed as an explicit region)", () => {
  const r = validateProfile({ outer: [[0, 0], [0, 10], [10, 10], [10, 0]], holes: [] });
  expect(r.issues.some((i) => i.type === "winding")).toBe(true);
});

test("a hole outside its outer is a nesting issue", () => {
  const r = validateProfile({ outer: [[0, 0], [10, 0], [10, 10], [0, 10]], holes: [[[20, 20], [22, 20], [22, 22], [20, 22]]] });
  expect(r.issues.some((i) => i.type === "nesting")).toBe(true);
});

test("zero-length segments are degenerate", () => {
  const ct = { start: [0, 0], segments: [{ to: [10, 0] }, { to: [10, 0] }, { to: [10, 10] }, { to: [0, 10] }, { to: [0, 0] }] };
  const r = validateProfile(ct);
  expect(r.issues.some((i) => i.type === "degenerate" && i.segmentIndex === 1)).toBe(true);
  // Completeness: the duplicate point must NOT also register as a self-intersection — the
  // real edges on either side of it are still adjacent (they touch at the shared vertex,
  // not a genuine crossing), so exactly the one degenerate issue should come back.
  expect(r.issues).toEqual([
    { type: "degenerate", contourIndex: 0, segmentIndex: 1, message: expect.any(String) },
  ]);
});

test("two overlapping outers across regions are a nesting issue", () => {
  const r = validateProfile([
    { outer: [[0, 0], [10, 0], [10, 10], [0, 10]], holes: [] },
    { outer: [[5, 5], [15, 5], [15, 15], [5, 15]], holes: [] },
  ]);
  expect(r.issues.some((i) => i.type === "nesting")).toBe(true);
});

test("a self-intersecting cubic is flagged with the owning segment's index", () => {
  // A single cubic that leaves and returns to the same neighborhood, its control points
  // flared out asymmetrically enough that the curve crosses itself mid-span (not just at
  // an endpoint) — closed off with a line back to the start.
  const ct = { start: [0, 0], segments: [
    { to: [10, 0], c1: [20, 20], c2: [-10, 20] },
    { to: [0, 0] },
  ] };
  const r = validateProfile(ct);
  expect(r.ok).toBe(false);
  const hit = r.issues.find((i) => i.type === "self-intersection");
  expect(hit).toBeTruthy();
  expect(hit.contourIndex).toBe(0);
  expect(hit.segmentIndex).toBe(0);          // the cubic, not the closing line
  expect(hit.point[0]).toBeCloseTo(5, 6);
  expect(hit.point[1]).toBeCloseTo(6.131386861313868, 6);
  expect(hit.message).not.toMatch(/or crosses contour/);   // same-contour crossing: no cross-contour suffix
});

test("a clean cubic loop validates ok", () => {
  // Bulges out from the origin and back to it (large control net, zero chord — real shape,
  // not degenerate) without crossing itself.
  const ct = { start: [0, 0], segments: [{ to: [0, 0], c1: [10, 10], c2: [10, -10] }] };
  expect(validateProfile(ct)).toEqual({ ok: true, issues: [] });
});

test("a clean arc-based contour validates ok", () => {
  const ct = { start: [0, 0], segments: [{ to: [10, 0], via: [5, 5] }, { to: [0, 0] }] };
  expect(validateProfile(ct)).toEqual({ ok: true, issues: [] });
});

test("an all-NaN contour reports ok:false instead of silently passing", () => {
  const ct = { start: [NaN, NaN], segments: [
    { to: [NaN, NaN] }, { to: [NaN, NaN] }, { to: [NaN, NaN] }, { to: [NaN, NaN] },
  ] };
  const r = validateProfile(ct);
  expect(r.ok).toBe(false);
  expect(r.issues.length).toBeGreaterThan(0);
  expect(r.issues.every((i) => i.type === "degenerate" && /non-finite/.test(i.message))).toBe(true);
});
