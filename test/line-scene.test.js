// The live viewer's line scene (framework/line-scene.js): one tube mesh per declared line of the
// view, handed to the viewer as a display object, re-meshed from derive on every update.
import { describe, expect, test, vi } from "vitest";
import * as THREE from "three";
import { createLineScene, LINE_LIMIT_COLOR } from "../src/framework/line-scene.js";
import { LINE_COLOR } from "../src/framework/lines/tube.js";
import { lineDriftBound } from "../src/framework/lines/meshes.js";
import { CEL_LAYER } from "../src/framework/cel/cel-ink.js";
import { concentricCapstan, make } from "./fixtures/capstan-fixtures.js";

// addDisplayObject as the viewer's: parents the object and calls onLook with the mode now
// and on each look change (`v.setLook(mode)` here).
const fakeViewer = (mode = "cad") => {
  const parent = new THREE.Group();
  const looks = new Set();
  const v = {
    parent,
    requestRender: vi.fn(),
    registerCutawayMaterial: vi.fn(() => vi.fn()),
    addDisplayObject: vi.fn((object, { onLook } = {}) => {
      parent.add(object);
      looks.add(onLook);
      onLook?.(mode);
      return vi.fn(() => { looks.delete(onLook); object.removeFromParent(); });
    }),
    setLook: (m) => { for (const f of looks) f?.(m); },
  };
  return v;
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
// A drive whose rope reads `length` mm long.
const sized = (length) => {
  const real = make(0);
  return { drive: { lineInfo: () => {
    const info = real.lineInfo();
    return { ...info, lines: { rope: { ...info.lines.rope, length } } };
  } } };
};

describe("lineDriftBound", () => {
  const withDrift = (lineDrift) => ({ ...concentricCapstan, verify: lineDrift === undefined ? undefined : { expect: { _view: { lineDrift } } } });
  test("a <= or < bound against a number; anything else is null", () => {
    expect(lineDriftBound(withDrift("<=0.2"), "assembly")).toBe(0.2);
    expect(lineDriftBound(withDrift("<0.5"), "assembly")).toBe(0.5);
    expect(lineDriftBound(withDrift(">=1"), "assembly")).toBe(null);
    expect(lineDriftBound(withDrift(undefined), "assembly")).toBe(null);
    expect(lineDriftBound(withDrift("not an assertion"), "assembly")).toBe(null);
    // a view with no lines has no bound to show
    expect(lineDriftBound({ ...withDrift("<=0.2"), lines: { rope: { on: "drive", views: ["other"] } } }, "assembly")).toBe(null);
  });
});

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

  test("a setLimit before the line's first update tints it when it is built", () => {
    const v = fakeViewer();
    const scene = createLineScene(v, concentricCapstan);
    scene.setLimit("rope", true);
    scene.update("assembly", bent(10, 8));
    expect(rope(v).material.color.getHex()).toBe(LINE_LIMIT_COLOR);
    // turned off again before the build: not tinted
    const v2 = fakeViewer();
    const third = createLineScene(v2, concentricCapstan);
    third.setLimit("rope", true);
    third.setLimit("rope", false);
    third.update("assembly", bent(10, 8));
    expect(rope(v2).material.color.getHex()).toBe(LINE_COLOR);
  });

  test("hide hides every line until the next update", () => {
    const v = fakeViewer();
    const scene = createLineScene(v, concentricCapstan);
    scene.update("assembly", dAt(0));
    v.requestRender.mockClear();
    scene.hide();
    expect(rope(v).visible).toBe(false);
    expect(v.requestRender).toHaveBeenCalled();
    scene.update("assembly", dAt(0));
    expect(rope(v).visible).toBe(true);
  });

  test("readout: each readable line's length, 2 dp, and its signed drift from the press", () => {
    const v = fakeViewer();
    const scene = createLineScene(v, concentricCapstan);
    scene.update("assembly", sized(286.51));
    expect(scene.readout(new Map([["rope", { length: 286.48 }]]))).toEqual([
      { key: "line:rope", label: "rope", unit: "mm", value: 286.51, text: "286.51 (+0.03)" },
    ]);
    expect(scene.readout(new Map([["rope", { length: 286.6 }]]))[0].text).toBe("286.51 (-0.09)");
    // no drift rounds to +0.00, never -0.00
    expect(scene.readout(new Map([["rope", { length: 286.5101 }]]))[0].text).toBe("286.51 (+0.00)");
    // unreadable now, or at the press: left out
    expect(scene.readout(new Map([["rope", null]]))).toEqual([]);
    scene.update("assembly", { drive: { lineInfo: () => { throw new Error("no rope"); } } });
    expect(scene.readout(new Map([["rope", { length: 286.48 }]]))).toEqual([]);
  });

  test("dragLimits tints a line whose drift passes the bound; a null bound tints none", () => {
    const v = fakeViewer();
    const scene = createLineScene(v, concentricCapstan);
    scene.update("assembly", sized(100.3));
    scene.dragLimits(new Map([["rope", { length: 100 }]]), 0.2);
    expect(rope(v).material.color.getHex()).toBe(LINE_LIMIT_COLOR);
    scene.dragLimits(new Map([["rope", { length: 100.2 }]]), 0.2);
    expect(rope(v).material.color.getHex()).toBe(LINE_COLOR);
    scene.dragLimits(new Map([["rope", { length: 100 }]]), null);
    expect(rope(v).material.color.getHex()).toBe(LINE_COLOR);
  });

  test("hands its group to the viewer as a display object at once, and takes it back on dispose", () => {
    const v = fakeViewer();
    const scene = createLineScene(v, concentricCapstan);
    expect(v.addDisplayObject).toHaveBeenCalledTimes(1);
    expect(v.parent.getObjectByName("lines")).toBeTruthy();
    scene.update("assembly", dAt(0));
    expect(rope(v).visible).toBe(true);
    expect(rope(v).geometry.boundingBox).toBeTruthy(); // the viewer's framing bounds read it
    const remove = v.addDisplayObject.mock.results[0].value;
    scene.dispose();
    expect(remove).toHaveBeenCalled();
  });

  test("cel: a band material on CEL_LAYER, back to CAD on leaving; cutaway-registered, tint followed", () => {
    const v = fakeViewer();
    const scene = createLineScene(v, concentricCapstan);
    scene.update("assembly", dAt(0));
    const cad = rope(v).material;
    expect(cad.isMeshStandardMaterial).toBe(true);
    expect(rope(v).layers.isEnabled(CEL_LAYER)).toBe(false);
    v.setLook("cel");
    const cel = rope(v).material;
    expect(cel.userData.pfCel).toBe(true);
    expect(rope(v).layers.isEnabled(CEL_LAYER)).toBe(true);
    expect(v.registerCutawayMaterial).toHaveBeenCalledWith(cel);
    // a tint is a new band material; the old one is let go
    const celUnregister = v.registerCutawayMaterial.mock.results.at(-1).value;
    const celDispose = vi.spyOn(cel, "dispose");
    scene.setLimit("rope", true);
    expect(rope(v).material).not.toBe(cel);
    expect(rope(v).material.userData.pfCel).toBe(true);
    expect(celDispose).toHaveBeenCalled();
    expect(celUnregister).toHaveBeenCalled();
    v.setLook("cad");
    expect(rope(v).material).toBe(cad);
    expect(cad.color.getHex()).toBe(LINE_LIMIT_COLOR);
    expect(rope(v).layers.isEnabled(CEL_LAYER)).toBe(false);
    // realistic keeps the CAD material
    v.setLook("realistic");
    expect(rope(v).material).toBe(cad);
    scene.dispose();
  });

  test("a line built while cel is on is drawn in cel", () => {
    const v = fakeViewer("cel");
    const scene = createLineScene(v, concentricCapstan);
    scene.update("assembly", dAt(0));
    expect(rope(v).material.userData.pfCel).toBe(true);
    expect(rope(v).layers.isEnabled(CEL_LAYER)).toBe(true);
    scene.dispose();
  });
});
