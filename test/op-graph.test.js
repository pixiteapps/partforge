import { expect, test } from "vitest";
import { ancestry, changedRoots } from "../src/framework/oracle/op-graph.js";

const rec = (entries) => new Map(entries.map(([k, op, inputs = [], label = null]) => [k, { op, inputs, label }]));

test("ancestry walks back through inputs only", () => {
  const r = rec([["a", "box"], ["b", "cylinder"], ["c", "cut", ["a", "b"]], ["x", "sphere"]]);
  expect([...ancestry(r, "c")].sort()).toEqual(["a", "b", "c"]);
});

test("a changed primitive is the root; its downstream label names it", () => {
  const r = rec([["a2", "cylinder"], ["b", "box"], ["c2", "cut", ["b", "a2"]], ["l2", "label", ["c2"], "boss"]]);
  const baseline = new Set(["a1", "b", "c1", "l1"]);
  expect(changedRoots(r, "l2", baseline)).toEqual([{ op: "cylinder", label: "boss" }]);
});

test("unchanged graph has no roots", () => {
  const r = rec([["a", "box"], ["c", "translate", ["a"]]]);
  expect(changedRoots(r, "c", new Set(["a", "c"]))).toEqual([]);
});

test("a renamed label is its own root", () => {
  const r = rec([["c", "cut"], ["l2", "label", ["c"], "lid rim"]]);
  expect(changedRoots(r, "l2", new Set(["c", "l1"]))).toEqual([{ op: "label", label: "lid rim" }]);
});

test("unlabelled roots omit label; max caps the list", () => {
  const r = rec([["p1", "box"], ["p2", "box"], ["p3", "box"], ["u", "union", ["p1", "p2", "p3"]]]);
  expect(changedRoots(r, "u", new Set(), { max: 2 })).toEqual([{ op: "box" }, { op: "box" }]);
});

test("an input missing from the record does not block a root", () => {
  const r = rec([["t", "translate", ["unrecorded"]]]);
  expect(changedRoots(r, "t", new Set())).toEqual([{ op: "translate" }]);
});
