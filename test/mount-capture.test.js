import { describe, it, expect, vi } from "vitest";

// mount() needs a DOM + workers; assert the handle SHAPE by checking the exported
// factory wires captureViews to viewer.captureCanonicalViews. We test the small
// delegation via a helper export to avoid booting WASM here.
import { makeHandle } from "../src/framework/mount.js";

describe("mount handle captureViews", () => {
  it("delegates to viewer.captureCanonicalViews", () => {
    const viewer = { captureCanonicalViews: vi.fn(() => [{ view: "iso", dataUrl: "d" }]) };
    const handle = makeHandle({ ready: Promise.resolve(), dispose: () => {}, viewer });
    const out = handle.captureViews(["iso"]);
    expect(viewer.captureCanonicalViews).toHaveBeenCalledWith(["iso"]);
    expect(out).toEqual([{ view: "iso", dataUrl: "d" }]);
  });

  it("delegates captureCurrent to viewer.captureCurrent", () => {
    const viewer = {
      captureCanonicalViews: vi.fn(),
      captureCurrent: vi.fn(() => "data:image/jpeg;base64,AAAA"),
    };
    const handle = makeHandle({ ready: Promise.resolve(), dispose: () => {}, viewer });
    const out = handle.captureCurrent({ size: 2048 });
    expect(viewer.captureCurrent).toHaveBeenCalledWith({ size: 2048 });
    expect(out).toBe("data:image/jpeg;base64,AAAA");
  });

  it("passes recenter through to viewer.captureCurrent when no dimensions are pinned", () => {
    const viewer = { captureCanonicalViews: vi.fn(), captureCurrent: vi.fn(() => "d") };
    const measure = { isEnabled: () => true, setEnabled: () => {}, clearPins: () => {}, pinCount: () => 0 };
    const handle = makeHandle({ ready: Promise.resolve(), dispose: () => {}, viewer, measure });
    handle.captureCurrent({ size: 2048, recenter: true });
    expect(viewer.captureCurrent).toHaveBeenCalledWith({ size: 2048, recenter: true });
    // No measure wired at all: same pass-through.
    makeHandle({ ready: Promise.resolve(), dispose: () => {}, viewer }).captureCurrent({ recenter: true });
    expect(viewer.captureCurrent).toHaveBeenLastCalledWith({ recenter: true });
  });

  it("withholds recenter while measurement dimensions are on screen", () => {
    const viewer = { captureCanonicalViews: vi.fn(), captureCurrent: vi.fn(() => "d") };
    const measure = { isEnabled: () => true, setEnabled: () => {}, clearPins: () => {}, pinCount: () => 2 };
    const handle = makeHandle({ ready: Promise.resolve(), dispose: () => {}, viewer, measure });
    handle.captureCurrent({ size: 2048, recenter: true });
    expect(viewer.captureCurrent).toHaveBeenCalledWith({ size: 2048, recenter: false });
  });

  it("delegates setActive to viewer.setActive", () => {
    const viewer = { captureCanonicalViews: vi.fn(), setActive: vi.fn() };
    const handle = makeHandle({ ready: Promise.resolve(), dispose: () => {}, viewer });
    handle.setActive(false);
    expect(viewer.setActive).toHaveBeenCalledWith(false);
  });

  it("delegates onContextLost and hands back the viewer's unsubscribe", () => {
    const off = vi.fn();
    const viewer = { captureCanonicalViews: vi.fn(), onContextLost: vi.fn(() => off) };
    const handle = makeHandle({ ready: Promise.resolve(), dispose: () => {}, viewer });
    const listener = vi.fn();
    expect(handle.onContextLost(listener)).toBe(off);
    expect(viewer.onContextLost).toHaveBeenCalledWith(listener);
  });

  it("exposes setParams straight through to the caller", () => {
    const viewer = { captureCanonicalViews: vi.fn() };
    const setParams = vi.fn();
    const handle = makeHandle({ ready: Promise.resolve(), dispose: () => {}, viewer, setParams });
    handle.setParams({ openAngle: 45 });
    expect(setParams).toHaveBeenCalledWith({ openAngle: 45 });
  });

  it("exposes captureReady, resolving at once when nothing is wired", async () => {
    const viewer = { captureCanonicalViews: vi.fn() };
    await expect(makeHandle({ ready: Promise.resolve(), dispose: () => {}, viewer }).captureReady()).resolves.toBeUndefined();
    const captureReady = vi.fn(() => Promise.resolve());
    const handle = makeHandle({ ready: Promise.resolve(), dispose: () => {}, viewer, captureReady });
    await handle.captureReady();
    expect(captureReady).toHaveBeenCalledTimes(1);
  });

  it("captureViews stays synchronous and does not wait on the comparison", () => {
    const viewer = { captureCanonicalViews: vi.fn(() => [{ view: "iso", dataUrl: "d" }]) };
    const captureReady = vi.fn(() => new Promise(() => {}));
    const handle = makeHandle({ ready: Promise.resolve(), dispose: () => {}, viewer, captureReady });
    expect(handle.captureViews(["iso"])).toEqual([{ view: "iso", dataUrl: "d" }]);
    expect(captureReady).not.toHaveBeenCalled();
  });

  it("renderViews awaits captureReady before it captures", async () => {
    let settle;
    const captureReady = vi.fn(() => new Promise((r) => { settle = r; }));
    const renderViews = vi.fn(async () => [{ view: "iso", dataUrl: "d" }]);
    const beforeCapture = vi.fn(() => () => {});
    const viewer = { captureCanonicalViews: vi.fn() };
    const handle = makeHandle({ ready: Promise.resolve(), dispose: () => {}, viewer, renderViews, captureReady, beforeCapture });
    const out = handle.renderViews(["iso"], { renderMode: "realistic" });
    await Promise.resolve();
    expect(captureReady).toHaveBeenCalled();
    expect(renderViews).not.toHaveBeenCalled();
    expect(beforeCapture).not.toHaveBeenCalled();
    settle();
    await expect(out).resolves.toEqual([{ view: "iso", dataUrl: "d" }]);
    expect(renderViews).toHaveBeenCalledWith(["iso"], { renderMode: "realistic" });
  });
});
