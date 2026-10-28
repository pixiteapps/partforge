// Unit tests for the OCCT failure-recovery helpers — pure logic, no OCCT boot.
// (The chamfer binary-search integration path is covered by the OCCT test files.)
import { expect, test, vi } from "vitest";
import { isClosedSolid, createOcctRepair } from "../src/framework/geometry/occt-repair.js";

// A fake replicad shape is anything with .mesh() → { vertices (flat), triangles (flat) }.
const shapeOf = (vertices, triangles) => ({ mesh: () => ({ vertices, triangles }) });

const TETRA_VERTS = [0, 0, 0, /*v0*/ 1, 0, 0, /*v1*/ 0, 1, 0, /*v2*/ 0, 0, 1 /*v3*/];

test("a closed tetrahedron is a closed solid (every edge shared by two triangles)", () => {
  const closed = shapeOf(TETRA_VERTS, [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3]);
  expect(isClosedSolid(closed)).toBe(true);
});

test("an open surface (missing face) is not a closed solid", () => {
  const open = shapeOf(TETRA_VERTS, [0, 1, 2, 0, 1, 3, 0, 2, 3]); // face 1-2-3 missing
  expect(isClosedSolid(open)).toBe(false);
});

test("coincident vertices are welded before the edge count (OCCT meshes faces separately)", () => {
  // v4 duplicates v0's position; one face references the duplicate. Without welding
  // the mesh looks open; welded by position it is the same closed tetrahedron.
  const verts = [...TETRA_VERTS, 0, 0, 0 /* v4 == v0 */];
  const welded = shapeOf(verts, [0, 1, 2, 4, 1, 3, 0, 2, 3, 1, 2, 3]);
  expect(isClosedSolid(welded)).toBe(true);
});

test("a triangle the weld collapses (a sphere's pole fan) is left out of the count", () => {
  // v4 sits within a 1/32 mm cell of v3, so triangle 3-4-1 welds to a sliver
  // with a repeated corner; OCCT's sphere poles mesh exactly like this.
  const verts = [...TETRA_VERTS, 0, 0, 1.001 /* v4 ≈ v3 */];
  const poled = shapeOf(verts, [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3, 3, 4, 1]);
  expect(isClosedSolid(poled)).toBe(true);
});

test("a mesh the weld collapses entirely is not a closed solid", () => {
  // one open triangle, every corner inside one 1/32 mm cell: no edge survives
  const speck = shapeOf([0, 0, 1, 0.01, 0, 1, 0, 0.01, 1], [0, 1, 2]);
  expect(isClosedSolid(speck)).toBe(false);
  expect(isClosedSolid(shapeOf([], []))).toBe(false);
});

test("safeOp returns the op's result when it yields real volume", () => {
  const { safeOp } = createOcctRepair((s) => s.vol);
  const backup = { marker: "backup", delete: vi.fn() };
  const shape = { clone: () => backup };
  const out = safeOp(shape, () => ({ vol: 5, marker: "result" }), "fillet(1)");
  expect(out.marker).toBe("result");
  expect(backup.delete).toHaveBeenCalled(); // the unused backup is freed
});

// A fake shape whose chamfer succeeds up to maxValid and throws beyond it —
// enough to drive validChamfer's first-try/bisection/skip paths without OCCT.
const CLOSED_TRIS = [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3];
const chamferable = (maxValid) => ({
  clone: () => chamferable(maxValid),
  chamfer(d) {
    if (d > maxValid) throw new Error("chamfer over-ran");
    return { vol: 1, chamferedAt: d, mesh: () => ({ vertices: TETRA_VERTS, triangles: CLOSED_TRIS }), delete: vi.fn() };
  },
});

test("validChamfer is silent when the requested distance fits (no rescue, one attempt)", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { validChamfer } = createOcctRepair((s) => s.vol);
  const out = validChamfer(chamferable(5), undefined, 2);
  expect(out.chamferedAt).toBe(2);
  expect(warn).not.toHaveBeenCalled();
  warn.mockRestore();
});

test("validChamfer's rescue warns with attempt count, elapsed time, and the pattern id", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { validChamfer } = createOcctRepair((s) => s.vol);
  const out = validChamfer(chamferable(1.4), undefined, 2); // over-large → bisection lands ≤ 1.4
  expect(out.chamferedAt).toBeGreaterThan(0);
  expect(out.chamferedAt).toBeLessThanOrEqual(1.4);
  expect(warn).toHaveBeenCalledTimes(1);
  const msg = warn.mock.calls[0][0];
  expect(msg).toContain("over-ran the geometry");
  expect(msg).toContain("reduced to");
  expect(msg).toMatch(/\d+ attempts, \d+\.\ds/);
  expect(msg).toContain("ERROR-PATTERNS.md#chamfer-rescue-bisection");
  warn.mockRestore();
});

test("validChamfer warns (and skips) when no distance is valid at all", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { validChamfer } = createOcctRepair((s) => s.vol);
  const original = chamferable(0); // every attempt throws
  const out = validChamfer(original, undefined, 2);
  expect(out.chamferedAt).toBeUndefined(); // untouched clone of the input
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][0]).toContain("no valid distance");
  expect(warn.mock.calls[0][0]).toContain("ERROR-PATTERNS.md#chamfer-rescue-bisection");
  warn.mockRestore();
});

test("safeOp falls back to the original when the op empties the solid or throws", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { safeOp } = createOcctRepair((s) => s.vol);
  const shape = { clone: () => ({ marker: "backup" }) };
  const emptied = safeOp(shape, () => ({ vol: 0, delete: vi.fn() }), "fillet(9)");
  expect(emptied.marker).toBe("backup");
  const threw = safeOp(shape, () => { throw new Error("BRepFilletAPI failed"); }, "fillet(9)");
  expect(threw.marker).toBe("backup");
  expect(warn).toHaveBeenCalledTimes(2); // both skips are discoverable in the console
  warn.mockRestore();
});
