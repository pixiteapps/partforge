// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { createPoseScene } from "../../src/framework/pose/pose-scene.js";

function fakeViewer(ortho = false) {
  const parts = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BufferGeometry());
  parts.add(mesh);
  new THREE.Scene().add(parts);
  const camera = ortho ? new THREE.OrthographicCamera(-50, 50, 40, -40) : new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 100);
  camera.updateMatrixWorld();
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientWidth", { value: 800 });
  Object.defineProperty(canvas, "clientHeight", { value: 600 });
  return {
    _subMeshes: { body: mesh }, camera, domElement: canvas,
    getTheme: () => "dark", requestRender: vi.fn(),
    registerCanonicalCaptureHidden: vi.fn(() => vi.fn()),
    __parts: parts,
  };
}
const fakePaint = ({ text }) => { const c = document.createElement("canvas"); c.width = 40 * text.length; c.height = 128; return c; };

const INFO = {
  kind: "partforge.limb", name: "arm",
  joints: [
    { name: "shoulder", frame: "a", type: "hinge", range: [-45, 90], follower: false },
    { name: "elbow", frame: "b", type: "hinge", range: [0, 120], follower: false },
  ],
  tip: "t", r: [3, 2, 1],
  points: { shoulder: [0, 0, 0], elbow: [10, 0, 0], tip: [20, 5, 0] },
  values: [10, 20], axes: { shoulder: [0, 0, 1], elbow: [0, 0, 1] },
};

describe("createPoseScene", () => {
  for (const ortho of [false, true]) {
    it(`runs the whole lifecycle without throwing (${ortho ? "ortho" : "persp"})`, () => {
      const viewer = fakeViewer(ortho);
      const scene = createPoseScene(viewer, { paintLabel: fakePaint });
      expect(viewer.registerCanonicalCaptureHidden).not.toHaveBeenCalled();
      scene.setLimbs([INFO]);
      expect(scene.group.parent).toBe(viewer.__parts);
      expect(viewer.registerCanonicalCaptureHidden).toHaveBeenCalledWith(scene.group);
      expect(scene.group.children.length).toBe(0); // at rest: nothing without a pin
      scene.tick();
      scene.setHover("arm");
      expect(scene.group.children.length).toBeGreaterThan(0);
      scene.setActive({ limb: "arm", grab: "elbow", clamped: [false, true], target: [30, 5, 0], residual: 10 });
      scene.setPins(["arm"]);
      scene.setAimRings({ at: [20, 5, 0], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] });
      scene.tick();
      scene.setTheme("light");
      scene.tick();
      scene.setAimRings(null);
      scene.setActive(null);
      scene.clear();
      expect(scene.group.children.length).toBe(0);
      scene.dispose();
      expect(scene.group.parent).toBeNull();
      expect(viewer.requestRender).toHaveBeenCalled();
    });
  }

  it("at rest draws only pin badges; a hovered limb shows its dots; a hovered dot gets a halo", () => {
    const viewer = fakeViewer();
    const scene = createPoseScene(viewer, { paintLabel: fakePaint });
    scene.setLimbs([INFO]);
    expect(scene.group.children.length).toBe(0);
    scene.setPins(["arm"]);
    expect(scene.group.children.length).toBe(2); // the badge: a head and its stem
    scene.setPins([]);
    scene.setHover("arm");
    const dots = () => scene.group.children.filter((c) => c.geometry?.type === "SphereGeometry").length;
    const halos = () => scene.group.children.filter((c) => c.geometry?.type === "RingGeometry").length;
    expect(dots()).toBe(3); // two joints and the tip
    expect(halos()).toBe(0);
    scene.setHover("arm", "elbow");
    expect(halos()).toBe(1);
    scene.setHover("arm", "tip");
    expect(halos()).toBe(1);
    scene.setHover(null);
    expect(scene.group.children.length).toBe(0);
    scene.dispose();
  });

  it("draws no reach-miss line at or below the residual threshold", () => {
    const viewer = fakeViewer();
    const scene = createPoseScene(viewer, { paintLabel: fakePaint });
    scene.setLimbs([INFO]);
    scene.setActive({ limb: "arm", grab: "tip", clamped: [false, false], target: [20, 5, 0], residual: 0.005 });
    const small = scene.group.children.length;
    scene.setActive({ limb: "arm", grab: "tip", clamped: [false, false], target: [30, 5, 0], residual: 4 });
    expect(scene.group.children.length).toBeGreaterThan(small);
    scene.dispose();
  });

  it("disposes aim-ring geometry when rebuilt", () => {
    const viewer = fakeViewer();
    const scene = createPoseScene(viewer, { paintLabel: fakePaint });
    scene.setLimbs([INFO]);
    scene.setAimRings({ at: [20, 5, 0], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] });
    const root = scene.group.children.find((c) => c.children.length === 3);
    const geos = root.children.map((c) => c.geometry);
    const spies = geos.map((g) => vi.spyOn(g, "dispose"));
    scene.setActive({ limb: "arm", grab: "tip", clamped: [false, false] });
    for (const s of spies) expect(s).toHaveBeenCalledTimes(1);
    scene.dispose();
  });

  it("keeps state set before the parts exist and builds when they appear", () => {
    const viewer = fakeViewer();
    const meshes = viewer._subMeshes;
    viewer._subMeshes = {};
    const scene = createPoseScene(viewer, { paintLabel: fakePaint });
    scene.setLimbs([INFO]);
    scene.setHover("arm");
    expect(scene.group.children.length).toBe(0);
    viewer._subMeshes = meshes;
    scene.tick();
    expect(scene.group.children.length).toBeGreaterThan(0);
    scene.dispose();
  });
});
