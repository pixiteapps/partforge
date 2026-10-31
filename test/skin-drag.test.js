// The pose-drag controller (docs/superpowers/specs/2026-10-31-implicit-pose-drag-design.md §3-4):
// which delivered meshes become a skin base, when a slider change may deform one, and that a
// deformation always starts from the base.
import { expect, test, vi } from "vitest";
import { createSkinDrag } from "../src/framework/skin/skin-drag.js";
import { frameMotions, skinVertices } from "../src/framework/skin/deform.js";
import { implicitCallId } from "../src/framework/geometry/implicit/call-id.js";
import { TWO_BONE } from "./fixtures/skin-fixtures.js";

const id = implicitCallId(TWO_BONE(0), []);
const frames = [null, `${id}:root`, `${id}:child`];

// Two triangles: corners 0-2 on root, 3-5 on child.
const delivery = (over = {}) => ({
  name: "body",
  frame: "canonical",
  positions: Float32Array.of(0, 1, 0, 1, 2, 0, 0, 3, 1, 0, 25, 0, 1, 26, 0, 0, 27, 1),
  normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 1),
  bindings: {
    frameA: Uint16Array.of(1, 1, 1, 2, 2, 2),
    frameB: Uint16Array.of(0, 0, 0, 1, 1, 1),
    weight: Float32Array.of(1, 1, 1, 0.75, 0.5, 1),
    frames,
  },
  ...over,
});

// The fake probe: { skinnable, implicitSpecs, shapeHash } from the params alone. `r` is a
// non-frame change (a different spec), `box` a non-implicit operand (shapeHash only).
const probeEntry = (p) => {
  const spec = TWO_BONE(p.bend);
  if (p.r != null) spec.root.children[0].r = p.r;
  return { trusted: true, skinnable: !p.noskin, implicitSpecs: [spec], shapeHash: `shape-${p.r ?? 4}-${p.box ?? 1}` };
};

function setup() {
  const params = { bend: 0 };
  let version = 0;
  const viewer = { setSubVertices: vi.fn(() => true), hasSubMesh: () => true };
  const part = { parts: { body: {} }, views: {} };
  const probe = vi.fn((_part, _view, p) => new Map([["body", probeEntry(p)]]));
  const skin = createSkinDrag(part, viewer, {
    params, getView: () => "v", getParamsVersion: () => version, probe,
  });
  const edit = (patch) => { Object.assign(params, patch); version++; };
  return { params, viewer, skin, probe, edit };
}

vi.mock("../src/framework/part-model.js", async (importOriginal) => ({
  ...(await importOriginal()),
  viewSubParts: () => ["body"],
}));

test("a delivery without bindings, or posed, never becomes a base", () => {
  const { skin } = setup();
  skin.recordDelivered("body", delivery({ bindings: undefined }), { view: "v", params: { bend: 0 } });
  expect(skin.hasBase("body")).toBe(false);
  skin.recordDelivered("body", delivery({ frame: "posed" }), { view: "v", params: { bend: 0 } });
  expect(skin.hasBase("body")).toBe(false);
  skin.recordDelivered("body", delivery(), null);
  expect(skin.hasBase("body")).toBe(false);
  skin.recordDelivered("body", delivery(), { view: "v", params: { bend: 0, noskin: true } });
  expect(skin.hasBase("body")).toBe(false);
  skin.recordDelivered("body", delivery(), { view: "v", params: { bend: 0 } });
  expect(skin.hasBase("body")).toBe(true);
});

test("deform skins from the base twice identically and marks the drag", () => {
  const { skin, viewer, edit } = setup();
  const m = delivery();
  skin.recordDelivered("body", m, { view: "v", params: { bend: 0 } });
  m.positions.fill(99); // the viewer writes into the delivered arrays; the base is a copy
  expect(skin.isDragging()).toBe(false);
  edit({ bend: 40 });
  expect(skin.deform()).toEqual(["body"]);
  const first = Float32Array.from(viewer.setSubVertices.mock.calls[0][1].positions);
  expect(skin.deform()).toEqual(["body"]);
  const second = Float32Array.from(viewer.setSubVertices.mock.calls[1][1].positions);
  expect(second).toEqual(first);
  const expected = skinVertices(
    { ...delivery(), bindings: delivery().bindings },
    frameMotions([TWO_BONE(0)], [TWO_BONE(40)], frames),
    { positions: new Float32Array(18), normals: new Float32Array(18) },
  );
  expect(first).toEqual(expected.positions);
  expect(viewer.setSubVertices.mock.calls[0][2]).toEqual({ deformed: true });
  expect(skin.isDragging()).toBe(true);
  expect(skin.isDeformed("body")).toBe(true);
});

test("a change that is not frames-only restores the base", () => {
  const { skin, viewer, edit } = setup();
  skin.recordDelivered("body", delivery(), { view: "v", params: { bend: 0 } });
  edit({ bend: 30 });
  skin.deform();
  expect(skin.isDeformed("body")).toBe(true);
  edit({ r: 6 }); // a spec value outside frames
  expect(skin.canSkin("body")).toBe(false);
  expect(skin.deform()).toEqual([]);
  const last = viewer.setSubVertices.mock.calls.at(-1);
  expect(last[1].positions).toEqual(delivery().positions);
  expect(last[2]).toEqual({ deformed: false });
  expect(skin.isDeformed("body")).toBe(false);
});

test("a frames-only spec change whose shapeHash differs is not skinnable (base restored)", () => {
  const { skin, viewer, edit } = setup();
  skin.recordDelivered("body", delivery(), { view: "v", params: { bend: 0 } });
  edit({ bend: 30 });
  skin.deform();
  edit({ bend: 35, box: 2 }); // a plain operand changed beside the frame
  expect(skin.canSkin("body")).toBe(false);
  expect(skin.deform()).toEqual([]);
  expect(viewer.setSubVertices.mock.calls.at(-1)[1].positions).toEqual(delivery().positions);
  expect(skin.isDeformed("body")).toBe(false);
});

test("canRebase answers for the params a stale build was dispatched with", () => {
  const { skin, edit } = setup();
  edit({ bend: 50 });
  expect(skin.canRebase("body", { view: "v", params: { bend: 20 } })).toBe(true);
  expect(skin.canRebase("body", { view: "v", params: { bend: 20, r: 5 } })).toBe(false);
  expect(skin.canRebase("body", { view: "v", params: { bend: 20, box: 3 } })).toBe(false);
  expect(skin.canRebase("body", { view: "v", params: { bend: 20, noskin: true } })).toBe(false);
  expect(skin.canRebase("body", null)).toBe(false);
});

test("restoreAll returns the names it restored and endDrag clears the drag", () => {
  const { skin, viewer, edit } = setup();
  skin.recordDelivered("body", delivery(), { view: "v", params: { bend: 0 } });
  expect(skin.restoreAll()).toEqual([]);
  edit({ bend: 10 });
  skin.deform();
  expect(skin.anyDeformed()).toBe(true);
  expect(skin.restoreAll()).toEqual(["body"]);
  expect(viewer.setSubVertices.mock.calls.at(-1)[1].positions).toEqual(delivery().positions);
  expect(skin.anyDeformed()).toBe(false);
  expect(skin.isDragging()).toBe(true);
  skin.endDrag();
  expect(skin.isDragging()).toBe(false);
});

test("the live probe runs once per params version", () => {
  const { skin, probe, edit } = setup();
  skin.recordDelivered("body", delivery(), { view: "v", params: { bend: 0 } });
  const after = probe.mock.calls.length;
  edit({ bend: 10 });
  skin.deform(); skin.deform(); skin.canSkin("body");
  expect(probe.mock.calls.length).toBe(after + 1);
});

test("forget drops the base without touching the viewer", () => {
  const { skin, viewer, edit } = setup();
  skin.recordDelivered("body", delivery(), { view: "v", params: { bend: 0 } });
  edit({ bend: 10 });
  skin.deform();
  const calls = viewer.setSubVertices.mock.calls.length;
  skin.forget("body");
  expect(skin.hasBase("body")).toBe(false);
  expect(skin.anyDeformed()).toBe(false);
  expect(skin.restoreAll()).toEqual([]);
  expect(viewer.setSubVertices.mock.calls.length).toBe(calls);
});

test("while held, deform restores and skins nothing; holds compose and release once", () => {
  const { skin, viewer, edit } = setup();
  skin.recordDelivered("body", delivery(), { view: "v", params: { bend: 0 } });
  edit({ bend: 10 });
  skin.deform();
  const a = skin.hold(), b = skin.hold();
  edit({ bend: 20 });
  expect(skin.deform()).toEqual([]);
  expect(skin.isDeformed("body")).toBe(false);
  expect(viewer.setSubVertices.mock.calls.at(-1)[2]).toEqual({ deformed: false });
  expect(skin.isDragging()).toBe(false);
  a(); a(); // idempotent: b still holds
  expect(skin.isHeld()).toBe(true);
  expect(skin.deform()).toEqual([]);
  b();
  expect(skin.deform()).toEqual(["body"]);
});

test("nothing left deformed ends the drag", () => {
  const { skin, edit } = setup();
  skin.recordDelivered("body", delivery(), { view: "v", params: { bend: 0 } });
  edit({ bend: 10 });
  skin.deform();
  expect(skin.isDragging()).toBe(true);
  edit({ r: 6 });
  skin.deform();
  expect(skin.isDragging()).toBe(false);
});
