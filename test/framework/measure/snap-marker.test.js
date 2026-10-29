// @vitest-environment happy-dom
// Snap marker: draws exactly what a click would grab (highlight, chain, rim,
// dot) under the hit mesh, plus a DOM label in the stage.
import { expect, test, vi } from "vitest";
import * as THREE from "three";
import { createSnapMarker } from "../../../src/framework/measure/snap-marker.js";

// A 20×10 plate's top face at z=2, feature 1.
function plateMesh() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
    0, 0, 2, 20, 0, 2, 20, 10, 2,
    0, 0, 2, 20, 10, 2, 0, 10, 2,
  ]), 3));
  geo.userData.featureIds = new Uint16Array([1, 1]);
  geo.userData.features = ["top face"];
  return new THREE.Mesh(geo);
}

// The fake viewer pattern from measure-mode.test.js, trimmed to what the marker touches.
function fakeViewer(mesh) {
  const parts = new THREE.Group();
  parts.add(mesh);
  parts.updateMatrixWorld(true);
  const dom = document.createElement("div");
  const stage = document.createElement("div");
  stage.appendChild(dom);
  dom.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
  Object.defineProperty(dom, "clientWidth", { value: 100 });
  Object.defineProperty(dom, "clientHeight", { value: 100 });
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(10, 5, 40);
  camera.lookAt(10, 5, 2);
  camera.updateMatrixWorld(true);
  const frameCbs = new Set();
  const captureHidden = new Set();
  const themeCbs = new Set();
  return {
    domElement: dom, stageElement: stage, camera,
    requestRender: vi.fn(),
    registerCutawayMaterial: () => () => {},
    registerCaptureHidden: vi.fn((obj) => { captureHidden.add(obj); return () => captureHidden.delete(obj); }),
    captureHidden,
    getTheme: () => "dark",
    onThemeChange: (cb) => { themeCbs.add(cb); return () => themeCbs.delete(cb); },
    onFrame: (cb) => { frameCbs.add(cb); return () => frameCbs.delete(cb); },
    frame: () => { for (const cb of [...frameCbs]) cb(16); },
  };
}

function setup() {
  const mesh = plateMesh();
  const viewer = fakeViewer(mesh);
  const marker = createSnapMarker(viewer, { stage: viewer.stageElement });
  const marks = () => mesh.children.find((c) => c.name === "pf-measure-snap");
  const highlight = () => mesh.children.find((c) => c.isMesh && c.material?.opacity === 0.35);
  const dot = () => marks()?.children.find((c) => c.name === "pf-measure-snap-dot");
  const line = () => marks()?.children.find((c) => c.isLineSegments2);
  const label = () => viewer.stageElement.querySelector(".pf-measure-snap");
  const visible = (o) => {
    for (let n = o; n; n = n.parent) if (!n.visible) return false;
    return true;
  };
  return { mesh, viewer, marker, marks, highlight, dot, line, label, visible };
}

const chain = { points: [[0, 0, 2], [20, 0, 2]], straight: true, length: 20, mid: [10, 0, 2], owners: [1] };

test("face shows the highlight and no dot", () => {
  const s = setup();
  s.marker.show({ kind: "face", point: [5, 5, 2], featureId: 1 }, s.mesh, "top face · face");
  expect(s.highlight()?.visible).toBe(true);
  expect(s.dot() && s.visible(s.dot())).toBeFalsy();
  expect(s.line() && s.visible(s.line())).toBeFalsy();
  expect(s.label().textContent).toBe("top face · face");
  s.marker.dispose();
});

test("corner shows a dot and the label text", () => {
  const s = setup();
  s.marker.show({ kind: "corner", point: [20, 10, 2], featureId: 1 }, s.mesh, "top face · corner");
  expect(s.visible(s.dot())).toBe(true);
  expect(s.dot().position.toArray()).toEqual([20, 10, 2]);
  expect(s.highlight()?.visible ?? false).toBe(false);
  const el = s.label();
  expect(el.textContent).toBe("top face · corner");
  expect(el.hidden).toBe(false);
  // projected corner, offset 12 px up-right
  const p = s.mesh.localToWorld(new THREE.Vector3(20, 10, 2)).project(s.viewer.camera);
  expect(parseFloat(el.style.left)).toBeCloseTo((p.x + 1) * 50 + 12, 3);
  expect(parseFloat(el.style.top)).toBeCloseTo((1 - p.y) * 50 - 12, 3);
  s.marker.dispose();
});

test("edge shows the chain as a line and no dot; midpoint shows both", () => {
  const s = setup();
  s.marker.show({ kind: "edge", point: [4, 0, 2], featureId: 1, chain }, s.mesh, "top face · edge");
  expect(s.visible(s.line())).toBe(true);
  expect(s.visible(s.dot())).toBe(false);
  const start = s.line().geometry.attributes.instanceStart;
  expect(start.count).toBe(1);
  s.marker.show({ kind: "midpoint", point: [10, 0, 2], featureId: 1, chain }, s.mesh, "top face · midpoint");
  expect(s.visible(s.line())).toBe(true);
  expect(s.visible(s.dot())).toBe(true);
  s.marker.dispose();
});

test("circle without a chain draws a 48-point rim loop and a centre dot", () => {
  const s = setup();
  const circle = { centre: [10, 5, 2], axis: [0, 0, 1], radius: 3 };
  s.marker.show({ kind: "circle", point: [10, 5, 2], featureId: 1, circle }, s.mesh, "hole · centre");
  expect(s.visible(s.line())).toBe(true);
  expect(s.line().geometry.attributes.instanceStart.count).toBe(48);
  const arr = s.line().geometry.attributes.instanceStart.data.array;
  expect(Math.hypot(arr[0] - 10, arr[1] - 5)).toBeCloseTo(3);
  expect(arr[2]).toBeCloseTo(2);
  expect(s.visible(s.dot())).toBe(true);
  s.marker.dispose();
});

test("same target twice does not rebuild", () => {
  const s = setup();
  const target = { kind: "midpoint", point: [10, 0, 2], featureId: 1, chain };
  s.marker.show(target, s.mesh, "top face · midpoint");
  const setPositions = vi.spyOn(s.line().geometry, "setPositions");
  const renders = s.viewer.requestRender.mock.calls.length;
  s.marker.show({ ...target, point: [10, 0, 2 + 1e-8] }, s.mesh, "top face · midpoint");
  expect(setPositions).not.toHaveBeenCalled();
  expect(s.viewer.requestRender.mock.calls.length).toBe(renders);
  s.marker.dispose();
});

test("clear hides everything", () => {
  const s = setup();
  s.marker.show({ kind: "midpoint", point: [10, 0, 2], featureId: 1, chain }, s.mesh, "m");
  s.marker.clear();
  expect(s.visible(s.dot())).toBe(false);
  expect(s.visible(s.line())).toBe(false);
  expect(s.label().hidden).toBe(true);
  s.marker.show({ kind: "face", point: [5, 5, 2], featureId: 1 }, s.mesh, "f");
  s.marker.clear();
  expect(s.highlight().visible).toBe(false);
  // a show after clear draws again (clear forgets the last target)
  s.marker.show({ kind: "face", point: [5, 5, 2], featureId: 1 }, s.mesh, "f");
  expect(s.highlight().visible).toBe(true);
  s.marker.dispose();
});

test("marker is capture-hidden", () => {
  const s = setup();
  s.marker.show({ kind: "corner", point: [0, 0, 2], featureId: 1 }, s.mesh, "c");
  s.marker.setStart([20, 0, 2], s.mesh);
  expect(s.viewer.captureHidden.has(s.marks())).toBe(true);
  const start = s.mesh.children.find((c) => c.name === "pf-measure-start");
  expect(s.viewer.captureHidden.has(start)).toBe(true);
  s.marker.dispose();
  expect(s.viewer.captureHidden.size).toBe(0);
  expect(s.mesh.children.filter((c) => c.name?.startsWith("pf-measure"))).toHaveLength(0);
  expect(s.label()).toBeNull();
});

test("setStart draws a persistent dot independent of show/clear", () => {
  const s = setup();
  const start = () => s.mesh.children.find((c) => c.name === "pf-measure-start");
  s.marker.setStart([20, 0, 2], s.mesh);
  expect(s.visible(start())).toBe(true);
  expect(start().children[0].position.toArray()).toEqual([20, 0, 2]);
  s.marker.show({ kind: "corner", point: [0, 0, 2], featureId: 1 }, s.mesh, "c");
  s.marker.clear();
  expect(s.visible(start())).toBe(true);
  s.marker.setStart(null, s.mesh);
  expect(start()?.visible ?? false).toBe(false);
  s.marker.dispose();
});

test("frames keep the dot screen-constant and the label on the point", () => {
  const s = setup();
  s.marker.show({ kind: "corner", point: [20, 10, 2], featureId: 1 }, s.mesh, "c");
  s.viewer.frame();
  const near = s.dot().scale.x;
  s.viewer.camera.position.set(10, 5, 80);
  s.viewer.camera.updateMatrixWorld(true);
  s.viewer.frame();
  expect(s.dot().scale.x).toBeGreaterThan(near * 1.5);
  const p = s.mesh.localToWorld(new THREE.Vector3(20, 10, 2)).project(s.viewer.camera);
  expect(parseFloat(s.label().style.left)).toBeCloseTo((p.x + 1) * 50 + 12, 3);
  s.marker.dispose();
});
