// @vitest-environment happy-dom
// Overlay canvas renderer: DOM lifecycle, typed-element halo+core draw passes,
// overlay adornments, PNG export (elements only, no overlay).
import { afterEach, expect, test } from "vitest";
import { createInkCanvas } from "../../../src/framework/annotate/ink-canvas.js";

afterEach(() => { document.body.innerHTML = ""; });

// Records both method calls (`{ op, args }`) and property assignments
// (`{ prop, value }`) in one ordered list, so a test can assert on draw
// order across styling and drawing calls alike (e.g. "strokeStyle was set
// to the halo color before it was set to the core color").
function fakeCtx() {
  const calls = [];
  const ctx = {
    calls,
    clearRect(...args) { calls.push({ op: "clearRect", args }); },
    beginPath() { calls.push({ op: "beginPath" }); },
    closePath() { calls.push({ op: "closePath" }); },
    moveTo(...args) { calls.push({ op: "moveTo", args }); },
    lineTo(...args) { calls.push({ op: "lineTo", args }); },
    arc(...args) { calls.push({ op: "arc", args }); },
    fill() { calls.push({ op: "fill" }); },
    stroke() { calls.push({ op: "stroke", strokeStyle: ctx.strokeStyle, lineWidth: ctx.lineWidth }); },
    fillRect(...args) { calls.push({ op: "fillRect", args }); },
    strokeRect(...args) { calls.push({ op: "strokeRect", args }); },
    fillText(...args) { calls.push({ op: "fillText", args }); },
    measureText(text) { calls.push({ op: "measureText", args: [text] }); return { width: text.length * 6 }; },
    setLineDash(segs) { calls.push({ op: "setLineDash", args: [segs] }); },
    save() { calls.push({ op: "save" }); },
    restore() { calls.push({ op: "restore" }); },
  };
  for (const prop of ["strokeStyle", "fillStyle", "lineWidth", "lineCap", "lineJoin", "globalAlpha", "font"]) {
    let value;
    Object.defineProperty(ctx, prop, {
      get: () => value,
      set(v) { value = v; calls.push({ prop, value: v }); },
    });
  }
  return ctx;
}

function fixture() {
  const stage = document.createElement("div");
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100 });
  document.body.appendChild(stage);
  const ctx = fakeCtx();
  const canvas = createInkCanvas(stage, { getContext2d: () => ctx });
  return {
    stage, ctx, canvas, calls: ctx.calls,
    countOps: (op) => ctx.calls.filter((c) => c.op === op).length,
    // Marks the current call count; the returned function replays only the
    // calls recorded since — used to inspect one operation's output (e.g.
    // toDataUrl) in isolation from setup noise.
    callsSince: () => {
      const start = ctx.calls.length;
      return () => ctx.calls.slice(start);
    },
  };
}

test("mounts hidden inside the stage with the pf- class", () => {
  const { stage, canvas } = fixture();
  expect(canvas.element.parentElement).toBe(stage);
  expect(canvas.element.className).toBe("pf-ink-canvas");
  expect(canvas.element.hidden).toBe(true);
});

test("show() sizes the bitmap to the stage rect × dpr and unhides", () => {
  const { canvas } = fixture();
  canvas.show();
  expect(canvas.element.hidden).toBe(false);
  const { width, height, dpr } = canvas.size();
  expect(width).toBe(Math.round(200 * dpr));
  expect(height).toBe(Math.round(100 * dpr));
});

test("setScene draws halo before core, per element color", () => {
  const { canvas, calls } = fixture();
  canvas.show();
  calls.length = 0;
  canvas.setScene({
    elements: [
      { type: "line", color: "blue", width: 0.004, params: { x1: 0, y1: 0, x2: 0.5, y2: 0.5 }, gaps: [] },
    ],
    overlay: {},
  });
  const strokeStyles = calls.filter((c) => c.prop === "strokeStyle").map((c) => c.value);
  expect(strokeStyles[0]).toBe("rgba(255, 255, 255, 0.85)"); // halo pass first
  expect(strokeStyles).toContain("#1570ef"); // blue core after
});

test("gapped elements draw one path per visible run", () => {
  const { canvas, calls, countOps } = fixture();
  canvas.show();
  calls.length = 0;
  canvas.setScene({
    elements: [
      { type: "line", color: "red", width: 0.004, params: { x1: 0, y1: 0.5, x2: 1, y2: 0.5 }, gaps: [[0.4, 0.6]] },
    ],
    overlay: {},
  });
  // 2 runs × 2 passes (halo+core) = 4 beginPath+stroke pairs
  expect(countOps("beginPath")).toBe(4);
  expect(countOps("stroke")).toBe(4);
});

test("a single-point run draws as a filled dot, in both halo and core passes", () => {
  const { canvas, calls, countOps } = fixture();
  canvas.show();
  calls.length = 0;
  canvas.setScene({
    elements: [
      { type: "freehand", color: "green", width: 0.01, params: { points: [[0.5, 0.5]] }, gaps: [] },
    ],
    overlay: {},
  });
  expect(countOps("arc")).toBe(2);
  expect(countOps("fill")).toBe(2);
});

test("overlay draws glow, then halos, cores, handles, guide, label — in that order", () => {
  // No pointer-followers here on purpose: the eraser ring and rotate glyph
  // are CSS cursors (app.css), never canvas drawings — see the draw() comment.
  const { canvas, calls } = fixture();
  canvas.show();
  calls.length = 0;
  const el = { type: "line", color: "red", width: 0.01, params: { x1: 0, y1: 0, x2: 1, y2: 1 }, gaps: [] };
  canvas.setScene({
    elements: [el],
    overlay: {
      glowEl: el,
      handlesEl: { type: "line", color: "red", width: 0.01, params: { x1: 0, y1: 0, x2: 1, y2: 0 }, gaps: [] },
      guide: { kind: "cross", cx: 0.5, cy: 0.5 },
      label: { x: 0.2, y: 0.2, text: "r 10" },
    },
  });
  const glowAt = calls.findIndex((c) => c.prop === "globalAlpha" && c.value === 0.35);
  const haloAt = calls.findIndex((c) => c.prop === "strokeStyle" && c.value === "rgba(255, 255, 255, 0.85)");
  const coreAt = calls.findIndex((c) => c.prop === "strokeStyle" && c.value === "#d92d20");
  const handlesAt = calls.findIndex((c) => c.op === "fillRect");
  const guideAt = calls.findIndex((c) => c.op === "setLineDash");
  const labelAt = calls.findIndex((c) => c.op === "fillText");
  const order = [glowAt, haloAt, coreAt, handlesAt, guideAt, labelAt];
  expect(order.every((i) => i >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
});

test("overlay chrome (handles, label, line widths) scales with the bitmap's dpr", () => {
  // These adornments are specified in CSS pixels but drawn straight into the
  // device-pixel bitmap; at dpr 2 every fixed constant must be doubled or the
  // chrome renders at half its intended on-screen size (unlike ink strokes,
  // which already scale for free via el.width being a fraction of the
  // dpr-scaled short edge).
  const original = globalThis.devicePixelRatio;
  globalThis.devicePixelRatio = 2;
  try {
    const { canvas, calls } = fixture();
    canvas.show(); // resize() reads devicePixelRatio here and latches currentDpr = 2
    calls.length = 0;
    canvas.setScene({
      elements: [],
      overlay: {
        handlesEl: { type: "line", color: "red", width: 0.01, params: { x1: 0, y1: 0, x2: 1, y2: 0 }, gaps: [] },
        label: { x: 0.2, y: 0.2, text: "x" },
      },
    });
    // handle square: HS = 7 * dpr = 14
    const fillRectCall = calls.find((c) => c.op === "fillRect");
    expect(fillRectCall.args[2]).toBeCloseTo(14);
    expect(fillRectCall.args[3]).toBeCloseTo(14);
    // handles chrome line width: 1.5 * dpr = 3
    expect(calls.some((c) => c.prop === "lineWidth" && c.value === 3)).toBe(true);
    // label font size: 10 * dpr = 20
    expect(calls.some((c) => c.prop === "font" && c.value === "20px monospace")).toBe(true);
  } finally {
    globalThis.devicePixelRatio = original;
  }
});

test("chrome colors fall back to literal defaults in a bare test environment", () => {
  const { canvas } = fixture();
  canvas.show();
  // getComputedStyle exists in happy-dom but the --pf-* custom properties are
  // unset, so this must not throw and must fall back rather than draw "".
  expect(() => canvas.setScene({
    elements: [],
    overlay: { label: { x: 0.5, y: 0.5, text: "r 10" } },
  })).not.toThrow();
});

test("guide rect maps w/h like point extents (target.height), not the stroke-width short-edge convention", () => {
  // Portrait stage (100x200) makes short-edge (100) and height (200) differ,
  // so a guide box sized against the wrong factor is visibly wrong here even
  // though the two conventions coincide on a landscape stage.
  const stage = document.createElement("div");
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 200 });
  document.body.appendChild(stage);
  const ctx = fakeCtx();
  const canvas = createInkCanvas(stage, { getContext2d: () => ctx });
  canvas.show();
  ctx.calls.length = 0;
  canvas.setScene({
    elements: [],
    overlay: { guide: { kind: "rect", cx: 0.5, cy: 0.5, w: 0.2, h: 0.1 } },
  });
  const [call] = ctx.calls.filter((c) => c.op === "strokeRect");
  call.args.forEach((v, i) => expect(v).toBeCloseTo([80, 90, 40, 20][i]));
});

test("resize observer callback ignores a hidden canvas", () => {
  let observerCallback;
  class FakeResizeObserver {
    constructor(cb) { observerCallback = cb; }
    observe() {}
    disconnect() {}
  }
  const original = global.ResizeObserver;
  global.ResizeObserver = FakeResizeObserver;
  try {
    const { calls, canvas } = fixture();
    expect(canvas.element.hidden).toBe(true);
    observerCallback(); // still hidden: must not re-rasterize
    expect(calls).toHaveLength(0);
    canvas.show();
    calls.length = 0;
    observerCallback(); // visible: resize()/draw() run as before
    expect(calls.some((c) => c.op === "clearRect")).toBe(true);
  } finally {
    global.ResizeObserver = original;
  }
});

test("toDataUrl exports elements only — overlay adornments never reach the PNG", () => {
  const { canvas, callsSince } = fixture();
  canvas.show();
  canvas.setScene({
    elements: [{ type: "line", color: "red", width: 0.004, params: { x1: 0, y1: 0, x2: 1, y2: 1 }, gaps: [] }],
    overlay: { label: { x: 0.1, y: 0.1, text: "r 10" } },
  });
  const mark = callsSince();
  canvas.toDataUrl({ maxEdge: 100 });
  const exported = mark();
  expect(exported.some((c) => c.op === "fillText")).toBe(false); // no label in export
  expect(exported.some((c) => c.prop === "globalAlpha")).toBe(false); // no glow alpha in export
});

test("toDataUrl always re-rasterizes into a scratch canvas, scaled under maxEdge", () => {
  const stage = document.createElement("div");
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 4000, height: 2000 });
  document.body.appendChild(stage);
  const made = [];
  const ctx = fakeCtx();
  const canvas = createInkCanvas(stage, {
    getContext2d: () => ctx,
    createCanvas: () => {
      const c = document.createElement("canvas");
      c.toDataURL = () => `data:image/png;base64,${c.width}x${c.height}`;
      made.push(c);
      return c;
    },
  });
  canvas.show();
  canvas.setScene({
    elements: [{ type: "line", color: "red", width: 0.01, params: { x1: 0, y1: 0, x2: 1, y2: 1 }, gaps: [] }],
    overlay: {},
  });
  const live = canvas.size();
  expect(Math.max(live.width, live.height)).toBeGreaterThan(2048);

  // Above the cap: a scratch canvas scaled to the cap, aspect kept, strokes
  // re-drawn (not resampled).
  made.length = 0;
  ctx.calls.length = 0;
  const bounded = canvas.toDataUrl({ maxEdge: 2048 });
  const scratch = made.at(-1);
  expect(scratch).not.toBe(canvas.element);
  expect(scratch.width).toBe(2048);
  expect(scratch.height).toBe(1024);
  expect(bounded).toBe("data:image/png;base64,2048x1024");
  expect(ctx.calls.filter((c) => c.op === "stroke")).toHaveLength(2);

  // Under the cap: still a scratch canvas (the live canvas carries overlay
  // now), but at full live resolution — nothing is scaled down.
  made.length = 0;
  const direct = canvas.toDataUrl({ maxEdge: 99_999 });
  expect(made).toHaveLength(1);
  expect(made[0].width).toBe(live.width);
  expect(made[0].height).toBe(live.height);
  expect(direct).toBe(`data:image/png;base64,${live.width}x${live.height}`);
});

test("dispose removes the element and is idempotent", () => {
  const { stage, canvas } = fixture();
  canvas.dispose();
  canvas.dispose();
  expect(stage.querySelector(".pf-ink-canvas")).toBe(null);
});
