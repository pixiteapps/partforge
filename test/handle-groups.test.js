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
  it("keeps only the candidate of each group nearest the pointer (its nearest dot)", () => {
    const hidden = groupHidden([
      { id: "a", group: "g", dist: 30 },
      { id: "b", group: "g", dist: 5 },
      { id: "c", group: "g", dist: 140 },
    ]);
    expect([...hidden].sort()).toEqual(["a", "c"]);
  });
  it("leaves handles with no group, and a group's lone candidate, alone", () => {
    expect(groupHidden([
      { id: "a", group: null, dist: 30 },
      { id: "b", group: null, dist: 5 },
      { id: "c", group: "g", dist: 500 },
    ]).size).toBe(0);
  });
  it("judges each group on its own", () => {
    const hidden = groupHidden([
      { id: "a1", group: "a", dist: 10 },
      { id: "a2", group: "a", dist: 20 },
      { id: "b1", group: "b", dist: 200 },
      { id: "b2", group: "b", dist: 100 },
    ]);
    expect([...hidden].sort()).toEqual(["a2", "b1"]);
  });
  it("a tie goes to the first candidate; one with no distance never wins over one that has it", () => {
    expect([...groupHidden([
      { id: "a", group: "g", dist: 10 },
      { id: "b", group: "g", dist: 10 },
    ])]).toEqual(["b"]);
    expect([...groupHidden([
      { id: "a", group: "g", dist: NaN },
      { id: "b", group: "g", dist: 300 },
    ])]).toEqual(["a"]);
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
