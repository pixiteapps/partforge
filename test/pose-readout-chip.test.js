// @vitest-environment happy-dom
// The readout chip (pose/readout-chip.js): after a generic handle's drag, a DOM chip by the
// handle shows the readout values for 4 s; a click makes it editable (one number input per
// readout param), Enter or blur writes as a slider would, Escape cancels. A drag a pin held
// shows the pin hint for 3 s instead.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { attachReadoutChip, CHIP_MS, HINT_MS, PIN_HINT } from "../src/framework/pose/readout-chip.js";

const part = {
  parameters: [{ id: "b", title: "Box", controls: [
    { key: "width", min: 10, max: 400, step: 1 },
    { key: "depth", min: 10, max: 200, step: 0.5 },
    { key: "driveAngle", min: 0, max: 360, step: 1, wrap: true },
  ] }],
  defaults: { width: 80, depth: 40, driveAngle: 0 },
  handles: {
    corner: { point: () => [0, 0, 0], params: ["width", "depth"], drag: "plane", normal: [0, 0, 1], label: "Size" },
    gear: { point: () => [0, 0, 0], params: ["driveAngle"], drag: "rotary", axis: { origin: [0, 0, 0], direction: [0, 0, 1] } },
    arm: { on: "arm", drag: "goal", params: { position: ["x", "y", "z"] } },
  },
};

function fakeMode() {
  let live = true;
  const modeCbs = new Set(), endCbs = new Set();
  return {
    isLive: () => live,
    setLive: (v) => { live = !!v; for (const cb of modeCbs) cb(); },
    handlePoints: () => [{ handleId: "corner", at: "point", x: 100, y: 120 }, { handleId: "gear", at: "point", x: 200, y: 50 }],
    onModeChange: (cb) => { modeCbs.add(cb); return () => modeCbs.delete(cb); },
    onDragEnd: (cb) => { endCbs.add(cb); return () => endCbs.delete(cb); },
    end: (e) => { for (const cb of endCbs) cb({ generic: true, changed: [], pinHeld: false, ...e }); },
  };
}

function setup() {
  const stage = document.createElement("div");
  const canvas = document.createElement("canvas");
  stage.append(canvas);
  document.body.append(stage);
  const frames = [];
  const viewer = { domElement: canvas, onFrame: (cb) => { frames.push(cb); return () => frames.splice(frames.indexOf(cb), 1); } };
  const mode = fakeMode();
  const params = { ...part.defaults, driveAngle: 720 };
  const applied = [];
  const chip = attachReadoutChip(viewer, mode, { stage }, {
    part, getParams: () => params, apply: (v) => { applied.push(v); Object.assign(params, v); },
  });
  const el = () => stage.querySelector(".pf-pose-chip");
  const tick = () => { for (const f of [...frames]) f(); };
  return { stage, canvas, viewer, mode, params, applied, chip, el, tick };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });

describe("attachReadoutChip", () => {
  it("is a no-op without a stage", () => {
    const r = attachReadoutChip({ domElement: document.createElement("canvas") }, fakeMode(), {}, { part, getParams: () => ({}), apply() {} });
    expect(() => r.detach()).not.toThrow();
  });

  it("after a drag that wrote, shows the readout by the handle for 4 s", () => {
    const t = setup();
    expect(t.el().hidden).toBe(true);
    t.params.width = 184; t.params.depth = 132;
    t.mode.end({ handleId: "corner", changed: ["width", "depth"] });
    expect(t.el().hidden).toBe(false);
    expect(t.el().textContent).toBe("width 184 · depth 132.0");
    expect(t.el().style.left).toBe("112px"); // 12 px right of the handle point
    expect(t.el().style.top).toBe("108px");  // 12 px up (the chip hangs above, by CSS)
    vi.advanceTimersByTime(CHIP_MS - 1);
    expect(t.el().hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(t.el().hidden).toBe(true);
  });

  it("follows the handle while it shows (the camera can move)", () => {
    const t = setup();
    t.mode.end({ handleId: "corner", changed: ["width"] });
    t.mode.handlePoints = () => [{ handleId: "corner", at: "point", x: 10, y: 300 }];
    t.tick();
    expect(t.el().style.left).toBe("22px");
    t.mode.handlePoints = () => []; // the handle left the view
    t.tick();
    expect(t.el().hidden).toBe(true);
  });

  it("ignores a limb handle's drag, a drag that changed nothing, and stays out of the way of a new press", () => {
    const t = setup();
    t.mode.end({ handleId: "arm", generic: false, changed: ["x"] });
    expect(t.el().hidden).toBe(true);
    t.mode.end({ handleId: "corner", changed: [] });
    expect(t.el().hidden).toBe(true);
    t.mode.end({ handleId: "corner", changed: ["width"] });
    t.canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(t.el().hidden).toBe(true);
  });

  it("a click turns it into one number input per readout param; Enter writes them as a slider would, once", () => {
    const t = setup();
    t.mode.end({ handleId: "corner", changed: ["width", "depth"] });
    t.el().querySelector("button").click();
    const inputs = [...t.el().querySelectorAll("input")];
    expect(inputs.map((i) => i.name)).toEqual(["width", "depth"]);
    expect(inputs.map((i) => i.value)).toEqual(["80", "40"]);
    expect(document.activeElement).toBe(inputs[0]);
    vi.advanceTimersByTime(CHIP_MS * 3);
    expect(t.el().hidden).toBe(false); // editing holds it open
    inputs[0].value = "85.4";
    inputs[1].value = "9000";
    inputs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(t.applied).toEqual([{ width: 85, depth: 200 }]); // snapped, clamped
    expect(t.el().hidden).toBe(true);
    inputs[1].dispatchEvent(new FocusEvent("focusout", { bubbles: true })); // the blur that follows: no second write
    expect(t.applied).toHaveLength(1);
  });

  it("the clicked button's own blur (a browser fires one as it is replaced) is not the edit's blur", () => {
    const t = setup();
    t.mode.end({ handleId: "corner", changed: ["width"] });
    const button = t.el().querySelector("button");
    button.focus();
    // Chromium fires focusout on a focused element removed from the DOM: stand in for it
    const chipEl = t.el();
    const replace = chipEl.replaceChildren.bind(chipEl);
    chipEl.replaceChildren = (...nodes) => {
      if (chipEl.contains(document.activeElement)) chipEl.dispatchEvent(new FocusEvent("focusout", { relatedTarget: null }));
      replace(...nodes);
    };
    button.click();
    expect(t.el().hidden).toBe(false);
    expect(t.el().querySelectorAll("input")).toHaveLength(2);
    expect(t.applied).toEqual([]);
  });

  it("blur (focus leaving the chip) writes; moving between its inputs does not", () => {
    const t = setup();
    t.mode.end({ handleId: "corner", changed: ["width"] });
    t.el().querySelector("button").click();
    const [w, d] = t.el().querySelectorAll("input");
    w.value = "90";
    w.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: d }));
    expect(t.applied).toEqual([]);
    d.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    expect(t.applied).toEqual([{ width: 90, depth: 40 }]);
  });

  it("Escape cancels: nothing written, the chip goes", () => {
    const t = setup();
    t.mode.end({ handleId: "corner", changed: ["width"] });
    t.el().querySelector("button").click();
    const [w] = t.el().querySelectorAll("input");
    w.value = "300";
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    w.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(t.el().hidden).toBe(true);
    w.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(t.applied).toEqual([]);
  });

  it("a wrapped param is typed in its turn and stored in the same turn", () => {
    const t = setup();
    t.mode.end({ handleId: "gear", changed: ["driveAngle"] });
    t.el().querySelector("button").click();
    const [a] = t.el().querySelectorAll("input");
    expect(a.value).toBe("720");
    a.value = "45";
    a.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(t.applied).toEqual([{ driveAngle: 765 }]);
  });

  it("a drag a pin held shows the pin hint for 3 s, not editable", () => {
    const t = setup();
    t.mode.end({ handleId: "gear", changed: [], pinHeld: true });
    expect(t.el().hidden).toBe(false);
    expect(t.el().textContent).toBe(PIN_HINT);
    expect(PIN_HINT).toBe("Held by a pin — Release pins to move it");
    expect(t.el().querySelector("button")).toBeNull();
    vi.advanceTimersByTime(HINT_MS);
    expect(t.el().hidden).toBe(true);
  });

  it("goes when posing stands down, and detach removes it", () => {
    const t = setup();
    t.mode.end({ handleId: "corner", changed: ["width"] });
    t.mode.setLive(false);
    expect(t.el().hidden).toBe(true);
    t.chip.detach();
    expect(t.el()).toBeNull();
    t.mode.end({ handleId: "corner", changed: ["width"] }); // no listener left
  });
});
