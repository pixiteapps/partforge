import { expect, test } from "vitest";
import { h, startHashRecording, stopHashRecording } from "../src/framework/geometry/solid-hash.js";

test("records op, inputs and label for each h() call", () => {
  startHashRecording();
  const a = h("cylinder", 4, 4, 10, false, 32);
  const b = h("box", [0, 0, 0], [5, 5, 5]);
  const c = h("cut", a, b);
  const l = h("label", c, "boss");
  const u = h("union", [l, b]);
  const rec = stopHashRecording();
  expect(rec.get(a)).toEqual({ op: "cylinder", inputs: [], label: null });
  expect(rec.get(c)).toEqual({ op: "cut", inputs: [a, b], label: null });
  expect(rec.get(l)).toEqual({ op: "label", inputs: [c], label: "boss" });
  expect(rec.get(u).inputs).toEqual([l, b]);
});

test("not recording: h() is unchanged and stop returns null", () => {
  expect(stopHashRecording()).toBeNull();
  expect(h("box", 1)).toBe(h("box", 1));
});

test("overflow past the limit returns null rather than a partial graph", () => {
  startHashRecording({ limit: 3 });
  for (let i = 0; i < 5; i++) h("box", i);
  expect(stopHashRecording()).toBeNull();
});
