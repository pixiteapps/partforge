// @vitest-environment happy-dom
import { expect, test, vi } from "vitest";
import * as THREE from "three";

vi.mock("../src/framework/selection/raycast.js", () => ({
  raycastViewer: vi.fn(() => ({
    subPart: "body", triIndex: 7, pointLocal: [0, 0, 0], normalLocal: [0, 0, 1],
    pointWorld: new THREE.Vector3(), feature: null,
  })),
  worldToSubPartLocal: vi.fn(),
}));

import { attachPicker } from "../src/framework/selection/pick.js";

test("onPick receives the raw hit as its third argument", () => {
  const domElement = document.createElement("div");
  domElement.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 });
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const viewer = { domElement, camera, flashPoint: vi.fn() };
  const onPick = vi.fn();
  const picker = attachPicker(viewer, {
    part: { subParts: [{ name: "body" }] },
    getContext: () => ({ view: "v", params: {}, readsOf: () => null }),
    onPick,
  });
  picker.setActive(true);
  domElement.dispatchEvent(new MouseEvent("click", { clientX: 100, clientY: 100 }));
  expect(onPick).toHaveBeenCalledTimes(1);
  expect(onPick.mock.calls[0][2].triIndex).toBe(7);
  expect(onPick.mock.calls[0][2].subPart).toBe("body");
});
