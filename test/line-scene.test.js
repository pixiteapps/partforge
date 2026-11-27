// The live viewer's line scene (lines/line-scene.js): one tube mesh per declared line of the
// view, parented with the sub-part meshes, re-meshed from derive on every update.
import { describe, expect, test, vi } from "vitest";
import * as THREE from "three";
import { createLineScene, LINE_LIMIT_COLOR } from "../src/framework/lines/line-scene.js";
import { LINE_COLOR } from "../src/framework/lines/tube.js";
import { concentricCapstan, make } from "./fixtures/capstan-fixtures.js";

const fakeViewer = () => {
  const parent = new THREE.Group();
  return {
    parent,
    _subMeshes: { a: { parent } },
    requestRender: vi.fn(),
    registerCutawayMaterial: vi.fn(() => vi.fn()),
  };
};
const dAt = (angle) => concentricCapstan.derive({ motorAngle: angle });
const rope = (v) => v.parent.getObjectByName("line:rope");
const positions = (mesh) => Array.from(mesh.geometry.getAttribute("position").array);
// A drive whose rope reads with the given bend numbers.
const bent = (bendRatio, minBendRatio) => {
  const real = make(0);
  return { drive: { lineInfo: () => {
    const info = real.lineInfo();
    return { ...info, lines: { rope: { ...info.lines.rope, bendRatio, minBendRatio } } };
  } } };
};

describe("createLineScene", () => {
  test("draws each line of the view", () => {
    const v = fakeViewer();
    const scene = createLineScene(v, concentricCapstan);
    scene.update("assembly", dAt(0));
    const meshes = [];
    v.parent.traverse((o) => { if (o.isMesh) meshes.push(o); });
    expect(meshes.map((m) => m.name)).toEqual(["line:rope"]);
    expect(rope(v).visible).toBe(true);
    expect(rope(v).geometry.getAttribute("position").count).toBeGreaterThan(0);
    expect(v.requestRender).toHaveBeenCalled();
    expect(scene.readings().get("rope").length).toBeGreaterThan(0);
  });

  test("re-meshes on update", () => {
    const v = fakeViewer();
    const scene = createLineScene(v, concentricCapstan);
    scene.update("assembly", dAt(0));
    const first = rope(v).geometry;
    const before = positions(rope(v));
    const spy = vi.spyOn(first, "dispose");
    scene.update("assembly", dAt(90));
    expect(rope(v).geometry).not.toBe(first);
    expect(spy).toHaveBeenCalled();
    expect(positions(rope(v))).not.toEqual(before);
  });

  test("an unreadable line hides its tube and comes back", () => {
    const v = fakeViewer();
    const scene = createLineScene(v, concentricCapstan);
    scene.update("assembly", dAt(0));
    scene.update("assembly", { drive: { lineInfo: () => { throw new Error("no rope"); } } });
    expect(rope(v).visible).toBe(false);
    expect(scene.readings().get("rope")).toBe(null);
    scene.update("assembly", dAt(10));
    expect(rope(v).visible).toBe(true);
    expect(scene.readings().get("rope")).not.toBe(null);
  });

  test("view switch shows only the view's lines", () => {
    const part = {
      ...concentricCapstan,
      views: { assembly: { label: "Assembly" }, other: { label: "Other" } },
      lines: { rope: { on: "drive", views: ["other"] } },
    };
    const v = fakeViewer();
    const scene = createLineScene(v, part);
    scene.update("other", dAt(0));
    expect(rope(v).visible).toBe(true);
    scene.update("assembly", dAt(0));
    expect(rope(v).visible).toBe(false);
    expect(scene.readings().has("rope")).toBe(false);
    scene.update("other", dAt(0));
    expect(rope(v).visible).toBe(true);
  });

  test("registers its material with the cutaway", () => {
    const v = fakeViewer();
    const scene = createLineScene(v, concentricCapstan);
    scene.update("assembly", dAt(0));
    expect(v.registerCutawayMaterial).toHaveBeenCalledWith(rope(v).material);
    const unregister = v.registerCutawayMaterial.mock.results[0].value;
    scene.dispose();
    expect(unregister).toHaveBeenCalled();
    expect(rope(v)).toBeUndefined();
  });

  test("tints a line past its bend limit", () => {
    const v = fakeViewer();
    const scene = createLineScene(v, concentricCapstan);
    scene.update("assembly", bent(5, 8));
    expect(rope(v).material.color.getHex()).toBe(LINE_LIMIT_COLOR);
    scene.update("assembly", bent(10, 8));
    expect(rope(v).material.color.getHex()).toBe(LINE_COLOR);
    scene.setLimit("rope", true);
    expect(rope(v).material.color.getHex()).toBe(LINE_LIMIT_COLOR);
    // a bend tint and a limit tint combine: tinted while either holds
    scene.update("assembly", bent(5, 8));
    scene.setLimit("rope", false);
    expect(rope(v).material.color.getHex()).toBe(LINE_LIMIT_COLOR);
    scene.update("assembly", bent(10, 8));
    expect(rope(v).material.color.getHex()).toBe(LINE_COLOR);
  });

  test("attaches once the sub-part meshes exist", () => {
    const v = fakeViewer();
    const subs = v._subMeshes;
    v._subMeshes = {};
    const scene = createLineScene(v, concentricCapstan);
    scene.update("assembly", dAt(0));
    expect(rope(v)).toBeUndefined();
    v._subMeshes = subs;
    scene.update("assembly", dAt(0));
    expect(rope(v).visible).toBe(true);
  });
});
