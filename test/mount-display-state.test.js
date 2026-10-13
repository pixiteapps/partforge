// test/mount-display-state.test.js
import { describe, it, expect, vi } from "vitest";
import { makeHandle } from "../src/framework/mount.js";

const viewerStub = (overrides = {}) => ({
  captureCanonicalViews: vi.fn(),
  getCameraState: () => ({ pos: [1, 2, 3], target: [0, 0, 0] }),
  getDisplayOverrides: () => overrides,
  setSubPartDisplay: vi.fn((name, patch) => ({ ...patch })),
  getSubPartDisplayState: vi.fn(() => ({ authored: null, override: null, effective: {}, hidden: false, opacity: 1 })),
  clearSubPartDisplay: vi.fn(),
  onDisplayChange: vi.fn(() => () => {}),
});

describe("mount handle display hops", () => {
  it("getViewerState carries `display` only while an override is held", () => {
    const empty = makeHandle({ ready: Promise.resolve(), dispose: () => {}, viewer: viewerStub({}) });
    expect("display" in empty.getViewerState()).toBe(false);
    const held = makeHandle({ ready: Promise.resolve(), dispose: () => {}, viewer: viewerStub({ lid: { material: "oak" } }) });
    expect(held.getViewerState().display).toEqual({ lid: { material: "oak" } });
  });
  it("delegates set/get/clear/onChange to the viewer", () => {
    const viewer = viewerStub();
    const h = makeHandle({ ready: Promise.resolve(), dispose: () => {}, viewer });
    expect(h.setSubPartDisplay("lid", { material: "oak" })).toEqual({ material: "oak" });
    expect(viewer.setSubPartDisplay).toHaveBeenCalledWith("lid", { material: "oak" });
    h.getSubPartDisplay("lid");
    expect(viewer.getSubPartDisplayState).toHaveBeenCalledWith("lid");
    h.clearSubPartDisplay({ viewing: true });
    expect(viewer.clearSubPartDisplay).toHaveBeenCalledWith({ viewing: true });
    const cb = () => {};
    h.onSubPartDisplayChange(cb);
    expect(viewer.onDisplayChange).toHaveBeenCalledWith(cb);
  });
  it("listSubParts uses the active view by default and an explicit one when given", () => {
    const listSubParts = vi.fn((opts) => [{ name: "lid", view: opts?.view }]);
    const h = makeHandle({ ready: Promise.resolve(), dispose: () => {}, viewer: viewerStub(), listSubParts });
    expect(h.listSubParts()).toEqual([{ name: "lid", view: undefined }]);
    expect(h.listSubParts({ view: "body" })).toEqual([{ name: "lid", view: "body" }]);
  });
  it("openAppearance and setDisplaySaveState default to no-ops with fixed return shapes", () => {
    const h = makeHandle({ ready: Promise.resolve(), dispose: () => {}, viewer: viewerStub() });
    expect(h.openAppearance("lid")).toBe(false);
    expect(h.setDisplaySaveState("saved")).toBeUndefined();
    expect(h.listSubParts()).toEqual([]);
  });
});
