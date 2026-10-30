// @vitest-environment happy-dom
// raycastViewer's `bvhFor` path (measure mode's BVH rays) must give three's
// answer: same mesh, triangle, point, normal and feature, the same culling of
// faces the material does not draw, and the same "nearest accepted hit".
import { expect, test } from "vitest";
import * as THREE from "three";
import { raycastViewer, firstSurfaceHit } from "../../../src/framework/selection/raycast.js";
import { buildBVH } from "../../../src/framework/oracle/bvh.js";

const bvhs = new WeakMap();
const bvhFor = (mesh) => {
  let b = bvhs.get(mesh.geometry);
  if (!b) {
    const g = mesh.geometry;
    b = buildBVH({ positions: g.getAttribute("position").array, indices: g.getIndex()?.array });
    bvhs.set(g, b);
  }
  return b;
};

// A box sub-part with per-triangle feature ids (one label per box face).
function boxMesh(name, { indexed = true, size = [10, 6, 4], side = THREE.FrontSide } = {}) {
  let geo = new THREE.BoxGeometry(...size, 3, 2, 2);
  if (!indexed) geo = geo.toNonIndexed();
  const triangles = (geo.getIndex()?.count ?? geo.getAttribute("position").count) / 3;
  const featureIds = new Uint16Array(triangles);
  for (let t = 0; t < triangles; t++) featureIds[t] = (t % 6) + 1;
  geo.userData.featureIds = featureIds;
  geo.userData.features = ["a", "b", "c", "d", "e", "f"];
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side }));
  mesh.name = name;
  return mesh;
}

function viewerWith(meshes, { cameraAt = [30, 22, 26], isWorldPointVisible } = {}) {
  const parts = new THREE.Group();
  parts.rotation.set(0.3, -0.2, 0.1);
  parts.position.set(2, -1, 3);
  for (const m of meshes) parts.add(m);
  parts.updateMatrixWorld(true);
  const dom = document.createElement("div");
  dom.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 });
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
  camera.position.set(...cameraAt);
  camera.lookAt(2, -1, 3);
  camera.updateMatrixWorld(true);
  return {
    domElement: dom,
    camera,
    _subMeshes: Object.fromEntries(meshes.map((m) => [m.name, m])),
    isWorldPointVisible,
  };
}

function expectSameHit(viewer, x, y) {
  const plain = raycastViewer(viewer, x, y);
  const fast = raycastViewer(viewer, x, y, { bvhFor });
  if (!plain) { expect(fast).toBeNull(); return null; }
  expect(fast).not.toBeNull();
  expect(fast.subPart).toBe(plain.subPart);
  expect(fast.triIndex).toBe(plain.triIndex);
  expect(fast.feature).toEqual(plain.feature);
  for (let k = 0; k < 3; k++) {
    expect(fast.pointWorld.getComponent(k)).toBeCloseTo(plain.pointWorld.getComponent(k), 4);
    expect(fast.pointLocal[k]).toBeCloseTo(plain.pointLocal[k], 4);
    expect(fast.normalLocal[k]).toBeCloseTo(plain.normalLocal[k], 5);
  }
  return plain.subPart;
}

// Every on-part sub-part name the grid crossed, one entry per hit.
const grid = (fn) => {
  const hits = [];
  for (let y = 4; y < 200; y += 8) for (let x = 4; x < 200; x += 8) { const h = fn(x, y); if (h) hits.push(h); }
  return hits;
};

test("BVH rays give three's hit over posed sub-parts, indexed and not", () => {
  const a = boxMesh("a");
  const b = boxMesh("b", { indexed: false, size: [4, 8, 5] });
  b.position.set(3, 2, 4);
  b.rotation.set(0.4, 0.7, -0.2);
  b.matrixWorldNeedsUpdate = true;
  const viewer = viewerWith([a, b]);
  viewer.camera.updateMatrixWorld(true);
  a.parent.updateMatrixWorld(true);
  const hits = grid((x, y) => expectSameHit(viewer, x, y));
  // the grid really crossed both parts
  expect(hits.filter((n) => n === "a").length).toBeGreaterThan(20);
  expect(hits.filter((n) => n === "b").length).toBeGreaterThan(20);
});

test("FrontSide culls a back face the ray meets first; BackSide and DoubleSide follow three", () => {
  for (const side of [THREE.FrontSide, THREE.BackSide, THREE.DoubleSide]) {
    // the camera INSIDE the box: every face it sees first is a back face
    const viewer = viewerWith([boxMesh("a", { side, size: [40, 40, 40] })], { cameraAt: [3, 0, 4] });
    const hits = grid((x, y) => expectSameHit(viewer, x, y));
    // FrontSide sees nothing from inside; the other two see the walls
    expect(hits.length > 0).toBe(side !== THREE.FrontSide);
  }
});

test("a rejected hit (a cutaway) moves on to the next drawn surface, as three's does", () => {
  const near = boxMesh("near", { size: [6, 6, 6] });
  const far = boxMesh("far", { size: [6, 6, 6] });
  far.position.set(-12, -9, -10);
  // drop everything nearer the camera than a plane through the near box
  const plane = new THREE.Plane(new THREE.Vector3(1, 0.7, 0.85).normalize(), 0);
  const viewer = viewerWith([near, far], { isWorldPointVisible: (p) => plane.distanceToPoint(p) < 0 });
  near.parent.updateMatrixWorld(true);
  const hits = grid((x, y) => expectSameHit(viewer, x, y));
  expect(hits.filter((n) => n === "far").length).toBeGreaterThan(5); // seen THROUGH the cut near box
});

test("a mesh with no index (bvhFor returns null) takes three's path", () => {
  const a = boxMesh("a");
  const viewer = viewerWith([a]);
  const ray = new THREE.Ray(viewer.camera.position.clone(), new THREE.Vector3(2, -1, 3).sub(viewer.camera.position).normalize());
  const viaThree = firstSurfaceHit(ray, [a], { bvhFor: () => null });
  const viaBvh = firstSurfaceHit(ray, [a], { bvhFor });
  expect(viaThree.tri).toBe(viaBvh.tri);
  expect(viaThree.distance).toBeCloseTo(viaBvh.distance, 4);
});
