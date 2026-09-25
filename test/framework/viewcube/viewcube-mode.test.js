// @vitest-environment happy-dom
// The orchestrator: the only viewcube file touching both the viewer and the
// DOM. The two behaviours worth defending are the idle-cost guarantee (an
// unchanged camera must draw NOTHING) and the drag/click split.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createViewcubeMode } from "../../../src/framework/viewcube/viewcube-mode.js";
import { CUBE_SIZE, CUBE_SIZE_NARROW, CUBE_RENDER } from "../../../src/framework/viewcube/cube-canvas.js";
import { CUBE_DOWN_BIAS_PX, projectCube } from "../../../src/framework/viewcube/cube-geom.js";
import { RAIL_NARROW_BREAKPOINT } from "../../../src/framework/rail-state.js";

function stubViewer() {
  const frame = new Set();
  const theme = new Set();
  const quat = { x: 0, y: 0, z: 0, w: 1 };
  return {
    camera: { quaternion: quat, isOrthographicCamera: false, zoom: 1 },
    quat,
    tick: (dt = 0.016) => frame.forEach((cb) => cb(dt)),
    setTheme: (m) => theme.forEach((cb) => cb(m)),
    onFrame: (cb) => { frame.add(cb); return () => frame.delete(cb); },
    onThemeChange: (cb) => { theme.add(cb); return () => theme.delete(cb); },
    getTheme: () => "dark",
    tweenCameraTo: vi.fn(),
    orbitBy: vi.fn(),
    frameCount: () => frame.size,
    themeCount: () => theme.size,
  };
}

let host, viewer, mode, draws, surface;
// The fake MUST append its element to the host: the mode attaches its pointer
// listeners to canvas.element, and the tests dispatch there. Dispatching on the
// wrapper instead would never reach them — events bubble child-to-parent.
function fakeCanvasFactory() {
  draws = [];
  return (wrap) => {
    surface = document.createElement("canvas");
    surface.className = "pf-viewcube-canvas";
    wrap.appendChild(surface);
    // happy-dom returns a zero rect and has no pointer capture; the mode reads
    // one and calls the other.
    surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 90, height: 90 });
    surface.setPointerCapture = () => {};
    surface.releasePointerCapture = () => {};
    return {
      element: surface,
      draw: (projected, opts) => draws.push({ projected, ...opts }),
      setTheme: vi.fn(),
      size: 90,
      dispose: vi.fn(),
    };
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  viewer = stubViewer();
  mode = createViewcubeMode(viewer, { host, createCanvas: fakeCanvasFactory() });
});
afterEach(() => mode?.detach());

const pointer = (type, x, y) => {
  const e = new Event(type, { bubbles: true });
  Object.assign(e, { clientX: x, clientY: y, pointerId: 1, isPrimary: true });
  surface.dispatchEvent(e);
};

describe("idle cost", () => {
  it("draws once on attach so the widget is never blank", () => {
    expect(draws.length).toBe(1);
  });

  it("draws nothing on a frame where the camera did not move", () => {
    draws.length = 0;
    viewer.tick();
    viewer.tick();
    viewer.tick();
    expect(draws.length).toBe(0);
  });

  it("draws again once the camera quaternion changes", () => {
    draws.length = 0;
    viewer.quat.y = 0.3;
    viewer.tick();
    expect(draws.length).toBe(1);
  });

  it("draws again when only the ortho zoom changes", () => {
    viewer.camera.isOrthographicCamera = true;
    draws.length = 0;
    viewer.camera.zoom = 2;
    viewer.tick();
    expect(draws.length).toBe(1);
  });
});

describe("click versus drag", () => {
  it("tweens on a release inside the threshold, asking for a refit", () => {
    pointer("pointerdown", 45, 45);
    pointer("pointermove", 47, 46);
    pointer("pointerup", 47, 46);
    expect(viewer.tweenCameraTo).toHaveBeenCalledTimes(1);
    // refit: a click on the cube is the reframe control now that the framework's
    // pages ship no reframe button, and under orthographic a plain tween does
    // not refit (see viewer.js's tweenCameraTo).
    expect(viewer.tweenCameraTo.mock.calls[0][1]).toMatchObject({ refit: true, autoProjection: true });
    expect(viewer.orbitBy).not.toHaveBeenCalled();
  });

  it("orbits and cancels the click past the threshold", () => {
    pointer("pointerdown", 45, 45);
    pointer("pointermove", 60, 45);
    pointer("pointerup", 60, 45);
    expect(viewer.orbitBy).toHaveBeenCalled();
    expect(viewer.tweenCameraTo).not.toHaveBeenCalled();
  });

  it("does not tween when the release lands outside the cube", () => {
    pointer("pointerdown", 1, 1);
    pointer("pointerup", 1, 1);
    expect(viewer.tweenCameraTo).not.toHaveBeenCalled();
  });
});

describe("hover", () => {
  it("passes a hovered region id to the renderer", () => {
    draws.length = 0;
    pointer("pointermove", 45, 45);
    expect(draws.at(-1).hover).toBe("front");
  });

  it("clears the hover on leave", () => {
    pointer("pointermove", 45, 45);
    draws.length = 0;
    pointer("pointerleave", 45, 45);
    expect(draws.at(-1).hover).toBeNull();
  });
});

describe("hiding", () => {
  it("hides and restores the element", () => {
    mode.setHidden(true);
    expect(mode.element.hidden).toBe(true);
    expect(mode.isHidden()).toBe(true);
    mode.setHidden(false);
    expect(mode.element.hidden).toBe(false);
  });

  it("draws nothing at all while hidden, even as the camera moves", () => {
    mode.setHidden(true);
    draws.length = 0;
    viewer.quat.y = 0.5;
    viewer.tick();
    expect(draws.length).toBe(0);
  });
});

describe("detach", () => {
  it("unsubscribes from the viewer and removes its DOM", () => {
    mode.detach();
    expect(viewer.frameCount()).toBe(0);
    expect(viewer.themeCount()).toBe(0);
    expect(host.querySelector(".pf-viewcube")).toBeNull();
  });

  it("is idempotent", () => {
    mode.detach();
    expect(() => mode.detach()).not.toThrow();
  });
});

// A fake matchMedia: one query, mutable `matches`, and a `.fire(next)` the
// test uses in place of the browser actually crossing the breakpoint.
function fakeMatchMedia(initialMatches) {
  let matches = initialMatches;
  const listeners = new Set();
  const matchMedia = () => ({
    get matches() { return matches; },
    addEventListener: (_type, cb) => listeners.add(cb),
    removeEventListener: (_type, cb) => listeners.delete(cb),
  });
  matchMedia.fire = (next) => { matches = next; listeners.forEach((cb) => cb()); };
  matchMedia.listenerCount = () => listeners.size;
  return matchMedia;
}

function minimalCanvas(wrap, opts = {}) {
  const el = document.createElement("canvas");
  el.className = "pf-viewcube-canvas";
  wrap.appendChild(el);
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 90, height: 90 });
  el.setPointerCapture = () => {};
  el.releasePointerCapture = () => {};
  let size = opts.size;
  return {
    element: el,
    draw: vi.fn(),
    setTheme: vi.fn(),
    setSize: vi.fn((px) => { size = px; }),
    get size() { return size; },
    dispose: vi.fn(),
  };
}

describe("narrow breakpoint (matchMedia, not a ResizeObserver)", () => {
  let narrowHost, narrowMode;
  beforeEach(() => {
    narrowHost = document.createElement("div");
    document.body.append(narrowHost);
  });
  afterEach(() => narrowMode?.detach());

  it("creates the canvas at the full CUBE_SIZE when the breakpoint does not match", () => {
    let seenSize;
    const createCanvas = (wrap, opts) => { seenSize = opts.size; return minimalCanvas(wrap, opts); };
    narrowMode = createViewcubeMode(viewer, { host: narrowHost, createCanvas, matchMedia: fakeMatchMedia(false) });
    expect(seenSize).toBe(CUBE_SIZE);
  });

  it("creates the canvas at CUBE_SIZE_NARROW when the breakpoint already matches", () => {
    let seenSize;
    const createCanvas = (wrap, opts) => { seenSize = opts.size; return minimalCanvas(wrap, opts); };
    narrowMode = createViewcubeMode(viewer, { host: narrowHost, createCanvas, matchMedia: fakeMatchMedia(true) });
    expect(seenSize).toBe(CUBE_SIZE_NARROW);
  });

  // The two tests above read the constants back, so they hold for ANY pair of
  // numbers — they pin the WIRING, not the sizes. This one states the tuned
  // values outright: the narrow cube is three quarters of the full one
  // (135 → 101), the 2026-08-19 decision to keep the cube legible on a phone
  // rather than shrink it to the old 90px widget.
  it("renders the narrow cube at 101 CSS px — three quarters of the full 135", () => {
    expect(CUBE_SIZE).toBe(135);
    expect(CUBE_SIZE_NARROW).toBe(101);
    let seenSize;
    const createCanvas = (wrap, opts) => { seenSize = opts.size; return minimalCanvas(wrap, opts); };
    narrowMode = createViewcubeMode(viewer, { host: narrowHost, createCanvas, matchMedia: fakeMatchMedia(true) });
    expect(seenSize).toBe(101);
  });

  it("queries the exact RAIL_NARROW_BREAKPOINT, imported rather than hardcoded", () => {
    let seenQuery;
    const matchMedia = (query) => { seenQuery = query; return fakeMatchMedia(false)(query); };
    narrowMode = createViewcubeMode(viewer, { host: narrowHost, createCanvas: minimalCanvas, matchMedia });
    expect(seenQuery).toBe(`(max-width: ${RAIL_NARROW_BREAKPOINT}px)`);
  });

  it("resizes and redraws when the media query's match state changes", () => {
    let canvas;
    const createCanvas = (wrap, opts) => { canvas = minimalCanvas(wrap, opts); return canvas; };
    const mm = fakeMatchMedia(false);
    narrowMode = createViewcubeMode(viewer, { host: narrowHost, createCanvas, matchMedia: mm });
    canvas.draw.mockClear();
    mm.fire(true);
    expect(canvas.setSize).toHaveBeenCalledWith(CUBE_SIZE_NARROW);
    expect(canvas.draw).toHaveBeenCalled();
  });

  it("unsubscribes from the media query on detach", () => {
    const mm = fakeMatchMedia(false);
    narrowMode = createViewcubeMode(viewer, { host: narrowHost, createCanvas: minimalCanvas, matchMedia: mm });
    expect(mm.listenerCount()).toBe(1);
    narrowMode.detach();
    expect(mm.listenerCount()).toBe(0);
  });
});

// The acceptance criterion for the 2026-08-20 lowering (chrome.css took the
// stack's 8px viewbar clearance; this took the canvas's unused bottom padding).
// Both halves of the pixel budget the drawing has to live inside are composed
// HERE — outerPad and downBias are mode's to pass — so this is where the
// "nothing paints outside the box" guarantee belongs, not in either leaf.
//
// The three axis arrows radiate from ONE fixed model corner, so whichever way
// that corner has rotated an arrowhead and its glyph can approach any edge of
// the canvas. Biasing the drawing downward eats the bottom margin, so an axis
// pointing straight down the screen is the case that clips first — hence a
// sweep, not a single pose.
describe("painted extent stays inside the canvas box at every orientation", () => {
  // How far past its anchor the axis glyph actually paints. Measured in
  // Chromium for `600 10px ui-sans-serif` with textAlign/textBaseline centre:
  // ascent 3.85, descent 3.20, side bearings <= 3.20 for X/Y/Z. Rounded UP to
  // 4 so a platform whose system font is a little heavier still has room —
  // this is the number that decides how much downward bias is affordable.
  const LABEL_REACH_PX = 4;

  const sweepCanvas = (size) => {
    const seen = [];
    const factory = (wrap, opts) => {
      const handle = minimalCanvas(wrap, { ...opts, size });
      const inner = handle.draw;
      handle.draw = (projected, o) => { seen.push(projected); return inner(projected, o); };
      // The mode asks the canvas for its size; the fake must report the one
      // under test rather than whatever the factory was handed.
      Object.defineProperty(handle, "size", { get: () => size });
      return handle;
    };
    return { seen, factory };
  };

  // A quaternion grid over SO(3), built from euler angles: the arrows have to
  // stay inside the box for ANY orientation the projection can be handed, not
  // just the poses today's orbit happens to reach.
  function* orientations(n) {
    const mul = (a, b) => [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        for (let k = 0; k < n / 2; k++) {
          const [a, b, c] = [(i / n) * 2 * Math.PI, (j / n) * 2 * Math.PI, (k / (n / 2)) * 2 * Math.PI];
          const qz = [0, 0, Math.sin(a / 2), Math.cos(a / 2)];
          const qy = [0, Math.sin(b / 2), 0, Math.cos(b / 2)];
          const qx = [Math.sin(c / 2), 0, 0, Math.cos(c / 2)];
          yield mul(mul(qz, qy), qx);
        }
      }
    }
  }

  // Everything the renderer paints for one arrow, in the renderer's own terms
  // (cube-canvas.js's arrowDirection / arrowFurniture / drawArrow), so the
  // sweep covers the SCREEN-space furniture and not just the projected shaft.
  function arrowPoints(arrow) {
    const pts = [arrow.from, arrow.tip];
    const dx = arrow.tip[0] - arrow.from[0], dy = arrow.tip[1] - arrow.from[1];
    const len = Math.hypot(dx, dy);
    if (len < 0.5) return pts; // degenerate: no head or label is drawn at all
    const d = [dx / len, dy / len];
    const headTip = [arrow.tip[0] + d[0] * CUBE_RENDER.headLengthPx, arrow.tip[1] + d[1] * CUBE_RENDER.headLengthPx];
    const nx = -d[1] * CUBE_RENDER.headHalfWidthPx, ny = d[0] * CUBE_RENDER.headHalfWidthPx;
    const anchor = [headTip[0] + d[0] * CUBE_RENDER.labelGapPx, headTip[1] + d[1] * CUBE_RENDER.labelGapPx];
    return [
      ...pts,
      headTip,
      [arrow.tip[0] + nx, arrow.tip[1] + ny],
      [arrow.tip[0] - nx, arrow.tip[1] - ny],
      // the glyph's own painted box around its anchor
      [anchor[0] - LABEL_REACH_PX, anchor[1] - LABEL_REACH_PX],
      [anchor[0] + LABEL_REACH_PX, anchor[1] + LABEL_REACH_PX],
    ];
  }

  for (const size of [CUBE_SIZE, CUBE_SIZE_NARROW]) {
    it(`never paints outside a ${size}px canvas, arrowheads and axis glyphs included`, () => {
      const { seen, factory } = sweepCanvas(size);
      const sweepViewer = stubViewer();
      const sweepHost = document.createElement("div");
      document.body.append(sweepHost);
      const sweepMode = createViewcubeMode(sweepViewer, { host: sweepHost, createCanvas: factory });
      try {
        let checked = 0;
        for (const q of orientations(24)) {
          Object.assign(sweepViewer.quat, { x: q[0], y: q[1], z: q[2], w: q[3] });
          sweepViewer.tick();
          // Deliberately NOT cleared per iteration: the dirty check skips a
          // redraw when an orientation repeats the previous one (the grid opens
          // on the identity the mode already drew at attach), and the standing
          // projection is the right one to check in that case.
          const projected = seen.at(-1);
          expect(projected).toBeTruthy();
          const points = [
            ...[...projected.back, ...projected.front].flatMap((c) => c.points),
            ...[...projected.backEdges, ...projected.frontEdges].flatMap((e) => e.points),
            ...projected.arrows.flatMap(arrowPoints),
          ];
          for (const [x, y] of points) {
            if (x < 0 || x > size || y < 0 || y > size) {
              throw new Error(`painted [${x.toFixed(2)}, ${y.toFixed(2)}] outside 0..${size} at quaternion [${q.map((v) => v.toFixed(4))}]`);
            }
          }
          checked++;
        }
        expect(checked).toBeGreaterThan(1000);
      } finally {
        sweepMode.detach();
        sweepHost.remove();
      }
    });
  }

  it("keeps the downward bias inside the pixel budget the label pad reserves", () => {
    // The sweep above is empirical; this is the same guarantee in closed form,
    // so it holds at the exact worst orientation a finite grid can only get
    // near. Every cube vertex sits at model distance sqrt(3), and the scale is
    // (size/2 - outerPad)/sqrt(3) — so the drawing's own reach from the box
    // centre is exactly (size/2 - outerPad), and the renderer then adds
    // headLengthPx + labelGapPx + the glyph past that. What is left over,
    // labelPx - LABEL_REACH_PX, is the whole slack the bias can spend.
    const budget = CUBE_RENDER.labelPx - LABEL_REACH_PX;
    expect(CUBE_DOWN_BIAS_PX).toBeLessThanOrEqual(budget);
    // ...and outerPad really is that sum, or the arithmetic above is fiction.
    expect(CUBE_RENDER.headLengthPx + CUBE_RENDER.labelGapPx + CUBE_RENDER.labelPx).toBe(23);
  });

  it("hands the projection BOTH knobs — outerPad and the downward bias", () => {
    const size = CUBE_SIZE;
    const { seen, factory } = sweepCanvas(size);
    const wiringViewer = stubViewer();
    const wiringHost = document.createElement("div");
    document.body.append(wiringHost);
    const wiringMode = createViewcubeMode(wiringViewer, { host: wiringHost, createCanvas: factory });
    try {
      Object.assign(wiringViewer.quat, { x: 0.2, y: 0.3, z: 0.1, w: 0.927 });
      seen.length = 0;
      wiringViewer.tick();
      const outerPad = CUBE_RENDER.headLengthPx + CUBE_RENDER.labelGapPx + CUBE_RENDER.labelPx;
      expect(seen.at(-1)).toEqual(
        projectCube([0.2, 0.3, 0.1, 0.927], { size, outerPad, downBias: CUBE_DOWN_BIAS_PX }),
      );
    } finally {
      wiringMode.detach();
      wiringHost.remove();
    }
  });
});
