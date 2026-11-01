// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import {
  createDimScene, DIM_THEME, RENDER_ORDER_DIMS, RENDER_ORDER_LABELS,
  worldPerPx, orthoWorldPerPx, labelWorldHeight, LABEL_SCREEN_PX, ARROW_SCREEN_PX,
  OVERSHOOT_SCREEN_PX, GAP_SCREEN_PX, STANDOFF_SCREEN_PX, STAGGER_SCREEN_PX,
} from "../../../src/framework/measure/dim3-scene.js";

function fakeViewer() {
  const parts = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BufferGeometry());
  parts.add(mesh);
  const scene = new THREE.Scene();
  scene.add(parts);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 100);
  camera.updateMatrixWorld();
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientWidth", { value: 800 });
  Object.defineProperty(canvas, "clientHeight", { value: 600 });
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
  return {
    _subMeshes: { body: mesh },
    camera,
    domElement: canvas,
    getTheme: () => "dark",
    registerCanonicalCaptureHidden: vi.fn(() => vi.fn()),
    __parts: parts,
  };
}

// fake painter: never touches a 2d context
const fakePaint = ({ text }) => {
  const c = document.createElement("canvas");
  c.width = 40 * text.length;
  c.height = 128;
  return c;
};

// One parametric linear dim: measures X (0..10) on a part edge at y = 2,
// extending -Y to its dim line.
const DRAWING = {
  itemId: "overall", tier: "static", pinned: false,
  dims: [{
    pA: [0, 2, 0], pB: [10, 2, 0],
    baseA: [0, 0, 0], baseB: [10, 0, 0],
    ext: [0, -1, 0], dir: [1, 0, 0], lane: 0, standoffScale: 1,
    label: { text: "10.00 mm", value: 10, x: [1, 0, 0], y: [0, 1, 0] },
  }],
  diams: [], leaders: [],
};

const wppOf = (viewer) => worldPerPx(viewer.camera.position.length(), viewer.camera.fov, 600);

describe("createDimScene", () => {
  it("parents a group under the parts group and registers capture hiding", () => {
    const viewer = fakeViewer();
    const scene = createDimScene(viewer, { paintLabel: fakePaint });
    scene.update([DRAWING]);
    expect(viewer.__parts.children).toContain(scene.group);
    expect(viewer.registerCanonicalCaptureHidden).toHaveBeenCalledWith(scene.group);
  });

  it("builds line, arrows and label with the right render flags", () => {
    const viewer = fakeViewer();
    const scene = createDimScene(viewer, { paintLabel: fakePaint });
    scene.update([DRAWING]);
    const kids = scene.group.children;
    expect(kids.length).toBe(4); // 1 line (ext+dim+tails) + 2 arrows + 1 label
    for (const k of kids) {
      expect(k.material.depthTest).toBe(false);
      expect(k.renderOrder === RENDER_ORDER_DIMS || k.renderOrder === RENDER_ORDER_LABELS).toBe(true);
    }
    const label = kids.find((k) => k.userData.pfDimItemId);
    expect(label.userData.pfDimItemId).toBe("overall");
  });

  it("a ⌀ label starts past the arrow at its end of the line", () => {
    const viewer = fakeViewer();
    const scene = createDimScene(viewer, { paintLabel: fakePaint });
    scene.update([{
      itemId: "first", tier: "pinned", pinned: true, dims: [], leaders: [],
      diams: [{
        rimA: [4, 0, 0], rimB: [-4, 0, 0], du: [1, 0, 0], dv: [0, 1, 0],
        label: { text: "⌀8.00 mm", value: 8, x: [1, 0, 0], y: [0, -1, 0] },
      }],
    }]);
    viewer.__parts.updateMatrixWorld(true);
    scene.tick();
    const wpp = wppOf(viewer);
    const label = scene.group.children.find((k) => k.userData.pfDimItemId);
    const halfWidth = (label.geometry.parameters.width * label.scale.x) / 2;
    // the label's near edge clears rimA's arrowhead (tip on the rim, body outward)
    expect(label.position.x - halfWidth).toBeGreaterThan(4 + ARROW_SCREEN_PX * wpp);
    expect(label.position.y).toBeCloseTo(0, 6); // on the line's own axis
  });

  it("arrowheads are 0.6 × their length wide", () => {
    const viewer = fakeViewer();
    const scene = createDimScene(viewer, { paintLabel: fakePaint });
    scene.update([DRAWING]);
    const arrow = scene.group.children.find((k) => !k.isLineSegments2 && !k.userData.pfDimItemId);
    const ys = Array.from(arrow.geometry.attributes.position.array).filter((_, i) => i % 3 === 1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(0.6, 6);
  });

  it("update replaces previous drawings; clear empties", () => {
    const viewer = fakeViewer();
    const scene = createDimScene(viewer, { paintLabel: fakePaint });
    scene.update([DRAWING]);
    scene.update([DRAWING]);
    expect(scene.group.children.length).toBe(4);
    scene.clear();
    expect(scene.group.children.length).toBe(0);
  });

  it("tick assembles the dim from screen-constant distances", () => {
    const viewer = fakeViewer();
    const scene = createDimScene(viewer, { paintLabel: fakePaint });
    scene.update([DRAWING]);
    viewer.__parts.updateMatrixWorld(true);
    scene.tick();
    const wpp = wppOf(viewer);
    const off = STANDOFF_SCREEN_PX * wpp;
    const gap = GAP_SCREEN_PX * wpp;
    const tail = OVERSHOOT_SCREEN_PX * wpp;
    const hStar = LABEL_SCREEN_PX * wpp;

    const line = scene.group.children.find((k) => k.isLineSegments2);
    const arr = line.geometry.attributes.instanceStart.data.array;
    // extension A runs from pA + û·gap to dA = baseA + ext·off (û = -Y here)
    expect(arr[0]).toBeCloseTo(0, 6);
    expect(arr[1]).toBeCloseTo(2 - gap, 6);
    expect(arr[4]).toBeCloseTo(-off, 6);
    // dim line spans dA..dB at the standoff
    expect(arr[13]).toBeCloseTo(-off, 6);
    expect(arr[16]).toBeCloseTo(-off, 6);
    // tail A overshoots past the dim line along û (segment 3: floats 18-23)
    expect(arr[22]).toBeCloseTo(-off - tail, 6);

    const arrows = scene.group.children.filter((k) => !k.isLineSegments2 && !k.userData.pfDimItemId);
    expect(arrows.length).toBe(2);
    for (const a of arrows) expect(a.scale.x).toBeCloseTo(ARROW_SCREEN_PX * wpp, 6);
    expect(arrows[0].position.y).toBeCloseTo(-off, 6); // riding the dim line

    const label = scene.group.children.find((k) => k.userData.pfDimItemId);
    expect(label.scale.x).toBeCloseTo(hStar, 6); // unit-height plane → scale IS the height
    expect(label.position.x).toBeCloseTo(5, 6);
    expect(label.position.y).toBeCloseTo(-off - 0.85 * hStar, 6);

    // zoom to half the distance: every display size halves in world units
    viewer.camera.position.set(0, 0, viewer.camera.position.length() / 2);
    viewer.camera.updateMatrixWorld();
    scene.tick();
    expect(line.geometry.attributes.instanceStart.data.array[4]).toBeCloseTo(-off / 2, 6);
    expect(label.scale.x).toBeCloseTo(hStar / 2, 6);
  });

  it("extension lines are drawn along ext", () => {
    const viewer = fakeViewer();
    const scene = createDimScene(viewer, { paintLabel: fakePaint });
    // pA − baseA is NOT along ext: an old or hand-built skewed record
    const skewed = {
      ...DRAWING,
      dims: [{ ...DRAWING.dims[0], pA: [0.3, 2, 0], pB: [9.6, 2, 0.4] }],
    };
    scene.update([skewed]);
    viewer.__parts.updateMatrixWorld(true);
    scene.tick();
    const arr = scene.group.children.find((k) => k.isLineSegments2)
      .geometry.attributes.instanceStart.data.array;
    const ext = [0, -1, 0];
    // segments 0 (ext A), 1 (ext B), 3 (tail A), 4 (tail B)
    for (const s of [0, 1, 3, 4]) {
      const o = s * 6;
      const d = [arr[o + 3] - arr[o], arr[o + 4] - arr[o + 1], arr[o + 5] - arr[o + 2]];
      const l = Math.hypot(...d);
      expect(l).toBeGreaterThan(0);
      for (let i = 0; i < 3; i++) expect(Math.abs(d[i] / l - ext[i])).toBeLessThan(1e-6);
    }
  });

  it("staggers lanes by STAGGER_SCREEN_PX and scales feature standoff", () => {
    const viewer = fakeViewer();
    const scene = createDimScene(viewer, { paintLabel: fakePaint });
    const lane1 = {
      ...DRAWING, itemId: "pin:x", tier: "pinned",
      dims: [{ ...DRAWING.dims[0], lane: 1, standoffScale: 0.55,
        label: { text: "5.00 mm", value: 5, x: [1, 0, 0], y: [0, 1, 0] } }],
    };
    scene.update([DRAWING, lane1]);
    viewer.__parts.updateMatrixWorld(true);
    scene.tick();
    const wpp = wppOf(viewer);
    const lines = scene.group.children.filter((k) => k.isLineSegments2);
    const y0 = lines[0].geometry.attributes.instanceStart.data.array[4];
    const y1 = lines[1].geometry.attributes.instanceStart.data.array[4];
    expect(y0).toBeCloseTo(-STANDOFF_SCREEN_PX * wpp, 6);
    expect(y1).toBeCloseTo(-(STANDOFF_SCREEN_PX * 0.55 + STAGGER_SCREEN_PX) * wpp, 6);
  });

  it("sizes every label to one shared screen-constant height", () => {
    const viewer = fakeViewer();
    const scene = createDimScene(viewer, { paintLabel: fakePaint });
    const second = {
      ...DRAWING, itemId: "pin:x", tier: "pinned",
      dims: [{ ...DRAWING.dims[0], label: { text: "5.00 mm", value: 5, x: [1, 0, 0], y: [0, 1, 0] } }],
    };
    scene.update([DRAWING, second]);
    viewer.__parts.updateMatrixWorld(true);
    scene.tick();
    const [a, b] = scene.group.children.filter((k) => k.userData.pfDimItemId);
    const hStar = labelWorldHeight(viewer.camera.position.length(), viewer.camera.fov, 600);
    expect(a.scale.x).toBeCloseTo(hStar, 6);
    expect(b.scale.x).toBeCloseTo(hStar, 6);
  });

  it("tick mirrors a label viewed from behind (and holds within the deadband)", () => {
    const viewer = fakeViewer();
    const scene = createDimScene(viewer, { paintLabel: fakePaint });
    scene.update([DRAWING]);
    viewer.__parts.updateMatrixWorld(true);
    scene.tick(); // facing camera (+Z toward camera at z=100): no flip
    const label = scene.group.children.find((k) => k.userData.pfDimItemId);
    const q0 = label.quaternion.clone();
    viewer.camera.position.set(0, 0, -100);
    viewer.camera.updateMatrixWorld();
    scene.tick(); // viewed from behind: mirrored
    expect(label.quaternion.equals(q0)).toBe(false);
  });

  it("pickLabel finds the label under the pointer, null elsewhere", () => {
    const viewer = fakeViewer();
    const scene = createDimScene(viewer, { paintLabel: fakePaint });
    scene.update([DRAWING]);
    viewer.__parts.updateMatrixWorld(true);
    scene.tick(); // positions the label
    const label = scene.group.children.find((k) => k.userData.pfDimItemId);
    viewer.camera.lookAt(label.position);
    viewer.camera.updateMatrixWorld();
    // center of the viewport now aims at the label center; the pick carries
    // the measured value for exact-match control focusing
    expect(scene.pickLabel(400, 300)).toEqual({ itemId: "overall", value: 10 });
    expect(scene.pickLabel(5, 5)).toBe(null);
  });

  it("setTheme recolors materials and repaints labels", () => {
    const viewer = fakeViewer();
    const paint = vi.fn(fakePaint);
    const scene = createDimScene(viewer, { paintLabel: paint });
    scene.update([DRAWING]);
    const before = paint.mock.calls.length;
    scene.setTheme("light");
    expect(paint.mock.calls.length).toBeGreaterThan(before);
    const line = scene.group.children.find((k) => k.isLineSegments2);
    expect(line.material.color.getHex()).toBe(DIM_THEME.light.static);
  });

  it("dispose detaches, unregisters and disposes", () => {
    const viewer = fakeViewer();
    const unregister = vi.fn();
    viewer.registerCanonicalCaptureHidden = vi.fn(() => unregister);
    const scene = createDimScene(viewer, { paintLabel: fakePaint });
    scene.update([DRAWING]);
    scene.dispose();
    expect(viewer.__parts.children).not.toContain(scene.group);
    expect(unregister).toHaveBeenCalled();
  });

  it("bounds the label texture cache to live labels (mark-and-sweep on update)", () => {
    const viewer = fakeViewer();
    const paint = vi.fn(fakePaint);
    const scene = createDimScene(viewer, { paintLabel: paint });

    const mkDrawing = (itemId, texts) => ({
      itemId, tier: "static", pinned: false,
      dims: texts.map((text, i) => ({
        pA: [i, 2, 0], pB: [i + 1, 2, 0],
        baseA: [i, 0, 0], baseB: [i + 1, 0, 0],
        ext: [0, -1, 0], dir: [1, 0, 0], lane: 0, standoffScale: 1,
        label: { text, value: 1, x: [1, 0, 0], y: [0, 1, 0] },
      })),
      diams: [], leaders: [],
    });

    // Update 1: "A" and "C" (twice). A repeated text within one update should
    // hit the cache after the first paint, not repaint.
    scene.update([mkDrawing("item1", ["A", "C", "C"])]);
    expect(paint.mock.calls.length).toBe(2); // one paint for "A", one for "C"

    // Update 2: only "B" is live now. "A" and "C" are no longer referenced by
    // any label, so the sweep at the end of update() should drop them.
    scene.update([mkDrawing("item2", ["B"])]);
    expect(paint.mock.calls.length).toBe(3); // +1 for "B"; no repaint of A/C

    // Update 3: "A" again. Since it was swept out in update 2, this must be a
    // fresh cache miss (a repaint), proving growth is bounded rather than the
    // old "A" texture having lingered unbounded in the cache.
    scene.update([mkDrawing("item3", ["A"])]);
    expect(paint.mock.calls.length).toBe(4); // +1 for "A" repainted from scratch

    // The label currently on screen still renders correctly post-sweep.
    const label = scene.group.children.find((k) => k.userData.pfDimItemId === "item3");
    expect(label.material.map).toBeTruthy();
  });
});

describe("worldPerPx under an orthographic camera", () => {
  it("derives scale from the frustum, not from a fov that does not exist", () => {
    // A 40-unit-tall frustum across a 400px viewport is 0.1 world units per px,
    // at any distance — the property perspective's fov formula cannot express.
    expect(orthoWorldPerPx(20, -20, 1, 400)).toBeCloseTo(0.1, 12);
  });

  it("scales inversely with the ortho zoom", () => {
    expect(orthoWorldPerPx(20, -20, 2, 400)).toBeCloseTo(0.05, 12);
    expect(orthoWorldPerPx(20, -20, 0.5, 400)).toBeCloseTo(0.2, 12);
  });

  it("does not divide by zero on a degenerate zoom", () => {
    expect(Number.isFinite(orthoWorldPerPx(20, -20, 0, 400))).toBe(true);
  });

  it("gives a scale the fov fallback could never produce", () => {
    // The bug: under an ortho camera `fov` is undefined, so `worldPerPx(dist,
    // fov ?? 45, h)` returned a plausible-but-wrong number that also drifted as
    // the user dollied. These are the two answers for the same frustum and
    // viewport — they are not close, and only one of them is stable.
    const truth = orthoWorldPerPx(20, -20, 1, 400); // 40 tall / 400px = 0.1
    expect(truth).toBeCloseTo(0.1, 12);
    for (const dist of [50, 100, 400]) {
      expect(worldPerPx(dist, 45, 400)).not.toBeCloseTo(truth, 3);
    }
  });
});
