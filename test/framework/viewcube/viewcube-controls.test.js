// @vitest-environment happy-dom
// The chrome: the stack element and the hidden
// per-view buttons that replace the DOM focus a canvas cannot give us.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachViewcubeControls } from "../../../src/framework/viewcube/viewcube-controls.js";

function stubViewer() {
  const frame = new Set(), theme = new Set(), projection = new Set();
  let mode = "perspective";
  return {
    camera: { quaternion: { x: 0, y: 0, z: 0, w: 1 }, isOrthographicCamera: false, zoom: 1 },
    onFrame: (cb) => { frame.add(cb); return () => frame.delete(cb); },
    onThemeChange: (cb) => { theme.add(cb); return () => theme.delete(cb); },
    onProjectionChange: (cb) => { projection.add(cb); return () => projection.delete(cb); },
    getTheme: () => "dark",
    getProjection: () => mode,
    setProjection: vi.fn((next) => {
      mode = next;
      projection.forEach((cb) => cb(mode));
      return mode;
    }),
    tweenCameraTo: vi.fn(),
    orbitBy: vi.fn(),
    counts: () => ({ frame: frame.size, theme: theme.size, projection: projection.size }),
  };
}

let stage, viewer, handle;
beforeEach(() => {
  document.body.innerHTML = "";
  stage = document.createElement("div");
  stage.className = "pf-stage";
  const viewbar = document.createElement("div");
  viewbar.id = "viewbar";
  stage.append(viewbar);
  document.body.append(stage);
  viewer = stubViewer();
  handle = attachViewcubeControls(viewer, { stage }, {});
});
afterEach(() => handle?.detach());

describe("structure", () => {
  it("builds the stack inside the stage, not on document.body", () => {
    const stack = stage.querySelector(".pf-viewcube-stack");
    expect(stack).not.toBeNull();
    expect(stack.parentElement).toBe(stage);
  });

  it("carries no projection button of its own (it moved into the view style popover)", () => {
    // Through 2026-09-23 the stack generated #projection over the cube's
    // corner; view-style-controls.js now puts its own button in that spot.
    expect(stage.querySelector("#projection")).toBeNull();
    expect(stage.querySelector(".pf-viewcube-toggle")).toBeNull();
    expect(stage.querySelector(".pf-viewcube-pill")).toBeNull();
  });
});

describe("keyboard access", () => {
  it("offers one hidden button per canonical view", () => {
    const buttons = [...stage.querySelectorAll(".pf-viewcube-key button")];
    expect(buttons.map((b) => b.dataset.view).sort())
      .toEqual(["back", "bottom", "front", "left", "right", "top"]);
    for (const b of buttons) expect(b.getAttribute("aria-label")).toBeTruthy();
  });

  it("tweens to the named view when one is activated, refitting like a click does", () => {
    // These buttons are the keyboard route to clicking that face on the canvas,
    // so they carry the same `refit` — without it, reaching a view by keyboard
    // under orthographic would change the angle and leave the dolly alone.
    stage.querySelector('.pf-viewcube-key button[data-view="top"]').click();
    expect(viewer.tweenCameraTo).toHaveBeenCalledWith("top", { duration: 0.6, refit: true });
  });
});

describe("hiding", () => {
  it("hides the whole stack", () => {
    handle.setHidden(true);
    expect(stage.querySelector(".pf-viewcube-stack").hidden).toBe(true);
    handle.setHidden(false);
    expect(stage.querySelector(".pf-viewcube-stack").hidden).toBe(false);
  });
});

// animation-controls.js decides whether the transport bar is crowded from the
// stack's footprint, and it must get the same answer whether or not the stack is
// on screen (otherwise hiding the cube un-crowds the bar and the two oscillate).
// A display:none element measures all zeros, so the size is published onto the
// element as data-pf-w / data-pf-h and the last REAL measurement stands.
describe("publishing the stack's nominal size", () => {
  const stubRect = (el, width, height) => {
    el.getBoundingClientRect = () => ({ left: 0, top: 0, right: width, bottom: height, width, height });
  };

  it("publishes integer px at setup, republishes on resize, and keeps the last real size across a hide", () => {
    const OriginalRO = globalThis.ResizeObserver;
    let roCallback;
    const observed = new Set();
    let disconnected = false;
    globalThis.ResizeObserver = class {
      constructor(fn) { roCallback = fn; }
      observe(el) { observed.add(el); }
      disconnect() { disconnected = true; }
    };
    let local;
    try {
      const host = document.createElement("div");
      document.body.append(host);
      // The setup publish reads a rect off an element this test never gets to
      // touch first (attachViewcubeControls creates the stack itself), and
      // happy-dom has no layout to read. Stub every div's rect for the duration
      // of the attach; the fractional size also pins the rounding.
      const realRect = HTMLDivElement.prototype.getBoundingClientRect;
      HTMLDivElement.prototype.getBoundingClientRect =
        () => ({ left: 0, top: 0, right: 135.4, bottom: 135.6, width: 135.4, height: 135.6 });
      try {
        local = attachViewcubeControls(stubViewer(), { stage: host }, {});
      } finally {
        HTMLDivElement.prototype.getBoundingClientRect = realRect;
      }
      const stack = host.querySelector(".pf-viewcube-stack");
      expect(observed.has(stack)).toBe(true);
      expect(stack.dataset.pfW).toBe("135");
      expect(stack.dataset.pfH).toBe("136");
      expect(stack.getAttribute("data-pf-w")).toBe("135"); // the data-pf-* convention

      // The narrow breakpoint is the only thing that changes these.
      stubRect(stack, 101, 101);
      roCallback();
      expect(stack.dataset.pfW).toBe("101");
      expect(stack.dataset.pfH).toBe("101");

      // Hidden: the element measures all zeros, and a zero is not a size. The
      // last real values stay put — they are what the crowding decision reads.
      local.setHidden(true);
      stubRect(stack, 0, 0);
      roCallback();
      expect(stack.dataset.pfW).toBe("101");
      expect(stack.dataset.pfH).toBe("101");

      local.detach();
      expect(disconnected).toBe(true);
      local = null;
    } finally {
      globalThis.ResizeObserver = OriginalRO;
      local?.detach();
    }
  });

  it("survives an environment with no ResizeObserver at all", () => {
    const OriginalRO = globalThis.ResizeObserver;
    delete globalThis.ResizeObserver;
    try {
      const host = document.createElement("div");
      document.body.append(host);
      const local = attachViewcubeControls(stubViewer(), { stage: host }, {});
      expect(() => local.detach()).not.toThrow();
    } finally {
      globalThis.ResizeObserver = OriginalRO;
    }
  });
});

describe("detach", () => {
  it("unsubscribes everything and removes the stack", () => {
    handle.detach();
    expect(viewer.counts()).toEqual({ frame: 0, theme: 0, projection: 0 });
    expect(stage.querySelector(".pf-viewcube-stack")).toBeNull();
  });

  it("is idempotent", () => {
    handle.detach();
    expect(() => handle.detach()).not.toThrow();
  });
});
