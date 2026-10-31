// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { attachPoseControls } from "../src/framework/pose/pose-controls.js";

function fakeMode() {
  let live = true;
  let pins = 0;
  const modeCbs = new Set(), pinCbs = new Set();
  return {
    isLive: () => live,
    setLive: (v) => { live = !!v; for (const cb of modeCbs) cb(); },
    pinCount: () => pins,
    releasePins: () => { pins = 0; for (const cb of pinCbs) cb(); },
    setPinCount: (n) => { pins = n; for (const cb of pinCbs) cb(); },
    onPinsChange: (cb) => { pinCbs.add(cb); return () => pinCbs.delete(cb); },
    onModeChange: (cb) => { modeCbs.add(cb); return () => modeCbs.delete(cb); },
  };
}

afterEach(() => { document.body.innerHTML = ""; });

describe("attachPoseControls", () => {
  it("is a no-op without a #viewbar", () => {
    const c = attachPoseControls({ domElement: document.createElement("canvas") }, fakeMode(), {});
    expect(() => c.detach()).not.toThrow();
  });

  it("draws no toggle; Release pins shows only while posing is live with a pin", () => {
    document.body.innerHTML = `<div id="viewbar"><button id="measure"></button></div>`;
    const viewbar = document.getElementById("viewbar");
    const mode = fakeMode();
    const c = attachPoseControls({ domElement: document.createElement("canvas") }, mode, { viewbar });
    const actions = document.querySelector(".pf-pose-actions");
    const release = document.querySelector(".pf-pose-release");
    expect(viewbar.firstElementChild).toBe(actions);
    expect(viewbar.querySelectorAll("button")).toHaveLength(2); // #measure + Release pins
    expect(actions.hidden).toBe(true); // live, but no pins

    mode.setPinCount(2);
    expect(actions.hidden).toBe(false);
    release.click();
    expect(mode.pinCount()).toBe(0);
    expect(actions.hidden).toBe(true);

    mode.setPinCount(1);
    expect(actions.hidden).toBe(false);
    mode.setLive(false); // measure/sketch/cutaway on: pins persist but the action hides
    expect(actions.hidden).toBe(true);
    mode.setLive(true);
    expect(actions.hidden).toBe(false);

    c.detach();
    expect(document.querySelector(".pf-pose-actions")).toBeNull();
    expect(viewbar.children).toHaveLength(1);
  });
});
