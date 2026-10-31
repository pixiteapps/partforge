// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { attachPoseControls } from "../src/framework/pose/pose-controls.js";

function fakeMode() {
  let on = false;
  let pins = 0;
  const modeCbs = new Set(), pinCbs = new Set();
  return {
    isEnabled: () => on,
    setEnabled: (v) => { on = !!v; for (const cb of modeCbs) cb(); },
    pinCount: () => pins,
    releasePins: () => { pins = 0; for (const cb of pinCbs) cb(); },
    setPinCount: (n) => { pins = n; for (const cb of pinCbs) cb(); },
    onPinsChange: (cb) => { pinCbs.add(cb); return () => pinCbs.delete(cb); },
    onModeChange: (cb) => { modeCbs.add(cb); return () => modeCbs.delete(cb); },
  };
}

afterEach(() => { document.body.innerHTML = ""; });

describe("attachPoseControls", () => {
  it("is a no-op without a #pose button", () => {
    const c = attachPoseControls({ domElement: document.createElement("canvas") }, fakeMode(), {});
    expect(() => c.detach()).not.toThrow();
  });

  it("toggles the mode and aria-pressed; Release pins shows only while on with a pin", () => {
    document.body.innerHTML = `<div id="viewbar"><button id="pose" title="Pose" aria-label="Pose"></button></div>`;
    const button = document.getElementById("pose");
    const canvas = document.createElement("canvas");
    const mode = fakeMode();
    const c = attachPoseControls({ domElement: canvas }, mode, { pose: button });
    const actions = document.querySelector(".pf-pose-actions");
    const release = document.querySelector(".pf-pose-release");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.querySelector("svg")).not.toBeNull();
    expect(actions.hidden).toBe(true);

    button.click();
    expect(mode.isEnabled()).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.classList.contains("on")).toBe(true);
    expect(actions.hidden).toBe(true); // on, but no pins

    mode.setPinCount(2);
    expect(actions.hidden).toBe(false);
    expect(release.hidden).toBe(false);
    release.click();
    expect(mode.pinCount()).toBe(0);
    expect(actions.hidden).toBe(true);

    mode.setPinCount(1);
    expect(actions.hidden).toBe(false);
    mode.setEnabled(false); // pins persist across toggles but the action hides
    expect(actions.hidden).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("false");

    c.detach();
    expect(document.querySelector(".pf-pose-actions")).toBeNull();
    expect(button.getAttribute("title")).toBe("Pose");
    expect(button.getAttribute("aria-label")).toBe("Pose");
    expect(button.hasAttribute("aria-pressed")).toBe(false);
    expect(button.innerHTML).toBe("");
  });

  it("Escape on the stage leaves the mode", () => {
    document.body.innerHTML = `<button id="pose"></button>`;
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const mode = fakeMode();
    attachPoseControls({ domElement: canvas }, mode, { pose: document.getElementById("pose") });
    mode.setEnabled(true);
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(mode.isEnabled()).toBe(false);
  });
});
