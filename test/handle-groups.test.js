import { describe, it, expect } from "vitest";
import { groupOf, groupHidden, cueHandleIds } from "../src/framework/pose/handle-groups.js";

describe("groupOf", () => {
  it("is a handle's group name, or null for none or a malformed one", () => {
    expect(groupOf({ group: "gears" })).toBe("gears");
    expect(groupOf({})).toBeNull();
    expect(groupOf({ group: "" })).toBeNull();
    expect(groupOf({ group: 3 })).toBeNull();
    expect(groupOf(null)).toBeNull();
  });
});

describe("groupHidden", () => {
  const pointer = { x: 100, y: 100 };
  it("keeps only the candidate of each group whose grab point is nearest the pointer", () => {
    const hidden = groupHidden([
      { id: "a", group: "g", x: 130, y: 100 },
      { id: "b", group: "g", x: 105, y: 100 },
      { id: "c", group: "g", x: 0, y: 0 },
    ], pointer);
    expect([...hidden].sort()).toEqual(["a", "c"]);
  });
  it("leaves handles with no group, and a group's lone candidate, alone", () => {
    expect(groupHidden([
      { id: "a", group: null, x: 130, y: 100 },
      { id: "b", group: null, x: 105, y: 100 },
      { id: "c", group: "g", x: 500, y: 500 },
    ], pointer).size).toBe(0);
  });
  it("judges each group on its own", () => {
    const hidden = groupHidden([
      { id: "a1", group: "a", x: 110, y: 100 },
      { id: "a2", group: "a", x: 120, y: 100 },
      { id: "b1", group: "b", x: 300, y: 100 },
      { id: "b2", group: "b", x: 200, y: 100 },
    ], pointer);
    expect([...hidden].sort()).toEqual(["a2", "b1"]);
  });
  it("a tie goes to the first candidate; one with no screen point never wins over one that has it", () => {
    expect([...groupHidden([
      { id: "a", group: "g", x: 110, y: 100 },
      { id: "b", group: "g", x: 90, y: 100 },
    ], pointer)]).toEqual(["b"]);
    expect([...groupHidden([
      { id: "a", group: "g", x: NaN, y: NaN },
      { id: "b", group: "g", x: 400, y: 100 },
    ], pointer)]).toEqual(["a"]);
  });
});

describe("cueHandleIds", () => {
  const handles = {
    lone: {},
    g2: { group: "gears" },
    g1: { group: "gears" },
    p1: { group: "pulls" },
    other: { group: "" },
  };
  it("keeps every ungrouped handle and the first-declared shown handle of each group", () => {
    // shown in any order; the key order of `handles` decides
    expect([...cueHandleIds(handles, ["g1", "g2", "lone", "p1", "other"])].sort()).toEqual(["g2", "lone", "other", "p1"]);
  });
  it("a group's first handle the view hides hands the mark to the next one shown", () => {
    expect([...cueHandleIds(handles, ["g1", "lone"])].sort()).toEqual(["g1", "lone"]);
  });
});
