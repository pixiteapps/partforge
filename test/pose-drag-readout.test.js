// @vitest-environment happy-dom
// Pose mode's live drag readout: the viewbar's readout slot, measure mode's spot.
import { afterEach, expect, test } from "vitest";
import { attachDragReadout } from "../src/framework/pose/drag-readout.js";
import { observeViewbarClear } from "../src/framework/viewbar-clear.js";

afterEach(() => { document.body.innerHTML = ""; });

function fakeMode(initial = null) {
  const listeners = new Set();
  let current = initial;
  return {
    onReadout: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    getReadout: () => current,
    emit(r) { current = r; for (const cb of listeners) cb(r); },
    count: () => listeners.size,
  };
}
const items = (w, d) => [
  { key: "width", label: "Width", unit: "mm", value: w, text: w.toFixed(1) },
  { key: "depth", label: "depth", unit: null, value: d, text: d.toFixed(1) },
];

test("a drag's values show in the viewbar's readout slot, live, and go when it ends", () => {
  const viewbar = document.createElement("div");
  viewbar.id = "viewbar";
  document.body.append(viewbar);
  const mode = fakeMode();
  const r = attachDragReadout(mode, { viewbar });
  const box = viewbar.querySelector(".pf-viewbar-readout.pf-pose-readout");
  expect(box.parentElement).toBe(viewbar);
  expect(box.hasAttribute("data-pf-viewbar-float")).toBe(true); // the view cube clears it
  expect(box.hidden).toBe(true);
  expect(r.text()).toBeNull();
  mode.emit({ handleId: "corner", text: "width 84.0 · depth 60.5", items: items(84, 60.5) });
  expect(box.hidden).toBe(false);
  const shown = [...box.querySelectorAll(".pf-pose-readout-item")];
  expect(shown.map((s) => s.textContent)).toEqual(["Width 84.0 mm", "depth 60.5"]);
  expect(shown.map((s) => s.querySelector(".pf-pose-readout-label").textContent)).toEqual(["Width", "depth"]);
  const first = shown[0];
  mode.emit({ handleId: "corner", text: "width 84.0 · depth 60.5", items: items(84, 60.5) });
  expect(box.querySelector(".pf-pose-readout-item")).toBe(first); // unchanged: not rebuilt
  mode.emit({ handleId: "corner", text: "width 90.0 · depth 60.5", items: items(90, 60.5) });
  expect(r.text()).toBe("Width 90.0 mmdepth 60.5");
  mode.emit(null);
  expect(box.hidden).toBe(true);
  expect(r.text()).toBeNull();
  r.detach();
  expect(viewbar.querySelector(".pf-pose-readout")).toBeNull();
  expect(mode.count()).toBe(0);
  r.detach(); // idempotent
});

test("attaching mid-drag shows the readout at once; no viewbar is a no-op", () => {
  const viewbar = document.createElement("div");
  document.body.append(viewbar);
  const r = attachDragReadout(fakeMode({ handleId: "lid", text: "angle 30", items: [{ key: "angle", label: "Lid", unit: "°", value: 30, text: "30" }] }), { viewbar });
  expect(r.text()).toBe("Lid 30 °");
  const none = attachDragReadout(fakeMode(), {});
  expect(none.text()).toBeNull();
  none.detach();
});

test("the slot counts toward the viewbar's clearance, as measure's readout does", () => {
  const stage = document.createElement("div");
  const viewbar = document.createElement("div");
  stage.append(viewbar);
  document.body.append(stage);
  const rect = (top, bottom) => () => ({ top, bottom, left: 0, right: 100, width: 100, height: bottom - top });
  stage.getBoundingClientRect = rect(0, 800);
  viewbar.getBoundingClientRect = rect(744, 788); // 56px claim
  const mode = fakeMode();
  attachDragReadout(mode, { viewbar });
  mode.emit({ handleId: "corner", text: "width 84.0", items: items(84, 60).slice(0, 1) });
  const box = viewbar.querySelector(".pf-pose-readout");
  box.getBoundingClientRect = rect(700, 738); // floated above the bar
  globalThis.ResizeObserver ??= class { observe() {} disconnect() {} };
  const dispose = observeViewbarClear(stage, viewbar);
  expect(stage.style.getPropertyValue("--pf-viewbar-clear")).toBe("100px");
  dispose();
});
