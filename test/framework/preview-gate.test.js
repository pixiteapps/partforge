// @vitest-environment happy-dom
// The "a cached preview is on screen" flag and the chrome it holds disabled
// (cutaway, measure, sketch): those modes need live solids and feature ids,
// which a preview mesh does not have.
import { expect, test } from "vitest";
import { createPreviewGate } from "../../src/framework/preview-gate.js";

const button = (disabled = false) => {
  const b = document.createElement("button");
  b.disabled = disabled;
  return b;
};

test("start disables every button and end gives each back the state it had", () => {
  const free = button();
  const held = button(true);
  const gate = createPreviewGate({ buttons: [free, held, null] });
  expect(gate.isActive()).toBe(false);
  gate.start();
  expect(gate.isActive()).toBe(true);
  expect([free.disabled, held.disabled]).toEqual([true, true]);
  gate.end();
  expect(gate.isActive()).toBe(false);
  expect([free.disabled, held.disabled]).toEqual([false, true]);
});

test("start and end are idempotent and announce only real transitions", () => {
  const gate = createPreviewGate();
  const seen = [];
  const off = gate.onChange((active) => seen.push(active));
  gate.end();
  gate.start();
  gate.start();
  gate.end();
  gate.end();
  expect(seen).toEqual([true, false]);
  off();
  gate.start();
  expect(seen).toEqual([true, false]);
});
