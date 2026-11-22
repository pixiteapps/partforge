// @vitest-environment happy-dom
// test/compare-view.test.js — the reference compare view's controller (compare-view.js):
// when it asks the worker for the three difference solids, what it does with the
// reply, its on-stage legend, and the Parts-list seam the view style popover reads.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCompareView, SETTLE_MS, JOB_TIMEOUT_MS, COMPARE_HEX } from "../src/framework/compare-view.js";
import { COMPARE_COLORS } from "../src/framework/compare-colors.js";
import { attachPartsList } from "../src/framework/parts-list.js";
import { subPartRows } from "../src/framework/sub-part-list.js";

const part = () => ({
  parts: {
    base: { label: "Base", reference: "ref", views: ["assembly"] },
    ref: { label: "Scan", views: ["assembly"], enabled: (p) => p.showRef !== false },
    other: { label: "Other", views: ["assembly"] },
  },
  defaults: { size: 10, showRef: true },
});

function fakeViewer() {
  const assembly = new Set(), display = new Set();
  let overrides = {};
  let compare = null;
  const hidden = { missing: false, excess: false };
  const v = {
    onAssemblyChange: (cb) => { assembly.add(cb); return () => assembly.delete(cb); },
    onDisplayChange: (cb) => { display.add(cb); return () => display.delete(cb); },
    getDisplayOverrides: () => overrides,
    setCompare: vi.fn(({ name, ref }) => { compare = { name, ref }; }),
    clearCompare: vi.fn(() => { compare = null; }),
    setCompareHidden: vi.fn((kind, h) => { hidden[kind] = h; }),
    setCompareShown: vi.fn((on) => { v.shown = on; }),
    shown: true,
    getCompare: () => (compare ? { ...compare, hidden: { ...hidden } } : null),
    setSubPartDisplay: (name, patch) => {
      overrides = { ...overrides, [name]: { ...overrides[name], ...patch } };
      for (const cb of [...display]) cb({ name });
    },
    emitAssembly: () => { for (const cb of [...assembly]) cb(); },
  };
  return v;
}

const mesh = (mm3) => ({ positions: new Float32Array(9), mm3 });
const PIECES = { common: mesh(100), missing: mesh(5), excess: mesh(3) };

function setup({ params: p, initial, settled } = {}) {
  const viewer = fakeViewer();
  const params = { ...part().defaults, ...p };
  const send = vi.fn();
  const viewbar = document.createElement("div");
  viewbar.id = "viewbar";
  document.body.append(viewbar);
  const thePart = part();
  const cv = createCompareView({
    part: thePart, viewer, view: () => "assembly", params: () => params, send, viewbar, initial, settled,
  });
  const lastJob = () => send.mock.calls.at(-1)?.[0];
  const reply = (extra) => cv.handleMessage({ type: "compare-meshes", jobId: lastJob().jobId, tolerance: 0.05, ms: 12, ...extra });
  const legend = () => viewbar.querySelector(".pf-compare-legend");
  return { viewer, params, send, viewbar, cv, lastJob, reply, legend, part: thePart };
}

beforeEach(() => { document.body.innerHTML = ""; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("compare view: when it compares", () => {
  it("sends one compare-generate for a view showing a pair, after the build settles", () => {
    const { viewer, send } = setup();
    viewer.emitAssembly();
    viewer.emitAssembly();
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SETTLE_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ type: "compare-generate", name: "base", ref: "ref", view: "assembly", params: { size: 10 } });
  });

  it("sends nothing for a view showing only the part", () => {
    const { viewer, send } = setup({ params: { showRef: false } });
    viewer.emitAssembly();
    vi.advanceTimersByTime(SETTLE_MS * 4);
    expect(send).not.toHaveBeenCalled();
  });

  it("waits while the build is not settled, then sends", () => {
    let ok = false;
    const { viewer, send } = setup({ settled: () => ok });
    viewer.emitAssembly();
    vi.advanceTimersByTime(SETTLE_MS * 3);
    expect(send).not.toHaveBeenCalled();
    ok = true;
    vi.advanceTimersByTime(SETTLE_MS);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("draws the reply, applying the hidden state", () => {
    const { viewer, reply } = setup({ initial: { hidden: { missing: true } } });
    viewer.emitAssembly(); vi.advanceTimersByTime(SETTLE_MS);
    expect(reply({ pieces: PIECES })).toBe(true);
    expect(viewer.setCompare).toHaveBeenCalledWith({ name: "base", ref: "ref", pieces: PIECES });
    expect(viewer.getCompare().hidden).toEqual({ missing: true, excess: false });
  });

  it("drops a reply whose jobId is not the latest", () => {
    const { viewer, params, send, cv } = setup();
    viewer.emitAssembly(); vi.advanceTimersByTime(SETTLE_MS);
    const first = send.mock.calls[0][0].jobId;
    params.size = 20;
    viewer.emitAssembly(); vi.advanceTimersByTime(SETTLE_MS);
    expect(send).toHaveBeenCalledTimes(2);
    expect(cv.handleMessage({ type: "compare-meshes", jobId: first, pieces: PIECES, tolerance: 0.05 })).toBe(true);
    expect(viewer.setCompare).not.toHaveBeenCalled();
  });

  it("claims a compare reply from another mount, and leaves other replies alone", () => {
    const { cv } = setup();
    expect(cv.handleMessage({ type: "error", jobId: "cmp-999-1", message: "x" })).toBe(true);
    expect(cv.handleMessage({ type: "meshes", meshes: [] })).toBe(false);
    expect(cv.handleMessage({ type: "error", jobId: "cap-1-1" })).toBe(false);
  });

  it("clears at once on a rebuild and sends a new job once it settles", () => {
    const { viewer, params, send, reply } = setup();
    viewer.emitAssembly(); vi.advanceTimersByTime(SETTLE_MS);
    reply({ pieces: PIECES });
    viewer.clearCompare.mockClear();
    params.size = 12;
    viewer.emitAssembly();
    expect(viewer.clearCompare).toHaveBeenCalled();
    expect(viewer.getCompare()).toBe(null);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].params.size).toBe(12);
  });

  it("an unchanged build leaves a drawn comparison alone", () => {
    const { viewer, send, reply } = setup();
    viewer.emitAssembly(); vi.advanceTimersByTime(SETTLE_MS);
    reply({ pieces: PIECES });
    viewer.clearCompare.mockClear();
    viewer.emitAssembly(); vi.advanceTimersByTime(SETTLE_MS);
    expect(viewer.clearCompare).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("hiding either sub-part of the pair in the Parts list clears the comparison", () => {
    for (const name of ["base", "ref"]) {
      document.body.innerHTML = "";
      const { viewer, send, reply, legend } = setup();
      viewer.emitAssembly(); vi.advanceTimersByTime(SETTLE_MS);
      reply({ pieces: PIECES });
      viewer.setSubPartDisplay(name, { hidden: true });
      expect(viewer.getCompare()).toBe(null);
      expect(legend().hidden).toBe(true);
      vi.advanceTimersByTime(SETTLE_MS * 3);
      expect(send).toHaveBeenCalledTimes(1);
    }
  });

  it("first pair in declaration order wins", () => {
    const viewer = fakeViewer();
    const send = vi.fn();
    const p = { parts: { a: { views: ["v"] }, b: { reference: "a", views: ["v"] }, c: { reference: "a", views: ["v"] } }, defaults: {} };
    createCompareView({ part: p, viewer, view: () => "v", params: () => ({}), send, viewbar: null });
    viewer.emitAssembly(); vi.advanceTimersByTime(SETTLE_MS);
    expect(send.mock.calls[0][0]).toMatchObject({ name: "b", ref: "a" });
  });
});

describe("compare view: refused comparisons", () => {
  it.each([
    ["too-large", "Differences not available (model too large)"],
    ["not-closed", "Differences not available (reference is not a closed solid)"],
    ["unsupported", "Differences not available (exact-kernel part)"],
  ])("a %s reply draws nothing and the toggle says so", (skipped, text) => {
    const { viewer, cv, reply, legend } = setup();
    viewer.emitAssembly(); vi.advanceTimersByTime(SETTLE_MS);
    reply({ skipped });
    expect(viewer.setCompare).not.toHaveBeenCalled();
    expect(legend().hidden).toBe(true);
    expect(cv.seam.state().toggle).toEqual({ on: false, disabled: true, text });
  });

  it("an error reply is no comparison, claimed so it never reads as a build failure", () => {
    const { viewer, cv, lastJob } = setup();
    viewer.emitAssembly(); vi.advanceTimersByTime(SETTLE_MS);
    expect(cv.handleMessage({ type: "error", jobId: lastJob().jobId, message: "boom" })).toBe(true);
    expect(viewer.setCompare).not.toHaveBeenCalled();
    expect(cv.seam.state().toggle).toEqual({ on: false, disabled: true, text: "Differences not available" });
  });
});

describe("compare view: the legend", () => {
  it("shows three chips; Missing and Extra are pressed buttons, Matches is not a button", () => {
    const { viewer, reply, legend } = setup();
    viewer.emitAssembly(); vi.advanceTimersByTime(SETTLE_MS);
    expect(legend().hidden).toBe(true);
    reply({ pieces: PIECES });
    const box = legend();
    expect(box.hidden).toBe(false);
    expect(box.getAttribute("aria-label")).toBeTruthy();
    const chips = [...box.children];
    expect(chips.map((c) => c.textContent)).toEqual(["Matches", "Missing", "Extra"]);
    expect(chips[0].tagName).not.toBe("BUTTON");
    for (const c of chips.slice(1)) {
      expect(c.tagName).toBe("BUTTON");
      expect(c.getAttribute("aria-pressed")).toBe("true");
    }
    const swatches = chips.map((c) => c.querySelector(".pf-compare-swatch").style.background);
    expect(swatches.join(" ").replace(/\s+/g, "")).toMatch(/9ca3af|156,163,175/);
  });

  it("a null piece reads 'none' and is not a button", () => {
    const { viewer, reply, legend } = setup();
    viewer.emitAssembly(); vi.advanceTimersByTime(SETTLE_MS);
    reply({ pieces: { common: mesh(100), missing: null, excess: null } });
    const chips = [...legend().children];
    expect(chips.map((c) => c.textContent)).toEqual(["Matches", "Missing: none", "Extra: none"]);
    expect(chips.every((c) => c.tagName !== "BUTTON")).toBe(true);
  });

  it("a chip click hides its piece, and the Parts list eye for that row agrees", () => {
    const { viewer, reply, legend, cv, part: thePart, params } = setup();
    viewer.emitAssembly(); vi.advanceTimersByTime(SETTLE_MS);
    reply({ pieces: PIECES });
    const parts = {
      list: () => subPartRows(thePart, { view: "assembly", params, overrides: viewer.getDisplayOverrides() }),
      setDisplay: viewer.setSubPartDisplay, clear: () => {}, onChange: viewer.onDisplayChange,
      compare: cv.seam,
    };
    const list = attachPartsList(parts);
    document.body.append(list.element);
    legend().querySelector("button").click(); // Missing
    expect(viewer.setCompareHidden).toHaveBeenLastCalledWith("missing", true);
    expect(cv.getState().hidden).toEqual({ missing: true, excess: false });
    expect(legend().children[1].getAttribute("aria-pressed")).toBe("false");
    list.render();
    const eye = list.element.querySelector('.pf-parts-row[data-piece="missing"] .pf-parts-eye');
    expect(eye.getAttribute("aria-pressed")).toBe("true");
    // ...and the other way round: the eye drives the chip.
    eye.click();
    expect(viewer.setCompareHidden).toHaveBeenLastCalledWith("missing", false);
    expect(legend().children[1].getAttribute("aria-pressed")).toBe("true");
    list.detach();
  });

  it("yields to a measure or drag readout and comes back when it clears", async () => {
    const { viewer, reply, legend, viewbar } = setup();
    viewer.emitAssembly(); vi.advanceTimersByTime(SETTLE_MS);
    reply({ pieces: PIECES });
    const other = document.createElement("div");
    other.className = "pf-viewbar-readout pf-pose-readout";
    other.hidden = true;
    viewbar.append(other);
    const flush = () => vi.advanceTimersByTimeAsync(1); // the MutationObserver's delivery
    await flush();
    expect(legend().hidden).toBe(false);
    other.hidden = false;
    await flush();
    expect(legend().hidden).toBe(true);
    other.hidden = true;
    await flush();
    expect(legend().hidden).toBe(false);
  });
});

describe("compare view: the toggle and viewer state", () => {
  it("setEnabled(false) keeps the result held but off screen, hides the legend, and is the state", () => {
    const { viewer, cv, reply, legend, send } = setup();
    viewer.emitAssembly(); vi.advanceTimersByTime(SETTLE_MS);
    reply({ pieces: PIECES });
    cv.setEnabled(false);
    expect(viewer.shown).toBe(false);
    expect(viewer.getCompare()).toEqual({ name: "base", ref: "ref", hidden: { missing: false, excess: false } }); // held for captures
    expect(legend().hidden).toBe(true);
    expect(cv.getState().enabled).toBe(false);
    expect(cv.seam.state().toggle).toEqual({ on: false, disabled: false, text: "Show differences" });
    expect(cv.seam.state().pieces).toBe(null);
    cv.setEnabled(true);
    expect(viewer.shown).toBe(true);
    expect(legend().hidden).toBe(false);
    vi.advanceTimersByTime(SETTLE_MS * 3);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a remount with initial { enabled: false } still sends the job and holds the result off screen; turning it on shows it with no new job", () => {
    const { viewer, cv, send, reply, legend } = setup({ initial: { enabled: false } });
    expect(viewer.shown).toBe(false);
    viewer.emitAssembly(); vi.advanceTimersByTime(SETTLE_MS);
    expect(send).toHaveBeenCalledTimes(1);
    reply({ pieces: PIECES });
    expect(viewer.setCompare).toHaveBeenCalledWith({ name: "base", ref: "ref", pieces: PIECES });
    expect(viewer.shown).toBe(false);
    expect(legend().hidden).toBe(true);
    cv.setEnabled(true);
    expect(viewer.shown).toBe(true);
    expect(legend().hidden).toBe(false);
    vi.advanceTimersByTime(SETTLE_MS * 3);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("captureReady waits on the job with the toggle off too", async () => {
    const { viewer, cv, reply } = setup({ initial: { enabled: false } });
    viewer.emitAssembly();
    let done = false;
    cv.captureReady().then(() => { done = true; });
    vi.advanceTimersByTime(SETTLE_MS);
    await Promise.resolve();
    expect(done).toBe(false);
    reply({ pieces: PIECES });
    await Promise.resolve();
    expect(done).toBe(true);
  });

  it("a refusal with the toggle off still disables the switch with its reason", () => {
    const { viewer, cv, reply } = setup({ initial: { enabled: false } });
    viewer.emitAssembly(); vi.advanceTimersByTime(SETTLE_MS);
    reply({ skipped: "too-large" });
    expect(cv.seam.state().toggle).toEqual({ on: false, disabled: true, text: "Differences not available (model too large)" });
  });

  it("ignores a malformed initial state", () => {
    for (const initial of [null, 7, "x", [], { enabled: "no", hidden: 3 }, { hidden: { missing: "yes" } }]) {
      document.body.innerHTML = "";
      const { cv } = setup({ initial });
      expect(cv.getState()).toEqual({ enabled: true, hidden: { missing: false, excess: false } });
    }
  });

  it("no seam state without a pair in view", () => {
    const { viewer, cv } = setup({ params: { showRef: false } });
    viewer.emitAssembly();
    expect(cv.seam.state()).toBe(null);
  });

  it("captureReady resolves once drawn or refused", async () => {
    const { viewer, cv, reply } = setup();
    await cv.captureReady(); // nothing to compare yet
    viewer.emitAssembly();
    let done = false;
    cv.captureReady().then(() => { done = true; });
    vi.advanceTimersByTime(SETTLE_MS);
    await Promise.resolve();
    expect(done).toBe(false);
    reply({ skipped: "too-large" });
    await Promise.resolve();
    expect(done).toBe(true);
  });

  it("dispose clears the comparison and removes the legend", () => {
    const { viewer, cv, reply, viewbar } = setup();
    viewer.emitAssembly(); vi.advanceTimersByTime(SETTLE_MS);
    reply({ pieces: PIECES });
    cv.dispose();
    expect(viewer.getCompare()).toBe(null);
    expect(viewbar.querySelector(".pf-compare-legend")).toBe(null);
  });
});

describe("parts list: the compare rows", () => {
  it("draws the switch and three piece rows under the part, Matches without an eye", () => {
    const { viewer, reply, cv, part: thePart, params } = setup();
    viewer.emitAssembly(); vi.advanceTimersByTime(SETTLE_MS);
    reply({ pieces: PIECES });
    const list = attachPartsList({
      list: () => subPartRows(thePart, { view: "assembly", params, overrides: viewer.getDisplayOverrides() }),
      setDisplay: viewer.setSubPartDisplay, clear: () => {}, onChange: viewer.onDisplayChange, compare: cv.seam,
    });
    document.body.append(list.element);
    const rows = [...list.element.querySelectorAll(".pf-parts-row")];
    expect(rows.map((r) => r.dataset.piece ?? r.dataset.name)).toEqual(["base", "common", "missing", "excess", "ref", "other"]);
    expect(rows[1].textContent).toContain("Matches");
    expect(rows[2].textContent).toContain("Missing from Base");
    expect(rows[3].textContent).toContain("Extra in Base");
    expect(rows[1].querySelector(".pf-parts-eye")).toBe(null);
    expect(rows[1].querySelector(".pf-parts-open")).toBe(null); // no appearance card: no see-through
    const sw = list.element.querySelector(".pf-parts-compare");
    expect(sw.getAttribute("role")).toBe("switch");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(sw.textContent).toContain("Show differences");
    sw.click();
    expect(cv.getState().enabled).toBe(false);
    expect(list.element.querySelector('.pf-parts-row[data-piece]')).toBe(null);
    expect(list.element.querySelector(".pf-parts-compare").getAttribute("aria-checked")).toBe("false");
    list.detach();
  });

  it("a refused comparison shows a disabled switch with the reason", () => {
    const { viewer, reply, cv, part: thePart, params } = setup();
    viewer.emitAssembly(); vi.advanceTimersByTime(SETTLE_MS);
    reply({ skipped: "not-closed" });
    const list = attachPartsList({
      list: () => subPartRows(thePart, { view: "assembly", params }),
      setDisplay: () => {}, clear: () => {}, onChange: () => () => {}, compare: cv.seam,
    });
    const sw = list.element.querySelector(".pf-parts-compare");
    expect(sw.disabled).toBe(true);
    expect(sw.textContent).toBe("Differences not available (reference is not a closed solid)");
    list.detach();
  });

  it("without a compare seam the list is as before", () => {
    const list = attachPartsList({ list: () => subPartRows(part(), { view: "assembly", params: part().defaults }), setDisplay: () => {}, clear: () => {}, onChange: () => () => {} });
    expect(list.element.querySelector(".pf-parts-compare")).toBe(null);
    list.detach();
  });
});

describe("mount handle: getViewerState().compare", () => {
  it("carries the compare state only while it differs from the default", async () => {
    const { makeHandle } = await import("../src/framework/mount.js");
    const viewer = { getCameraState: () => null };
    const none = makeHandle({ ready: Promise.resolve(), dispose: () => {}, viewer, compareState: () => null });
    expect("compare" in none.getViewerState()).toBe(false);
    const state = { enabled: false, hidden: { missing: true, excess: false } };
    const held = makeHandle({ ready: Promise.resolve(), dispose: () => {}, viewer, compareState: () => state });
    expect(held.getViewerState().compare).toEqual(state);
  });

  it("round-trips through a remount's initial", () => {
    const { cv } = setup({ initial: { enabled: false, hidden: { excess: true } } });
    const again = setup({ initial: JSON.parse(JSON.stringify(cv.getState())) });
    expect(again.cv.getState()).toEqual({ enabled: false, hidden: { missing: false, excess: true } });
  });
});

describe("compare view: fix round 1", () => {
  it("a param change with no assembly event (a pose-only edit) clears at once and re-runs after settling", () => {
    const { viewer, params, send, reply, cv, legend } = setup();
    viewer.emitAssembly(); vi.advanceTimersByTime(SETTLE_MS);
    reply({ pieces: PIECES });
    params.size = 14; // mount: fastPath.repair moved the pair by matrix, then refresh()
    cv.refresh();
    expect(viewer.getCompare()).toBe(null);
    expect(legend().hidden).toBe(true);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].params.size).toBe(14);
  });

  it("motion that keeps changing params (a playing track, a drag) holds the job until it rests", () => {
    const { viewer, params, send, reply, cv } = setup();
    viewer.emitAssembly(); vi.advanceTimersByTime(SETTLE_MS);
    reply({ pieces: PIECES });
    for (let i = 0; i < 20; i++) { params.size = 10 + i; cv.refresh(); vi.advanceTimersByTime(16); }
    expect(viewer.getCompare()).toBe(null);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("a job with no reply is refused after the deadline and frees captureReady", async () => {
    const { viewer, cv, send } = setup();
    viewer.emitAssembly(); vi.advanceTimersByTime(SETTLE_MS);
    let done = false;
    cv.captureReady().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(JOB_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect(cv.seam.state().toggle).toEqual({ on: false, disabled: true, text: "Differences not available" });
    expect(viewer.setCompare).not.toHaveBeenCalled();
    // its late reply is dropped, and a later change compares again
    expect(cv.handleMessage({ type: "compare-meshes", jobId: send.mock.calls[0][0].jobId, pieces: PIECES, tolerance: 0.05 })).toBe(true);
    expect(viewer.setCompare).not.toHaveBeenCalled();
  });

  it("captureReady resolves after the bound when the build never settles", async () => {
    const { viewer, cv, send } = setup({ settled: () => false });
    viewer.emitAssembly();
    let done = false;
    cv.captureReady().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(JOB_TIMEOUT_MS);
    expect(done).toBe(true);
    expect(send).not.toHaveBeenCalled();
    cv.dispose();
  });

  it("the legend's colours are the viewer's", () => {
    for (const k of ["common", "missing", "excess"]) {
      expect(COMPARE_HEX[k]).toBe(`#${COMPARE_COLORS[k].toString(16).padStart(6, "0")}`);
    }
    expect(COMPARE_HEX).toEqual({ common: "#9ca3af", missing: "#3b82f6", excess: "#ec4899" });
  });
});
