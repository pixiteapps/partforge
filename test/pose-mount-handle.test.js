// The mount handle's Pose-mode surface (spec 2026-10-30 §4): runtime.pose is never
// absent, and Pose pins ride getViewerState() only while one is set. mount() itself
// is driven in real Chromium by scripts/check-pose.mjs; this pins the handle's shape.
import { expect, test } from "vitest";
import { makeHandle } from "../src/framework/mount.js";

const viewer = { getCameraState: () => null };
const base = { ready: Promise.resolve(), dispose() {}, viewer, setParams() {} };

test("a mount with no pose mode gets the no-op stand-in", () => {
  const { pose } = makeHandle(base);
  expect(pose.isEnabled()).toBe(false);
  pose.setEnabled(true);
  expect(pose.isEnabled()).toBe(false);
  expect(pose.pinCount()).toBe(0);
  expect(pose.handlePoints()).toEqual([]);
});

test("getViewerState carries pose pins only while one is set", () => {
  let pins = null;
  const handle = makeHandle({ ...base, poseState: () => (pins ? { pins } : null) });
  expect(handle.getViewerState()).not.toHaveProperty("pose");
  pins = ["a:tip", "b:tip"];
  expect(handle.getViewerState().pose).toEqual({ pins: ["a:tip", "b:tip"] });
});
