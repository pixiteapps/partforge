// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { createPoseScene, POSE_THEME } from "../../src/framework/pose/pose-scene.js";

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
      scene.setPins([{ limb: "arm", at: "tip" }, { limb: "arm", at: "elbow" }]);
      scene.setAimGizmo({ limb: "arm", at: "tip" });
      scene.tick();
      scene.setTheme("light");
      scene.tick();
      scene.setAimGizmo(null);
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
    scene.setPins([{ limb: "arm", at: "tip" }]);
    expect(scene.group.children.length).toBe(3); // the badge: a dot on the point, a head and its stem
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

  it("a pin badge sits AT the pinned point (a joint too), follows it, and a shown pinned dot is pin-coloured", () => {
    const viewer = fakeViewer();
    const scene = createPoseScene(viewer, { paintLabel: fakePaint });
    scene.setLimbs([INFO]);
    scene.setPins([{ limb: "arm", at: "elbow" }]);
    const spheres = () => scene.group.children.filter((c) => c.geometry?.type === "SphereGeometry");
    const pinColor = POSE_THEME.dark.pin;
    // at rest: the base dot on the elbow and the head above it, both pin-coloured
    scene.tick();
    const [base, head] = spheres();
    expect(base.position.toArray()).toEqual([10, 0, 0]);
    expect(base.material.color.getHex()).toBe(pinColor);
    expect(head.material.color.getHex()).toBe(pinColor);
    expect(head.position.distanceTo(base.position)).toBeGreaterThan(0);
    // the limb moves: the badge goes with the point
    scene.setLimbs([{ ...INFO, points: { ...INFO.points, elbow: [12, 3, 0] } }]);
    scene.tick();
    expect(spheres()[0].position.toArray()).toEqual([12, 3, 0]);
    // hovered: the elbow's own dot is drawn pinned (pin colour, a tip's size), no second base dot
    scene.setLimbs([INFO]);
    scene.setHover("arm");
    scene.tick();
    const atElbow = spheres().filter((m) => m.position.equals(new THREE.Vector3(10, 0, 0)));
    expect(atElbow).toHaveLength(1);
    expect(atElbow[0].material.color.getHex()).toBe(pinColor);
    const shoulder = spheres().find((m) => m.position.equals(new THREE.Vector3(0, 0, 0)));
    expect(shoulder.material.color.getHex()).not.toBe(pinColor);
    expect(atElbow[0].scale.x).toBeGreaterThan(shoulder.scale.x);
    // an unknown limb or point draws nothing
    scene.setHover(null);
    scene.setPins([{ limb: "other", at: "tip" }, { limb: "arm", at: "nope" }]);
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

  it("leaves the goal point the aim gizmo's ball stands on undrawn", () => {
    const viewer = fakeViewer();
    const scene = createPoseScene(viewer, { paintLabel: fakePaint });
    scene.setLimbs([INFO]);
    scene.setHover("arm", "tip");
    const dots = () => scene.group.children.filter((c) => c.geometry?.type === "SphereGeometry").length;
    const halos = () => scene.group.children.filter((c) => c.geometry?.type === "RingGeometry").length;
    expect(dots()).toBe(3);
    scene.setAimGizmo({ limb: "arm", at: "tip" });
    expect(dots()).toBe(2); // the joints; the tip is the gizmo's ball
    expect(halos()).toBe(0);
    scene.setAimGizmo({ limb: "arm", at: "elbow" });
    expect(dots()).toBe(2); // the shoulder and the tip
    scene.setAimGizmo({ limb: "other", at: "tip" });
    expect(dots()).toBe(3);
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

  // A generic handle's pseudo-limb (handle-source.js's handleRecord): one dot, its source's lines.
  const HANDLE = {
    kind: "partforge.handle", name: "handle:corner", handleId: "corner", joints: [],
    points: { tip: [5, 5, 0] }, tip: "tip", values: [], axes: {}, drag: "plane", axis: null,
    lines: [[[0, 0, 0], [5, 5, 0]], [[5, 5, 0], [9, 0, 0]]],
  };

  it("a generic handle shows one dot and its source's lines as bones", () => {
    const viewer = fakeViewer();
    const scene = createPoseScene(viewer, { paintLabel: fakePaint });
    scene.setLimbs([INFO, HANDLE]);
    scene.setHover("handle:corner", "tip");
    const spheres = scene.group.children.filter((c) => c.geometry?.type === "SphereGeometry");
    expect(spheres.map((m) => m.position.toArray())).toEqual([[5, 5, 0]]);
    const lines = scene.group.children.filter((c) => c.isLineSegments2);
    expect(lines).toHaveLength(1);
    expect(lines[0].geometry.attributes.instanceStart.count).toBe(2); // the two source lines
    scene.setPins([{ limb: "handle:corner", at: "tip" }]);
    scene.setHover(null);
    expect(scene.pinBadges()).toEqual([{ limb: "handle:corner", at: "tip", point: [5, 5, 0] }]);
    scene.dispose();
  });

  it("guides and the readout draw in their own group, apart from the limbs, and clear", () => {
    const viewer = fakeViewer();
    const scene = createPoseScene(viewer, { paintLabel: fakePaint });
    scene.setLimbs([HANDLE]);
    scene.setGuides([
      { kind: "plane", points: [[1, 1, 0], [-1, 1, 0], [-1, -1, 0], [1, -1, 0]] },
      { kind: "path", points: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] },
      { kind: "axis", points: [[0, 0, 0], [NaN, 0, 0]] }, // unreadable: dropped
    ]);
    expect(scene.group.children.length).toBe(0); // the limbs' group is untouched
    expect(scene.guideGroup.parent).toBe(viewer.__parts);
    expect(viewer.registerCanonicalCaptureHidden).toHaveBeenCalledWith(scene.guideGroup);
    const segs = scene.guideGroup.children.map((c) => c.geometry.attributes.instanceStart.count);
    expect(segs).toEqual([4, 2]); // the square closes; the path does not
    scene.setReadout({ at: [5, 5, 0], text: "width 84.0 · depth 60.5" });
    expect(scene.guideState().readout).toEqual({ at: [5, 5, 0], text: "width 84.0 · depth 60.5" });
    const label = scene.guideGroup.children.find((c) => c.geometry?.type === "PlaneGeometry");
    expect(label.material.map.image.width).toBe(40 * "width 84.0 · depth 60.5".length);
    scene.tick();
    expect(label.position.y).toBeGreaterThan(5); // lifted above the point, on screen
    viewer.requestRender.mockClear();
    scene.setReadout(null);
    scene.setGuides([]);
    expect(scene.guideGroup.children.length).toBe(0);
    expect(viewer.requestRender).toHaveBeenCalled();
    viewer.requestRender.mockClear();
    scene.setGuides([]); // nothing shown, nothing to do
    expect(viewer.requestRender).not.toHaveBeenCalled();
    scene.setGuides([{ kind: "rotary", points: [[1, 0, 0], [0, 1, 0], [-1, 0, 0]] }]);
    scene.clear();
    expect(scene.guideGroup.children.length).toBe(0);
    scene.dispose();
    expect(scene.guideGroup.parent).toBeNull();
  });
});

describe("the resting cue (setCue)", () => {
  const spheres = (g) => g.children.filter((c) => c.geometry?.type === "SphereGeometry");
  it("draws a dimmed dot at each point, in the capture-hidden group, and fades by opacity alone", () => {
    const viewer = fakeViewer();
    const scene = createPoseScene(viewer, { paintLabel: fakePaint });
    scene.setLimbs([INFO]);
    scene.setCue({ points: [[1, 2, 3], [4, 5, 6]], opacity: 0.4 });
    const dots = spheres(scene.group);
    expect(dots.map((m) => m.position.toArray())).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(viewer.registerCanonicalCaptureHidden).toHaveBeenCalledWith(scene.group); // never in a capture
    expect(dots[0].material.opacity).toBeCloseTo(0.4, 6);
    // a hover rebuild keeps the cue
    scene.setHover("arm");
    expect(spheres(scene.group).length).toBe(2 + 3);
    scene.setHover(null);
    viewer.requestRender.mockClear();
    const before = spheres(scene.group)[0];
    scene.setCueOpacity(0.1);
    expect(spheres(scene.group)[0]).toBe(before); // no rebuild
    expect(spheres(scene.group)[0].material.opacity).toBeCloseTo(0.1, 6);
    expect(viewer.requestRender).toHaveBeenCalled();
    scene.setCue(null);
    expect(spheres(scene.group)).toHaveLength(0);
    scene.setCue({ points: [[0, 0, 0]], opacity: 0.4 });
    scene.clear();
    expect(scene.group.children).toHaveLength(0);
    scene.dispose();
  });
});
