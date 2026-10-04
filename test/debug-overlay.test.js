// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { createDebugOverlay } from "../src/framework/debug-overlay.js";

afterEach(() => { document.getElementById("pf-debug")?.remove(); });

test("creating the overlay adds #pf-debug with a checkbox reflecting initialCachingOn", () => {
  createDebugOverlay({ initialCachingOn: true, onToggle: () => {} });
  const box = document.getElementById("pf-debug");
  expect(box).toBeTruthy();
  expect(box.querySelector("input[type=checkbox]").checked).toBe(true);
});

test("ticking the checkbox calls onToggle with the new value", () => {
  const onToggle = vi.fn();
  createDebugOverlay({ initialCachingOn: true, onToggle });
  const cb = document.querySelector("#pf-debug input[type=checkbox]");
  cb.checked = false;
  cb.dispatchEvent(new Event("change"));
  expect(onToggle).toHaveBeenCalledWith(false);
});

test("update() writes the build time and counts", () => {
  const o = createDebugOverlay({ initialCachingOn: true, onToggle: () => {} });
  o.update({ ms: 123, hits: 12, misses: 3, skipped: 1, rebuilt: 2, posed: 4 });
  const text = document.getElementById("pf-debug").textContent;
  expect(text).toContain("123 ms");
  expect(text).toContain("12 hit / 3 miss");
  expect(text).toContain("1 skipped / 2 rebuilt / 4 posed");
});

test("every count starts at zero and the build time at an em dash", () => {
  const o = createDebugOverlay({ initialCachingOn: true, onToggle: () => {} });
  o.update({ ms: 10, skipped: 1, rebuilt: 0 });
  expect(document.getElementById("pf-debug").textContent)
    .toContain("1 skipped / 0 rebuilt / 0 posed");
});

// A pose-only edit reports just `posed` — it ran no build and no cache ops, so a
// non-merging update would blank the last build's numbers on its way to showing it.
test("a partial update merges over what's already shown", () => {
  const o = createDebugOverlay({ initialCachingOn: true, onToggle: () => {} });
  o.update({ ms: 123, hits: 12, misses: 3, skipped: 1, rebuilt: 2, posed: 0 });
  o.update({ posed: 1 });
  const text = document.getElementById("pf-debug").textContent;
  expect(text).toContain("123 ms");
  expect(text).toContain("12 hit / 3 miss");
  expect(text).toContain("1 skipped / 2 rebuilt / 1 posed");
});

test("when caching is off, the L2 line reads 'off'", () => {
  const o = createDebugOverlay({ initialCachingOn: false, onToggle: () => {} });
  o.update({ ms: 50, hits: 0, misses: 0, skipped: 0, rebuilt: 1 });
  const text = document.getElementById("pf-debug").textContent;
  expect(text).toContain("L2 ops: off");
});

test("the delivery-frame summary rides the L1 parts line once reported", () => {
  const o = createDebugOverlay({ initialCachingOn: true, onToggle: () => {} });
  o.update({ skipped: 0, rebuilt: 4 });
  expect(document.getElementById("pf-debug").textContent).not.toContain("canonical");
  o.update({ frame: "3 canonical / 1 posed" });
  expect(document.getElementById("pf-debug").textContent)
    .toContain("L1 parts: 0 skipped / 4 rebuilt / 0 posed · 3 canonical / 1 posed");
});
