// Regression cases for the skewed measure drawing (Scott's report: some dims
// were "not on a canonical plane and with lines from the feature that weren't
// parallel"). Each case runs today's pipeline end to end on real three
// geometry — classifyFeature → the orchestrator's transformSpec posing →
// evaluateChoices → placeDims — and holds every linear dim to expectSquareDim.
//
// RESULTS (Task 1, before any fix). Cases marked `test.fails` reproduce the
// bug today; Task 4 flips them to `test`.
//
//  1. bbox overall dim with a real surfaceHit — FAILS, extension lines not
//     parallel. linearDim (dim3-place.js) nudges each raycast origin 0.05 mm
//     along `dir`, INWARD, before the surface hit, so pA − baseA carries a
//     0.05 mm component along the dim line. dim3-scene draws the extension
//     line from pA to baseA + ext·offset, and offset is screen-constant, so
//     zoomed in (offset of a few tenths of a mm) the two extension lines lean
//     toward each other by many degrees. This is the "lines from the feature
//     that weren't parallel" half of the report.
//  2. sub-part posed 30° about Z — the bbox dims FAIL the same way as case 1;
//     the posed plane feature passes against the sub-part's own posed axes.
//  3. a plane feature tilted 30° off the axes — FAILS, not on the face's own
//     frame. planeSpec's non-snapped basis takes the LONGEST triangle edge as
//     `u`; a rectangle meshed as two triangles has its diagonal as the longest
//     edge, so width/height run along the face DIAGONAL, and neither the dim
//     line nor its extension direction lies on the face's edges or normal.
//     This is the "not on a canonical plane" half of the report: every tilted
//     face (chamfers, sloped walls) draws this way. The VALUES are wrong too:
//     the 40 × 20 face here reads 44.72 × 35.78 (44.72 is its diagonal).
//  4. a cylinder with its axis at 45° — the depth dim passes here (q2 rounding
//     of the anchors is exact enough at 45°); kept as a guard.
import { test, expect } from "vitest";
import * as THREE from "three";
import { classifyFeature, bboxSpec } from "../../../src/framework/measure/feature-dims.js";
import { evaluateChoices, placeDims } from "../../../src/framework/measure/dim3-place.js";
import { expectSquareDim, PARTS_AXES, cross, norm } from "./drawing-rules.js";

// ---- pipeline pieces, mirroring measure-mode.js ------------------------------

// Copy of measure-mode.js transformSpec (not exported): compose a mesh's local
// pose into a spec's anchors so it lives in the parts frame.
function transformSpec(spec, matrix) {
  const tv = new THREE.Vector3();
  const m3 = new THREE.Matrix3().setFromMatrix4(matrix);
  const pt = (p) => tv.set(p[0], p[1], p[2]).applyMatrix4(matrix).toArray();
  const dir = (d) => tv.set(d[0], d[1], d[2]).applyMatrix3(m3).normalize().toArray();
  if (spec.kind === "plane") {
    return { ...spec, anchors: {
      width: { a: pt(spec.anchors.width.a), b: pt(spec.anchors.width.b) },
      height: { a: pt(spec.anchors.height.a), b: pt(spec.anchors.height.b) },
      normal: dir(spec.anchors.normal),
    } };
  }
  if (spec.kind === "cylinder") {
    return { ...spec, anchors: {
      center: pt(spec.anchors.center), axis: dir(spec.anchors.axis),
      top: pt(spec.anchors.top), bottom: pt(spec.anchors.bottom),
      rimDir: spec.anchors.rimDir ? dir(spec.anchors.rimDir) : undefined,
    } };
  }
  if (spec.kind === "bbox") {
    const b = new THREE.Box3(
      new THREE.Vector3(...spec.anchors.min), new THREE.Vector3(...spec.anchors.max),
    ).applyMatrix4(matrix);
    return bboxSpec(b.min.toArray(), b.max.toArray());
  }
  return spec;
}

// One sub-part mesh under a shared `parts` group, posed by `pose` the way the
// viewer's fast path poses it (matrix set directly, no auto-update).
function sceneWith(geometry, pose = new THREE.Matrix4()) {
  const parts = new THREE.Group();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(pose);
  parts.add(mesh);
  parts.updateMatrixWorld(true);
  return { parts, mesh };
}

// measure-mode.js buildEnv: vertex arrays + poses, a real surface raycast in
// the parts frame.
function envFor({ parts, mesh }) {
  const rc = new THREE.Raycaster();
  const surfaceHit = (origin, dir) => {
    const o = new THREE.Vector3().copy(origin).applyMatrix4(parts.matrixWorld);
    const d = new THREE.Vector3().copy(dir).transformDirection(parts.matrixWorld);
    rc.set(o, d);
    const hit = rc.intersectObjects([mesh], false)[0];
    return hit ? parts.worldToLocal(hit.point.clone()) : null;
  };
  const meshData = [{ positions: mesh.geometry.getAttribute("position").array, matrix: mesh.matrix }];
  return { meshData, surfaceHit };
}

function posedBounds(mesh) {
  mesh.geometry.computeBoundingBox();
  const b = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrix);
  return { min: b.min.toArray(), max: b.max.toArray() };
}

function place(items, { env, bounds, camPos }) {
  const center = bounds.min.map((v, i) => (v + bounds.max[i]) / 2);
  const choices = evaluateChoices(items, { camPos, center, prev: {} });
  const drawings = placeDims(items, { ...env, bounds }, choices);
  return { drawings, choices };
}

// A box with one feature id per face (BoxGeometry groups: +x −x +y −y +z −z).
function featureBox(w, h, d) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const ids = new Uint16Array(geo.getIndex().count / 3);
  geo.groups.forEach((g, i) => { for (let t = g.start / 3; t < (g.start + g.count) / 3; t++) ids[t] = i + 1; });
  geo.userData.featureIds = ids;
  geo.userData.features = ["+x", "-x", "+y", "-y", "+z", "-z"];
  return geo;
}
const FACE = { px: 1, nx: 2, py: 3, ny: 4, pz: 5, nz: 6 };

function specOf(geo, featureId) {
  return classifyFeature({
    positions: geo.getAttribute("position").array,
    indices: geo.getIndex()?.array,
    featureIds: geo.userData.featureIds,
  }, featureId);
}

const allDims = (drawings) => drawings.flatMap((d) => d.dims);
const CAM = [80, -120, 90];

// ---- cases -------------------------------------------------------------------

test.fails("1. bbox overall dim with a real surfaceHit draws parallel extension lines", () => {
  const scene = sceneWith(featureBox(40, 20, 10));
  const bounds = posedBounds(scene.mesh);
  const item = { id: "overall", tier: "static", spec: bboxSpec(bounds.min, bounds.max), meshes: [0] };
  const { drawings } = place([item], { env: envFor(scene), bounds, camPos: CAM });
  const dims = allDims(drawings);
  expect(dims.length).toBe(3);
  for (const dim of dims) expectSquareDim(dim);
});

test.fails("2a. sub-part posed 30° about Z: its bbox dims are square to the parts frame", () => {
  const pose = new THREE.Matrix4().makeRotationZ(Math.PI / 6).setPosition(5, -3, 2);
  const scene = sceneWith(featureBox(40, 20, 10), pose);
  scene.mesh.geometry.computeBoundingBox();
  const { min, max } = scene.mesh.geometry.boundingBox;
  const spec = transformSpec(bboxSpec(min.toArray(), max.toArray()), pose);
  const bounds = posedBounds(scene.mesh);
  const item = { id: "hover", tier: "hover", spec, meshes: [0] };
  const { drawings } = place([item], { env: envFor(scene), bounds, camPos: CAM });
  const dims = allDims(drawings);
  expect(dims.length).toBe(3);
  for (const dim of dims) expectSquareDim(dim);
});

test("2b. sub-part posed 30° about Z: a plane feature is square to the posed sub-part", () => {
  const pose = new THREE.Matrix4().makeRotationZ(Math.PI / 6).setPosition(5, -3, 2);
  const geo = featureBox(40, 20, 10);
  const scene = sceneWith(geo, pose);
  const bounds = posedBounds(scene.mesh);
  // the posed sub-part's own axes
  const subAxes = [0, 1, 2].map((i) =>
    new THREE.Vector3().setComponent(i, 1).applyMatrix3(new THREE.Matrix3().setFromMatrix4(pose)).toArray());
  for (const face of [FACE.pz, FACE.px]) {
    const raw = specOf(geo, face);
    expect(raw.kind).toBe("plane");
    const item = { id: "hover", tier: "hover", spec: transformSpec(raw, pose), meshes: [0] };
    const { drawings } = place([item], { env: envFor(scene), bounds, camPos: CAM });
    const dims = allDims(drawings);
    expect(dims.length).toBe(2);
    for (const dim of dims) expectSquareDim(dim, { frameAxes: subAxes });
  }
});

test.fails("3. a plane feature tilted 30° off the axes is drawn in the face's own frame", () => {
  const tilt = new THREE.Matrix4().makeRotationX(Math.PI / 6);
  const geo = featureBox(40, 20, 10).applyMatrix4(tilt);
  const scene = sceneWith(geo);
  const bounds = posedBounds(scene.mesh);
  const raw = specOf(geo, FACE.pz);
  expect(raw.kind).toBe("plane");
  // the face's own frame: its two edge directions and its normal
  const u = new THREE.Vector3(1, 0, 0).applyMatrix4(tilt).toArray();
  const v = new THREE.Vector3(0, 1, 0).applyMatrix4(tilt).toArray();
  const n = new THREE.Vector3(0, 0, 1).applyMatrix4(tilt).toArray();
  const item = { id: "hover", tier: "hover", spec: raw, meshes: [0] };
  const { drawings } = place([item], { env: envFor(scene), bounds, camPos: CAM });
  const dims = allDims(drawings);
  expect(dims.length).toBe(2);
  for (const dim of dims) expectSquareDim(dim, { frameAxes: [u, v, n] });
});

test("4. a cylinder with its axis at 45°: the depth dim is square to the axis frame", () => {
  const rot = new THREE.Matrix4().makeRotationZ(-Math.PI / 4); // three's cylinder axis is Y
  const geo = new THREE.CylinderGeometry(4, 4, 12, 32, 1, true).applyMatrix4(rot);
  geo.userData.featureIds = new Uint16Array(geo.getIndex().count / 3).fill(1);
  geo.userData.features = ["bore"];
  const scene = sceneWith(geo);
  const bounds = posedBounds(scene.mesh);
  const raw = specOf(geo, 1);
  expect(raw.kind).toBe("cylinder");
  const item = { id: "hover", tier: "hover", spec: raw, meshes: [0] };
  const { drawings, choices } = place([item], { env: envFor(scene), bounds, camPos: CAM });
  const dims = allDims(drawings);
  expect(dims.length).toBe(1); // the depth dim; the ⌀ is a diam record
  const axis = norm(new THREE.Vector3(0, 1, 0).applyMatrix4(rot).toArray());
  const du = norm(choices["hover|du"].du);
  const dv = norm(cross(axis, du));
  for (const dim of dims) expectSquareDim(dim, { frameAxes: [axis, du, dv] });
});

// Sanity: the frame helper itself accepts a perfectly square record and the
// default frame is the parts axes.
test("expectSquareDim accepts a square record", () => {
  expect(PARTS_AXES.length).toBe(3);
  expectSquareDim({
    pA: [0, 0, 0], pB: [10, 0, 0], baseA: [0, 5, 0], baseB: [10, 5, 0],
    ext: [0, 1, 0], dir: [1, 0, 0],
  });
});
