// @vitest-environment happy-dom
// Orchestrator against a minimal real-three fake viewer: enable -> always-on
// dims; hover -> feature dims; click -> pin + param reveal; regen re-anchor.
// Dimensions are in-scene objects now, so the observation surface is the
// "pf-dims" group under the meshes' shared parent (each label mesh carries its
// item id in userData.pfDimItemId) rather than an SVG overlay.
import { expect, test, vi, beforeEach } from "vitest";
import * as THREE from "three";
import { createMeasureMode } from "../../../src/framework/measure/measure-mode.js";
import { raycastViewer } from "../../../src/framework/selection/raycast.js";
import { placeDims } from "../../../src/framework/measure/dim3-place.js";
import { classifyFeature } from "../../../src/framework/measure/feature-dims.js";

// Pass-through spy on the placement entry point: behaviour is untouched, but
// "which items were re-placed, and when" becomes observable — the base/hover
// split is otherwise invisible from the scene (identical drawings either way).
vi.mock("../../../src/framework/measure/dim3-place.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, placeDims: vi.fn(actual.placeDims) };
});

// dim3-scene's default label painter needs a real 2d context; happy-dom has
// none. Stub the minimum it touches and record every painted string, which is
// how the param-link assertions read label content.
const paintLog = [];
HTMLCanvasElement.prototype.getContext = function getContext() {
  return {
    font: "", fillStyle: "", strokeStyle: "", lineWidth: 0,
    lineJoin: "", textAlign: "", textBaseline: "",
    measureText: (t) => ({ width: 8 * String(t).length }),
    fillText: (t) => { paintLog.push(String(t)); },
    strokeText: (t) => { paintLog.push(String(t)); },
    beginPath() {}, roundRect() {}, fill() {}, stroke() {},
  };
};
beforeEach(() => { paintLog.length = 0; });

// A 20×10 plate: one sub-part, one labeled planar feature covering both
// triangles of its top face at z=2. Non-indexed, feature ids per triangle.
// `halfLabeled` leaves the upper-left triangle unlabeled (see the label-pick
// test, which needs a spot where a raycast resolves to something OTHER than
// the pinned feature).
function plateMesh({ halfLabeled = false } = {}) {
  const positions = new Float32Array([
    0, 0, 2, 20, 0, 2, 20, 10, 2,
    0, 0, 2, 20, 10, 2, 0, 10, 2,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.userData.featureIds = new Uint16Array([1, halfLabeled ? 0 : 1]);
  geo.userData.features = ["top face"];
  return new THREE.Mesh(geo);
}

// `parts` is the meshes' shared parent group — the frame every dimension is
// placed in, and the node the dim group parents itself under.
function fakeViewer(mesh, parts = new THREE.Group()) {
  const dom = document.createElement("div");
  const stage = document.createElement("div");
  stage.appendChild(dom);
  dom.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(10, 5, 40); // over the plate center, looking down -Z
  camera.lookAt(10, 5, 2);
  camera.updateMatrixWorld(true);
  mesh.name = "plate";
  if (mesh.parent !== parts) parts.add(mesh);
  parts.updateMatrixWorld(true);
  const frameCbs = new Set();
  const handleHoverCbs = new Set();
  const themeCbs = new Set();
  return {
    domElement: dom,
    stageElement: stage,
    camera,
    _subMeshes: { plate: mesh },
    __parts: parts,
    onFrame: (cb) => { frameCbs.add(cb); return () => frameCbs.delete(cb); },
    registerCutawayMaterial: () => () => {},
    registerCanonicalCaptureHidden: () => () => {},
    getTheme: () => "dark",
    onThemeChange: (cb) => { themeCbs.add(cb); return () => themeCbs.delete(cb); },
    fireTheme: (m) => { for (const cb of [...themeCbs]) cb(m); },
    frame: () => { for (const cb of [...frameCbs]) cb(16); },
    onCutawayHandleHover: (cb) => { handleHoverCbs.add(cb); return () => handleHoverCbs.delete(cb); },
    fireHandleHover: (handle) => { for (const cb of [...handleHoverCbs]) cb(handle); },
  };
}

// Two views over the SAME sub-part: switching between them changes nothing
// about the meshes, only which pins apply.
const part = {
  parts: { plate: { label: "Plate", build: () => {} } },
  views: { main: { parts: ["plate"] }, alt: { parts: ["plate"] } },
};
const pointerOpts = { bubbles: true, clientX: 50, clientY: 50, pointerId: 1 };

function setup({ parts, mesh = plateMesh() } = {}) {
  const viewer = fakeViewer(mesh, parts);
  const revealParams = vi.fn();
  const ctx = { view: "main", params: { plate_w: 20, wall: 3 } };
  const mode = createMeasureMode(viewer, {
    part,
    getContext: () => ctx,
    revealParams,
    schedule: (cb) => cb(), // synchronous for tests
  });
  // the dim group under the meshes' shared parent
  const dimGroup = () => viewer.__parts.children.find((c) => c.name === "pf-dims");
  // one entry per rendered dimension label, tagged with the item it belongs to
  const itemIds = () => (dimGroup()?.children ?? [])
    .filter((c) => c.userData.pfDimItemId)
    .map((c) => c.userData.pfDimItemId);
  const hasHover = () => itemIds().includes("hover");
  // world positions of one item's dim labels, for "did the placement move?"
  const labelPositions = (prefix) => {
    viewer.__parts.updateMatrixWorld(true);
    return (dimGroup()?.children ?? [])
      .filter((c) => c.userData.pfDimItemId?.startsWith(prefix))
      .map((c) => c.getWorldPosition(new THREE.Vector3()).toArray());
  };
  return { mesh, viewer, mode, ctx, revealParams, dimGroup, itemIds, hasHover, labelPositions };
}

// Mirror viewer.setSubPose: a rigid pose written straight onto mesh.matrix.
const poseSubMesh = (mesh, matrix) => {
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(matrix);
  mesh.matrixWorldNeedsUpdate = true;
};

const clickAt = (dom, x = 50, y = 50) => {
  const opts = { ...pointerOpts, clientX: x, clientY: y };
  dom.dispatchEvent(new PointerEvent("pointerdown", opts));
  dom.dispatchEvent(new PointerEvent("pointerup", opts));
  dom.dispatchEvent(new MouseEvent("click", opts));
};

test("enable renders always-on overall dims; disable clears but keeps state", () => {
  const { mode, dimGroup, itemIds } = setup();
  mode.setEnabled(true);
  expect(dimGroup()).toBeDefined();
  expect(itemIds()).toContain("overall");
  // the plate is flat, so only its W and D extents are dimensioned
  expect(itemIds().filter((id) => id === "overall").length).toBe(2);
  expect(paintLog).toContain("20.00 mm"); // plate W
  expect(paintLog).toContain("10.00 mm"); // plate D
  expect(mode.isEnabled()).toBe(true);

  mode.setEnabled(false);
  expect(mode.isEnabled()).toBe(false);
  expect(dimGroup().children.length).toBe(0); // cleared, group kept for re-enable
  mode.setEnabled(true);
  expect(itemIds()).toContain("overall"); // state survives the toggle
  mode.detach();
});

test("setUnits re-renders labels in inches; values stay mm", () => {
  const { mode, dimGroup } = setup();
  mode.setEnabled(true);
  expect(mode.getUnits()).toBe("mm");
  expect(paintLog).toContain("20.00 mm");

  paintLog.length = 0;
  mode.setUnits("in");
  expect(mode.getUnits()).toBe("in");
  expect(paintLog).toContain("0.787 in"); // 20 mm
  expect(paintLog).not.toContain("20.00 mm");
  // the label still carries its mm value for control matching
  const w = dimGroup().children.find((c) => c.userData.pfDimValue === 20);
  expect(w).toBeDefined();

  mode.setUnits("furlongs"); // unknown unit: ignored
  expect(mode.getUnits()).toBe("in");
  mode.detach();
});

test("the dim group is parented under the meshes' shared group", () => {
  // v2's answer to "dims follow the pivot rotation / per-view recentring":
  // they are children of the same node the meshes hang off, so the parent
  // transform applies to them for free.
  const parts = new THREE.Group();
  parts.position.set(5, 0, 0);
  const { viewer, mode, dimGroup } = setup({ parts });
  mode.setEnabled(true);
  expect(dimGroup()).toBeDefined();
  expect(dimGroup().parent).toBe(viewer.__parts);
  expect(viewer._subMeshes.plate.parent).toBe(viewer.__parts);
  mode.detach();
});

test("hover shows the feature's dims as plain value labels", () => {
  const { viewer, mode, hasHover } = setup();
  mode.setEnabled(true);
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", pointerOpts));
  expect(hasHover()).toBe(true);
  expect(paintLog).toContain("20.00 mm"); // the plane feature's width
  expect(paintLog).not.toContain("plate_w"); // no param pill on labels anymore
  mode.detach();
});

// Regression: stagger lanes are assigned per placeDims call, and hover is
// placed in a separate call from the cached base — without seeding the hover
// pass with the base pass's lane counts, a hovered dim started at lane 0 and
// JUMPED outward on click when its pin joined the base pass. A hovered dim
// must land exactly where its pin will.
test("a hovered dim takes the lane it will keep when pinned (no jump on click)", () => {
  const { viewer, mode, labelPositions } = setup();
  mode.setEnabled(true);
  viewer.frame(); // settle screen-constant sizing
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", pointerOpts));
  viewer.frame(); // position the hover labels
  const hover = labelPositions("hover");
  expect(hover.length).toBeGreaterThan(0);

  clickAt(viewer.domElement); // pin the same feature (hover then dedupes away)
  viewer.frame();
  const pinned = labelPositions("pin:");
  expect(pinned.length).toBe(hover.length);
  pinned.forEach((p, i) => {
    expect(p[0]).toBeCloseTo(hover[i][0], 5);
    expect(p[1]).toBeCloseTo(hover[i][1], 5);
    expect(p[2]).toBeCloseTo(hover[i][2], 5);
  });
  mode.detach();
});

test("click pins; pin survives a geometry swap; clearPins notifies", () => {
  const { viewer, mode, itemIds } = setup();
  const onPins = vi.fn();
  mode.onPinsChange(onPins);
  mode.setEnabled(true);
  clickAt(viewer.domElement);
  expect(mode.pinCount()).toBe(1);
  expect(onPins).toHaveBeenCalled();
  expect(itemIds().some((id) => id.startsWith("pin:"))).toBe(true);

  // simulate a regenerate: same labels, new geometry instance
  const fresh = plateMesh();
  viewer._subMeshes.plate.geometry = fresh.geometry;
  viewer.frame(); // dirty check picks up the new geometry
  expect(mode.pinCount()).toBe(1);
  // pinned dim re-anchored against the new geometry and re-rendered
  expect(itemIds().some((id) => id.startsWith("pin:"))).toBe(true);

  mode.clearPins();
  expect(mode.pinCount()).toBe(0);
  expect(itemIds().some((id) => id.startsWith("pin:"))).toBe(false);
  mode.detach();
});

test("a pin whose feature label disappears goes dormant without being dropped", () => {
  const { viewer, mode, itemIds } = setup();
  mode.setEnabled(true);
  clickAt(viewer.domElement);
  expect(mode.pinCount()).toBe(1);

  // regenerate into geometry that no longer carries the pinned label
  const bare = plateMesh();
  bare.geometry.userData.features = [];
  bare.geometry.userData.featureIds = new Uint16Array([0, 0]);
  viewer._subMeshes.plate.geometry = bare.geometry;
  viewer.frame();
  expect(mode.pinCount()).toBe(1); // still pinned, just unresolvable
  expect(itemIds().some((id) => id.startsWith("pin:"))).toBe(false);
  mode.detach();
});

test("a geometry click pins quietly (no value, no flash)", () => {
  const { viewer, mode, revealParams } = setup();
  mode.setEnabled(true);
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", pointerOpts));
  clickAt(viewer.domElement);
  expect(mode.pinCount()).toBe(1);
  expect(revealParams).not.toHaveBeenCalled();
  mode.detach();
});

test("drag does not pin", () => {
  const { viewer, mode } = setup();
  mode.setEnabled(true);
  viewer.domElement.dispatchEvent(new PointerEvent("pointerdown", pointerOpts));
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", { ...pointerOpts, clientX: 80 }));
  viewer.domElement.dispatchEvent(new PointerEvent("pointerup", { ...pointerOpts, clientX: 80 }));
  viewer.domElement.dispatchEvent(new MouseEvent("click", { ...pointerOpts, clientX: 80 }));
  expect(mode.pinCount()).toBe(0);
  mode.detach();
});

// Screen coordinates of a pinned/hover label that floats over geometry with no
// feature (or none at all) — the spot where only the label-pick path can
// resolve the click; a raycast fallthrough would pin the sub-part bbox.
function offFeatureLabelTarget(viewer, dimGroup, prefix) {
  viewer.frame(); // labels are positioned by scene.tick(), not at build time
  viewer.__parts.updateMatrixWorld(true);
  const screenOf = (o) => {
    const p = o.getWorldPosition(new THREE.Vector3()).project(viewer.camera);
    return { x: ((p.x + 1) / 2) * 100, y: ((1 - p.y) / 2) * 100 };
  };
  return dimGroup().children
    .filter((c) => c.userData.pfDimItemId?.startsWith(prefix))
    .map(screenOf)
    .find(({ x, y }) => raycastViewer(viewer, x, y)?.feature == null);
}

// Regression (carried over from the chip-click case): a pinned dimension's
// label resolves by the structured item id carried on the label mesh — never
// by parsing the rendered dim text (which can itself contain colons when a
// Solid.label() does) and never by falling through to the geometry raycast.
// Every label is a button to the controls driving its measurement: reveal,
// keep the pin. Unpinning stays on geometry re-click / Clear.
test("clicking a pinned dim's label keeps the pin; only value matches flash", () => {
  // Half-labeled plate: the pinned feature covers only one triangle, so one of
  // its dim labels lands over UNLABELED geometry. A click there that fell
  // through to the raycast would pin the sub-part bbox (pinCount 2) — which is
  // what makes this test see the label-pick path.
  const { viewer, mode, dimGroup, revealParams } = setup({ mesh: plateMesh({ halfLabeled: true }) });
  mode.setEnabled(true);
  clickAt(viewer.domElement, 64.1, 55.6); // inside the labeled triangle
  expect(mode.pinCount()).toBe(1);
  revealParams.mockClear();

  const target = offFeatureLabelTarget(viewer, dimGroup, "pin:");
  expect(target).toBeDefined();
  clickAt(viewer.domElement, target.x, target.y);

  // whichever label was clicked, the pin holds and any flash is value-matched:
  // no control ever lights up for a value it doesn't hold
  for (const [keys] of revealParams.mock.calls) {
    for (const k of keys) expect(["plate_w"]).toContain(k); // wall=3 matches nothing here
  }
  expect(mode.pinCount()).toBe(1); // still pinned — no toggle, no bbox fallthrough
  mode.detach();
});

test("a label click whose value matches a param focuses that control", () => {
  const { viewer, mode, dimGroup, revealParams } = setup({ mesh: plateMesh({ halfLabeled: true }) });
  mode.setEnabled(true);
  clickAt(viewer.domElement, 64.1, 55.6);
  expect(mode.pinCount()).toBe(1);
  revealParams.mockClear();

  // click the pinned label whose value is 20.00 — plate_w is 20, unique match
  viewer.frame();
  viewer.__parts.updateMatrixWorld(true);
  const labels = dimGroup().children.filter((c) => c.userData.pfDimItemId?.startsWith("pin:"));
  const wLabel = labels.find((c) => c.userData.pfDimValue === 20);
  expect(wLabel).toBeDefined();
  const proj = wLabel.getWorldPosition(new THREE.Vector3()).project(viewer.camera);
  clickAt(viewer.domElement, ((proj.x + 1) / 2) * 100, ((1 - proj.y) / 2) * 100);

  const [keys, focus] = revealParams.mock.calls.at(-1);
  expect(keys).toEqual(["plate_w"]); // ONLY the matching control — nothing else flashes
  expect(focus).toBe("plate_w");
  expect(mode.pinCount()).toBe(1);
  mode.detach();
});

test("a label click with no matching value flashes nothing", () => {
  const { viewer, mode, dimGroup, revealParams } = setup({ mesh: plateMesh({ halfLabeled: true }) });
  mode.setEnabled(true);
  clickAt(viewer.domElement, 64.1, 55.6);
  revealParams.mockClear();

  viewer.frame();
  viewer.__parts.updateMatrixWorld(true);
  // the D label (10.00): params are plate_w=20 / wall=3 — no match
  const dLabel = dimGroup().children.find((c) => c.userData.pfDimValue === 10);
  expect(dLabel).toBeDefined();
  const proj = dLabel.getWorldPosition(new THREE.Vector3()).project(viewer.camera);
  clickAt(viewer.domElement, ((proj.x + 1) / 2) * 100, ((1 - proj.y) / 2) * 100);

  expect(revealParams).not.toHaveBeenCalled();
  mode.detach();
});

test("several matching params all flash, none takes focus", () => {
  const { viewer, mode, dimGroup, ctx, revealParams } = setup({ mesh: plateMesh({ halfLabeled: true }) });
  ctx.params.wall = 20; // now BOTH plate_w and wall hold the clicked value
  mode.setEnabled(true);
  clickAt(viewer.domElement, 64.1, 55.6);
  revealParams.mockClear();

  viewer.frame();
  viewer.__parts.updateMatrixWorld(true);
  const wLabel = dimGroup().children
    .filter((c) => c.userData.pfDimItemId?.startsWith("pin:"))
    .find((c) => c.userData.pfDimValue === 20);
  const proj = wLabel.getWorldPosition(new THREE.Vector3()).project(viewer.camera);
  clickAt(viewer.domElement, ((proj.x + 1) / 2) * 100, ((1 - proj.y) / 2) * 100);

  const [keys, focus] = revealParams.mock.calls.at(-1);
  expect(keys.sort()).toEqual(["plate_w", "wall"]);
  expect(focus).toBe(null);
  mode.detach();
});

test("re-clicking pinned geometry unpins it (labels never unpin)", () => {
  const { viewer, mode } = setup();
  mode.setEnabled(true);
  clickAt(viewer.domElement);
  expect(mode.pinCount()).toBe(1);
  clickAt(viewer.domElement); // same feature again -> toggle off
  expect(mode.pinCount()).toBe(0);
  mode.detach();
});

// The label must survive its own approach: labels usually float OFF the
// geometry, so the pointer travelling from the feature to its label leaves
// the mesh — without parking, the hover (and the label under the cursor)
// would clear before it could ever be clicked.
test("hover parks while the pointer is over a dim label (and shows a pointer cursor)", () => {
  const { viewer, mode, dimGroup, hasHover } = setup({ mesh: plateMesh({ halfLabeled: true }) });
  mode.setEnabled(true);
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", { ...pointerOpts, clientX: 64.1, clientY: 55.6 }));
  expect(hasHover()).toBe(true);

  const target = offFeatureLabelTarget(viewer, dimGroup, "hover");
  expect(target).toBeDefined();
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", { ...pointerOpts, clientX: target.x, clientY: target.y }));
  expect(hasHover()).toBe(true); // parked, not cleared
  expect(viewer.domElement.style.cursor).toBe("pointer");

  // moving to empty space (no label, no geometry) clears hover and cursor
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", { ...pointerOpts, clientX: 2, clientY: 2 }));
  expect(hasHover()).toBe(false);
  expect(viewer.domElement.style.cursor).toBe("");
  mode.detach();
});

// Regression: pins are per view, but the frame dirty check only watches the
// meshes — and two views can share an identical mesh set, so switching between
// them changes nothing it hashes. v1 caught this incidentally through its
// camera hash (a view switch reframes); v2 has no camera hash, so the active
// view is seeded into the signature explicitly. Without that, view A's pinned
// dims keep drawing over view B.
test("switching views drops the other view's pinned dims", () => {
  const { viewer, mode, ctx, itemIds } = setup();
  mode.setEnabled(true);
  clickAt(viewer.domElement); // pin in view "main"
  expect(mode.pinCount()).toBe(1);
  expect(itemIds().some((id) => id.startsWith("pin:"))).toBe(true);

  ctx.view = "alt"; // same meshes, same poses, same geometry — only the view moved
  viewer.frame();
  expect(mode.pinCount()).toBe(0); // "alt" has no pins of its own
  expect(itemIds().some((id) => id.startsWith("pin:"))).toBe(false);

  ctx.view = "main";
  viewer.frame();
  expect(mode.pinCount()).toBe(1);
  expect(itemIds().some((id) => id.startsWith("pin:"))).toBe(true);
});

// transformSpec's job: carry a spec out of the mesh's own geometry frame into
// the parts frame dim3-place works in. The overall dim gets there by a
// different route (its bounds are composed with mesh.matrix directly), so
// these two pin the pinned-item path — the only user of the plane and bbox
// branches — against a real (translated) pose.
test("a posed mesh moves its pinned PLANE dim by the pose", () => {
  const { mesh, viewer, mode, labelPositions } = setup();
  mode.setEnabled(true);
  clickAt(viewer.domElement); // pin the "top face" feature -> plane spec
  expect(mode.pinCount()).toBe(1);
  viewer.frame(); // settle scene.tick()'s screen-constant label sizing before capturing
  const before = labelPositions("pin:");
  expect(before.length).toBeGreaterThan(0);

  poseSubMesh(mesh, new THREE.Matrix4().makeTranslation(5, 0, 0));
  viewer.frame(); // the pose is hashed, so this rebuilds
  const after = labelPositions("pin:");

  expect(after.length).toBe(before.length);
  after.forEach((p, i) => {
    expect(p[0]).toBeCloseTo(before[i][0] + 5, 5); // translated along X
    expect(p[1]).toBeCloseTo(before[i][1], 5);
    expect(p[2]).toBeCloseTo(before[i][2], 5);
  });
  mode.detach();
});

test("a posed mesh moves its pinned BBOX dim by the pose", () => {
  // half-labeled plate: clicking the unlabeled triangle pins the sub-part
  // bounding box, which is the spec kind that goes through transformSpec's
  // Box3 branch.
  const { mesh, viewer, mode, itemIds, labelPositions } = setup({ mesh: plateMesh({ halfLabeled: true }) });
  mode.setEnabled(true);
  clickAt(viewer.domElement, 50, 48); // over the UNLABELED triangle
  expect(itemIds()).toContain("pin:plate:bbox:0");
  viewer.frame(); // settle scene.tick()'s screen-constant label sizing before capturing
  const before = labelPositions("pin:");
  expect(before.length).toBeGreaterThan(0);

  poseSubMesh(mesh, new THREE.Matrix4().makeTranslation(5, 0, 0));
  viewer.frame();
  const after = labelPositions("pin:");

  expect(after.length).toBe(before.length);
  after.forEach((p, i) => {
    expect(p[0]).toBeCloseTo(before[i][0] + 5, 5);
    expect(p[1]).toBeCloseTo(before[i][1], 5);
    expect(p[2]).toBeCloseTo(before[i][2], 5);
  });
  // a pure translation must not change the measured extents
  expect(paintLog.filter((t) => t === "20.00 mm").length).toBeGreaterThan(0);
  expect(paintLog).not.toContain("25.00 mm");
  mode.detach();
});

// Open tube (wall triangles only, one labeled feature), axis along Y — not Z
// like feature-dims.test.js's tube() — so it sits crosswise to this file's
// fixed camera ray (straight down -Z through x=10, y=5) and gets hit by a
// click at the default (50, 50). Centered on (cx, length/2, cz) so classifyFeature's
// fitted center lands there too.
function cylinderMesh({ r = 3, length = 10, seg = 24, cx = 10, cz = 2, id = 1, label = "boss" } = {}) {
  const pos = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (2 * Math.PI * i) / seg, a1 = (2 * Math.PI * (i + 1)) / seg;
    const p0 = [r * Math.cos(a0), r * Math.sin(a0)], p1 = [r * Math.cos(a1), r * Math.sin(a1)];
    pos.push(cx + p0[0], 0, cz + p0[1], cx + p1[0], 0, cz + p1[1], cx + p1[0], length, cz + p1[1]);
    pos.push(cx + p0[0], 0, cz + p0[1], cx + p1[0], length, cz + p1[1], cx + p0[0], length, cz + p0[1]);
  }
  const positions = new Float32Array(pos);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.userData.featureIds = new Uint16Array(positions.length / 9).fill(id);
  geo.userData.features = [label];
  return new THREE.Mesh(geo);
}

// transformSpec's cylinder branch (measure-mode.js's `dir()`/`pt()` mapping of
// center/axis/top/bottom/rimDir) is otherwise uncovered: the two pose tests
// above pin the plane and bbox branches, the only other users of the pinned-
// item path, against a real (translated) pose, and this closes the parked gap
// for the third kind under a real ROTATION.
//
// The pose rotates 90° about Z, pivoted on the feature's own classified
// center (T·R·T⁻¹) rather than the parts origin. That keeps the pose a real
// rotation (so transformSpec's `dir()` path — not just `pt()`'s translation
// case — actually runs) while leaving the camera-relative-to-center geometry
// that drives dim3-place's ⌀-direction (`du`) choice untouched by the pose:
// with the center fixed, the expected rotated label position follows directly
// from the pose matrix, rather than needing to re-derive evaluateChoices'
// hysteresis/direction heuristics inside the test.
test("a posed mesh rotates its pinned CYLINDER dim's ⌀ label through transformSpec", () => {
  const mesh = cylinderMesh();
  const { viewer, mode, itemIds, labelPositions } = setup({ mesh });
  mode.setEnabled(true);
  clickAt(viewer.domElement); // pin the "boss" wall feature -> cylinder spec
  expect(mode.pinCount()).toBe(1);
  expect(itemIds()).toContain("pin:plate:boss:0");
  viewer.frame(); // settle scene.tick()'s screen-constant label sizing before capturing
  const before = labelPositions("pin:"); // [⌀ label, depth label]
  expect(before.length).toBeGreaterThan(0);

  const rawSpec = classifyFeature(
    { positions: mesh.geometry.getAttribute("position").array, featureIds: mesh.geometry.userData.featureIds },
    1,
  );
  expect(rawSpec.kind).toBe("cylinder");
  const [cx, cy, cz] = rawSpec.anchors.center;

  const pose = new THREE.Matrix4()
    .makeTranslation(cx, cy, cz)
    .multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2))
    .multiply(new THREE.Matrix4().makeTranslation(-cx, -cy, -cz));
  poseSubMesh(mesh, pose);
  viewer.frame(); // pose is hashed, so this rebuilds
  const after = labelPositions("pin:");

  expect(after.length).toBe(before.length);
  // The ⌀ label is always index 0 (placeCylinder pushes it before the depth
  // dim's label). A 90° Z-rotation about (cx, cy, cz) maps a point offset
  // (dx, dy, dz) from that center to (-dy, dx, dz).
  const [bx, by, bz] = before[0];
  const [ax, ay, az] = after[0];
  expect(ax - cx).toBeCloseTo(-(by - cy), 3);
  expect(ay - cy).toBeCloseTo(bx - cx, 3);
  expect(az - cz).toBeCloseTo(bz - cz, 3);
  mode.detach();
});

// Regression: the pose hash used to carry only the matrix diagonal, so a
// rotation and its mirror image (θ and −θ about X share cos θ on the diagonal)
// with the same translation read as identical — and v2 has no camera hash left
// to notice. The full rotation basis is hashed instead.
test("an opposite-sign pose rotation is not mistaken for the same pose", () => {
  const { mesh, viewer, mode, labelPositions } = setup();
  mode.setEnabled(true);
  clickAt(viewer.domElement);
  expect(mode.pinCount()).toBe(1);

  const posed = (t) => new THREE.Matrix4().makeRotationX(t).setPosition(1, 2, 3);
  poseSubMesh(mesh, posed(Math.PI / 6));
  viewer.frame();
  const plus = labelPositions("pin:");
  expect(plus.length).toBeGreaterThan(0);

  poseSubMesh(mesh, posed(-Math.PI / 6)); // same diagonal, same translation
  viewer.frame();
  const minus = labelPositions("pin:");

  expect(minus.length).toBe(plus.length);
  expect(minus).not.toEqual(plus);
  mode.detach();
});

// The placement pipeline (vertex scans, raycasts) must run on CHANGE, not per
// frame. scene.update() replaces every child object, so child identity across
// frames is a direct read on "did we re-place?".
test("a steady frame does not re-place; only a side-choice flip does", () => {
  const { viewer, mode, dimGroup } = setup();
  mode.setEnabled(true);
  const kids = () => [...dimGroup().children];
  // identity, not deep equality: scene.update() builds brand-new child objects,
  // so "same objects" means update() was never called.
  const same = (a, b) => a.length === b.length && a.every((o, i) => o === b[i]);
  const first = kids();
  expect(first.length).toBeGreaterThan(0);

  for (let i = 0; i < 5; i++) viewer.frame(); // nothing changed at all
  expect(same(kids(), first)).toBe(true);

  // a nudge too small to flip which side any dim hangs off
  viewer.camera.position.set(10.5, 5.2, 40);
  viewer.frame();
  expect(same(kids(), first)).toBe(true);

  // an opposite camera along the SAME axis keeps the same face-on plane —
  // that's the readability rule working, not a missed flip
  viewer.camera.position.set(10, 5, -40);
  viewer.frame();
  expect(same(kids(), first)).toBe(true);

  // a SIDE camera makes a different plane face-on: now a choice flips
  viewer.camera.position.set(150, 5, 2);
  viewer.frame();
  expect(same(kids(), first)).toBe(false);
  expect(kids().length).toBe(first.length);
  mode.detach();
});

// Hover changes on every rAF while the pointer moves, and placeBox scans every
// vertex of the meshes it covers — so a hover move must re-place the hover item
// ALONE, reusing the cached always-on/pinned drawings. Read straight off
// placeDims: which items each call was asked to place.
test("hovering re-places only the hover dim, reusing the cached base drawings", () => {
  const { viewer, mode, hasHover } = setup();
  mode.setEnabled(true);
  // enable places the base set once
  expect(placeDims.mock.calls.at(-1)[0].map((i) => i.id)).toEqual(["overall"]);

  placeDims.mockClear();
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", pointerOpts));
  expect(hasHover()).toBe(true);
  expect(placeDims.mock.calls.map((c) => c[0].map((i) => i.id))).toEqual([["hover"]]);

  // (a further move that resolves to the SAME spec re-places nothing at all —
  // see "a hover move that stays on the same feature re-places nothing")

  // pinning changes the base set, so that one does re-place both
  placeDims.mockClear();
  clickAt(viewer.domElement);
  expect(mode.pinCount()).toBe(1);
  expect(placeDims.mock.calls.map((c) => c[0].map((i) => i.id)))
    .toEqual([["overall", "pin:plate:top face:0"], ["hover"]]);
  mode.detach();
});

// The hover dim is fully determined by its spec + the side choices + the lane
// seed — and the spec is IDENTICAL for every pointer position over one feature.
// Re-placing it per rAF therefore repeats an identical vertex scan and surface
// raycast set for as long as the pointer sits on the same face, which is what
// makes hovering a big part hitch. A move that resolves to the same spec must
// re-place nothing and repaint nothing.
test("a hover move that stays on the same feature re-places nothing", () => {
  const { viewer, mode, hasHover, dimGroup } = setup();
  mode.setEnabled(true);
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", pointerOpts));
  expect(hasHover()).toBe(true);
  const first = [...dimGroup().children];

  placeDims.mockClear();
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", { ...pointerOpts, clientX: 52 }));
  expect(placeDims.mock.calls).toEqual([]);
  // identity, not deep equality: an unchanged drawing list must not be repainted
  expect([...dimGroup().children]).toEqual(first);
  expect(hasHover()).toBe(true);
  mode.detach();
});

// The other half of the same rule: a move onto a DIFFERENT spec must still
// re-place, or the cache would freeze the hover dim on the first thing touched.
test("a hover move onto a different feature re-places the hover dim", () => {
  const { viewer, mode } = setup({ mesh: plateMesh({ halfLabeled: true }) });
  mode.setEnabled(true);
  // inside the labeled triangle, then its mirror in the UNLABELED one, where
  // the hover falls back to the sub-part bbox — a different spec
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", { ...pointerOpts, clientX: 64.1, clientY: 55.6 }));
  placeDims.mockClear();
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", { ...pointerOpts, clientX: 35.9, clientY: 44.4 }));
  expect(placeDims.mock.calls.map((c) => c[0].map((i) => i.id))).toEqual([["hover"]]);
  mode.detach();
});

// Orbiting flips side choices repeatedly — measured at ~15 flips over a single
// 360° turn — and each flip invalidated a one-slot cache, so every flip paid a
// full re-place even when the choice it landed on had just been placed moments
// earlier. The caches are keyed and bounded instead, so an orbit that sweeps
// back over ground it has already covered places nothing new.
test("an orbit that revisits angles it has already placed re-places nothing", () => {
  const { viewer, mode, labelPositions } = setup();
  mode.setEnabled(true);
  const orbit = () => {
    for (const p of [[150, 5, 2], [10, 5, 40], [5, 150, 2], [10, 5, 40]]) {
      viewer.camera.position.set(...p);
      viewer.frame();
    }
  };
  orbit(); // first pass places each distinct choice once
  const home = labelPositions("overall");
  expect(home.length).toBeGreaterThan(0);

  placeDims.mockClear();
  orbit(); // the identical sweep, second time round
  expect(placeDims.mock.calls).toEqual([]);
  expect(labelPositions("overall")).toEqual(home); // and it still draws the same
  mode.detach();
});

// The same rule with a pointer held on a face, which is the case the report
// describes: orbiting while hovering flips the HOVER dim's side too, so a
// one-slot cache re-placed the hovered item on every flip.
test("an orbit that revisits angles re-places nothing while hovering either", () => {
  const { viewer, mode, hasHover, labelPositions } = setup();
  mode.setEnabled(true);
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", pointerOpts));
  expect(hasHover()).toBe(true);
  const orbit = () => {
    for (const p of [[150, 5, 2], [10, 5, 40], [5, 150, 2], [10, 5, 40]]) {
      viewer.camera.position.set(...p);
      viewer.frame();
    }
  };
  orbit();
  const home = labelPositions("hover");
  expect(home.length).toBeGreaterThan(0);

  placeDims.mockClear();
  orbit();
  expect(placeDims.mock.calls).toEqual([]);
  expect(labelPositions("hover")).toEqual(home);
  mode.detach();
});

test("onModeChange fires on enable and disable", () => {
  const { mode } = setup();
  const cb = vi.fn();
  mode.onModeChange(cb);
  mode.setEnabled(true);
  mode.setEnabled(false);
  expect(cb).toHaveBeenCalledTimes(2);
  mode.detach();
});

test("pointerleave clears the hover dim", () => {
  const { viewer, mode, hasHover } = setup();
  mode.setEnabled(true);
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", pointerOpts));
  expect(hasHover()).toBe(true);
  viewer.domElement.dispatchEvent(new MouseEvent("pointerleave"));
  expect(hasHover()).toBe(false);
  mode.detach();
});

// Regression: a visibility-only change (e.g. a cutaway/view toggle hiding the
// hovered sub-part) trips the mesh signature, but the mesh's geometry identity
// is untouched — the old check (geometry identity only) missed this and left a
// stale hover dim/highlight pointing at a now-invisible mesh.
test("stale hover is dropped when its mesh goes invisible, even with the same geometry", () => {
  const { mesh, viewer, mode, hasHover } = setup();
  mode.setEnabled(true);
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", pointerOpts));
  expect(hasHover()).toBe(true);

  mesh.visible = false;
  viewer.frame(); // dirty check picks up the visibility flip

  expect(hasHover()).toBe(false);
  mode.detach();
});

// Regression: the cutaway gizmo and measure mode share the pointer over the
// same canvas; a handle drag must steal it the same way hover.js already does.
test("cutaway handle hover suppresses measure hover; releases resume it", () => {
  const { viewer, mode, hasHover } = setup();
  mode.setEnabled(true);
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", pointerOpts));
  expect(hasHover()).toBe(true);

  viewer.fireHandleHover("radius"); // gizmo drag starts
  expect(hasHover()).toBe(false); // suppressed: hover dim + highlight dropped

  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", { ...pointerOpts, clientX: 51 }));
  expect(hasHover()).toBe(false); // moves ignored while suppressed

  viewer.fireHandleHover(null); // gizmo released
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", pointerOpts));
  expect(hasHover()).toBe(true); // hovering works again
  mode.detach();
});

test("a theme change repaints the dims and detach removes the group", () => {
  const { viewer, mode, dimGroup } = setup();
  mode.setEnabled(true);
  expect(dimGroup()).toBeDefined();
  expect(() => viewer.fireTheme("light")).not.toThrow();
  expect(dimGroup().children.length).toBeGreaterThan(0);
  mode.detach();
  expect(dimGroup()).toBeUndefined(); // group removed from the parts group
});

test("frame ticks are harmless before and after the mode is enabled", () => {
  const { viewer, mode } = setup();
  expect(() => viewer.frame()).not.toThrow(); // never enabled: no scene yet
  mode.setEnabled(true);
  expect(() => viewer.frame()).not.toThrow(); // steady state: cheap re-score
  mode.detach();
});

// A pose-drag skin rewrites a sub-part's vertices in place (viewer.setSubVertices):
// same geometry, same positions array, a bumped attribute version. A pinned dim must
// follow the new surface, not a spec cached for the old one.
test("a pinned dim follows vertices rewritten in place", () => {
  const { mesh, viewer, mode, labelPositions } = setup();
  mode.setEnabled(true);
  clickAt(viewer.domElement); // pin the top face at z=2
  expect(mode.pinCount()).toBe(1);
  viewer.frame();
  const before = labelPositions("pin:");
  expect(before.length).toBeGreaterThan(0);

  const attr = mesh.geometry.getAttribute("position");
  for (let i = 2; i < attr.array.length; i += 3) attr.array[i] += 5; // lift the plate 5mm
  attr.needsUpdate = true;
  mesh.geometry.computeBoundingBox();
  viewer.frame();
  const after = labelPositions("pin:");

  expect(after.length).toBe(before.length);
  after.forEach((p, i) => {
    expect(p[0]).toBeCloseTo(before[i][0], 5);
    expect(p[1]).toBeCloseTo(before[i][1], 5);
    expect(p[2]).toBeCloseTo(before[i][2] + 5, 5);
  });
  mode.detach();
});
