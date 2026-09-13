// @vitest-environment happy-dom
// Orchestrator: pointer -> tool state machine -> elements, enter/exit
// lifecycle, payload v3 assembly, and the send-abort-on-null-capture contract.
import { afterEach, describe, expect, it, test, vi } from "vitest";
import * as THREE from "three";
import { createAnnotateMode, ANNOTATION_VERSION } from "../../../src/framework/annotate/annotate-mode.js";
import { annotationRay, rayPlane } from "../../../src/framework/oracle/annotation-ray.js";

afterEach(() => { document.body.innerHTML = ""; });

const RECT = { left: 10, top: 20, width: 200, height: 100 }; // aspect = 2

function fakeCanvas() {
  const element = document.createElement("canvas");
  element.getBoundingClientRect = () => RECT;
  document.body.appendChild(element);
  return {
    element,
    show: vi.fn(),
    hide: vi.fn(),
    setScene: vi.fn(),
    toDataUrl: vi.fn(() => "data:image/png;base64,INK"),
    size: () => ({ width: 400, height: 200, dpr: 2 }),
    dispose: vi.fn(),
  };
}

function fakeViewer(over = {}) {
  const camera = new THREE.PerspectiveCamera(45, 2, 0.1, 1000);
  camera.position.set(0, 0, 10);
  camera.updateMatrixWorld(true);
  // Real 3D canvas overlays the ink canvas at the same rect in production —
  // raycastViewer reads this rect to convert screen coords back to NDC, so a
  // detached default (zero-size) rect would silently NaN out every hit.
  const domElement = document.createElement("canvas");
  domElement.getBoundingClientRect = () => RECT;
  return {
    camera,
    domElement,
    _subMeshes: {},
    getCameraState: () => ({ pos: [0, 0, 10], target: [0, 0, 0] }),
    captureCurrent: vi.fn(() => "data:image/jpeg;base64,MODEL"),
    ...over,
  };
}

function fixture(over = {}) {
  const stage = document.createElement("div");
  document.body.appendChild(stage);
  const canvas = fakeCanvas();
  const viewer = fakeViewer(over.viewer);
  const onSend = vi.fn();
  const mode = createAnnotateMode(viewer, {
    stage,
    getContext: () => ({ view: "main", params: { size: 42 } }),
    onSend,
    createCanvas: () => canvas,
    ...over.opts,
  });
  return { stage, canvas, viewer, onSend, mode };
}

function pointer(type, clientX, clientY, opts = {}) {
  return new MouseEvent(type, { clientX, clientY, bubbles: true, ...opts });
}

// stage-space conversion: RECT height 100 -> stage x = (clientX-10)/100, y = (clientY-20)/100
const drag = (canvas, from, to) => {
  canvas.element.dispatchEvent(pointer("pointerdown", from[0], from[1]));
  canvas.element.dispatchEvent(pointer("pointermove", to[0], to[1]));
  canvas.element.dispatchEvent(pointer("pointerup", to[0], to[1]));
};

const lastScene = (canvas) => canvas.setScene.mock.calls.at(-1)[0];

// Real THREE camera instances, not object literals — the anchors pass in
// send() raycasts through every element regardless of whether any mesh is
// present to hit, and THREE.Raycaster#setFromCamera unprojects through
// camera.matrixWorld / camera.projectionMatrixInverse, which only a real
// camera instance carries (both are populated by the constructor).
function perspectiveCamera() {
  const camera = new THREE.PerspectiveCamera(45, 2, 0.1, 1000);
  camera.position.set(0, 0, 10);
  // No render loop in this headless fixture to update matrixWorld itself
  // (production relies on the viewer's own render each frame) — without
  // this, camera.matrixWorld stays the identity from construction and every
  // raycast (hits, and the embedded anchor rays) originates from world
  // origin instead of the camera's actual position.
  camera.updateMatrixWorld(true);
  return camera;
}

function orthographicCamera() {
  // top/bottom span 40mm of world height at zoom 1, so orthoHeight must read
  // back exactly 40. left/right kept aspect-correct with RECT's 2:1 viewport
  // (±40 for ±20 of height) — annotationRay's reconstruction derives the
  // horizontal half-extent from orthoHeight * viewport.aspect (the payload
  // only carries orthoHeight), so an off-aspect frustum here would place a
  // non-center anchor's embedded ray at a different world x than the
  // reconstruction expects.
  const camera = new THREE.OrthographicCamera(-40, 40, 20, -20, 0.1, 1000);
  camera.position.set(0, 0, 10);
  camera.updateMatrixWorld(true); // see perspectiveCamera()'s comment
  return camera;
}

// Draws one freehand element (default pen tool) under either projection and
// returns the payload the onSend spy received.
function sendOneStroke({ ortho }) {
  const camera = ortho ? orthographicCamera() : perspectiveCamera();
  const { canvas, onSend, mode } = fixture({ viewer: { camera } });
  mode.setEnabled(true);
  drag(canvas, [60, 45], [110, 70]);
  mode.send();
  return { payload: onSend.mock.calls[0][0] };
}

// Same as sendOneStroke, but with a sub-mesh parented under a group, so
// cameraBlock()'s `parts` frame actually populates instead of returning null.
function sendOneStrokeWithParts({ ortho }) {
  const camera = ortho ? orthographicCamera() : perspectiveCamera();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo);
  new THREE.Group().add(mesh); // mesh.parent now has an (identity) matrixWorld to invert
  const { canvas, onSend, mode } = fixture({ viewer: { camera, _subMeshes: { body: mesh } } });
  mode.setEnabled(true);
  drag(canvas, [60, 45], [110, 70]);
  mode.send();
  return { payload: onSend.mock.calls[0][0] };
}

test("pen is the default tool; a drag commits a freehand element", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  expect(canvas.show).toHaveBeenCalled();
  expect(mode.tool()).toBe("pen");
  drag(canvas, [60, 45], [110, 70]);
  expect(mode.strokeCount()).toBe(1);
});

test("rect tool commits center-based params in stage space", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  mode.setTool("rect");
  drag(canvas, [30, 40], [110, 90]); // stage (0.2,0.2) -> (1.0,0.7)
  const scene = lastScene(canvas);
  expect(scene.elements[0].type).toBe("rect");
  expect(scene.elements[0].params.cx).toBeCloseTo(0.6);
  expect(scene.elements[0].params.cy).toBeCloseTo(0.45);
  expect(scene.elements[0].params.w).toBeCloseTo(0.8);
  expect(scene.elements[0].params.h).toBeCloseTo(0.5);
});

test("sub-MIN_DRAG_PX shape drags commit nothing", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  mode.setTool("rect");
  drag(canvas, [60, 45], [62, 46]); // ~2.2px — under the 6px floor
  expect(mode.strokeCount()).toBe(0);
});

test("color selection applies to subsequent elements", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  mode.setColor("green");
  drag(canvas, [60, 45], [110, 70]);
  expect(lastScene(canvas).elements[0].color).toBe("green");
});

test("eraser drag adds gaps; undo restores them away", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  mode.setTool("line");
  drag(canvas, [10, 70], [210, 70]); // full-width line at y=0.5
  mode.setTool("eraser");
  drag(canvas, [110, 60], [110, 80]); // brush through the middle
  const gapped = lastScene(canvas).elements[0];
  expect(gapped.gaps.length).toBe(1);
  mode.undo();
  expect(lastScene(canvas).elements[0].gaps).toEqual([]);
});

test("hand tool moves an element by its outline", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  mode.setTool("line");
  drag(canvas, [10, 70], [210, 70]);
  mode.setTool("hand");
  drag(canvas, [110, 70], [110, 90]); // grab the middle, pull down 0.2 stage
  const moved = lastScene(canvas).elements[0];
  expect(moved.params.y1).toBeCloseTo(0.7);
  expect(moved.params.y2).toBeCloseTo(0.7);
});

test("hand tool resizes a rect from a corner handle", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  mode.setTool("rect");
  drag(canvas, [30, 40], [110, 90]); // cx 0.6 cy 0.45 w 0.8 h 0.5
  mode.setTool("hand");
  // bottom-right corner is at cx+w/2, cy+h/2 = (1.0, 0.7) stage -> client (110,90)
  drag(canvas, [110, 90], [130, 90]); // drag the corner right by 0.2 stage
  const resized = lastScene(canvas).elements[0];
  expect(resized.params.w).toBeCloseTo(1.0);
});

test("send payload is v3: elements with params, erased, description, anchors", () => {
  const { mode, canvas, onSend } = fixture();
  mode.setEnabled(true);
  mode.setTool("rect");
  drag(canvas, [30, 40], [110, 90]);
  expect(mode.send()).toBe(true);
  const payload = onSend.mock.calls[0][0];
  expect(payload.version).toBe(3);
  expect(payload.strokes).toBeUndefined();
  const [rect] = payload.elements;
  expect(rect.id).toBe("e1");
  expect(rect.type).toBe("rect");
  expect(rect.color).toEqual({ name: "red", hex: "#d92d20" });
  expect(rect.erased).toEqual([]);
  expect(rect.visibleFraction).toBe(1);
  expect(rect.description).toContain("rect · c");
  expect(rect.params.rotDeg).toBe(0); // degrees alongside the radian rot
  // top-level orientation for an LLM: summary + the coordinate-frame legend
  expect(payload.summary).toBe(`1 annotation: ${rect.description}`);
  expect(payload.frames["elements[].params"]).toContain("stage space");
  expect(payload.frames["elements[].erased"]).toContain("perimeter clockwise");
  expect(payload.viewport.aspect).toBe(2);
  const center = rect.anchors.find((a) => a.at === "center");
  // anchors are normalized per axis 0..1 (screen frame, as v2)
  expect(center.screen[0]).toBeCloseTo(0.3); // stage 0.6 / aspect 2
  expect(center.screen[1]).toBeCloseTo(0.45);
  expect(center).toHaveProperty("hit");
  // run anchors carry their run index; the whole-shape center does not
  expect(rect.anchors.find((a) => a.at === "start").run).toBe(0);
  expect(center.run).toBeUndefined();
  // camera numbers are rounded to 4 decimals (no float dust for the LLM)
  for (const v of [...payload.camera.world.pos, ...payload.camera.world.up]) {
    expect(v).toBe(+v.toFixed(4));
  }
  expect(payload.images).toEqual({ drawing: expect.any(String), model: "data:image/jpeg;base64,MODEL" });
  // sent -> mode exits and elements clear
  expect(mode.isEnabled()).toBe(false);
  expect(mode.strokeCount()).toBe(0);
});

test("anchors carry no ray when the sketch was sent with no meshes", () => {
  const { payload } = sendOneStroke({ ortho: false }); // fixture has no sub meshes
  expect(payload.camera.parts).toBeNull();
  for (const el of payload.elements) {
    for (const anchor of el.anchors) expect(anchor).not.toHaveProperty("ray");
  }
});

describe("embedded anchor rays", () => {
  for (const ortho of [false, true]) {
    it(`match annotationRay's reconstruction (${ortho ? "orthographic" : "perspective"})`, () => {
      const { payload } = sendOneStrokeWithParts({ ortho });
      expect(payload.frames["elements[].anchors[].ray"]).toContain("parts frame");
      const anchors = payload.elements[0].anchors;
      expect(anchors.length).toBeGreaterThan(0);
      for (const anchor of anchors) {
        expect(anchor.ray).toBeDefined();
        // 4-decimal rounding on both sides; the fixture's integer client coords
        // over the 200×100 rect make every screen value exactly representable,
        // so ortho's aspect-amplified rounding error vanishes — retune the
        // rect and this tolerance needs revisiting
        const rebuilt = annotationRay(payload, anchor);
        for (let i = 0; i < 3; i++) {
          expect(anchor.ray.origin[i]).toBeCloseTo(rebuilt.origin[i], 3);
          expect(anchor.ray.dir[i]).toBeCloseTo(rebuilt.dir[i], 3);
        }
      }
    });
  }
});

test("round trip: an anchor's ray passes through its raycast hit", () => {
  // Aim the stroke so its start lands inside the fixture triangle (vertices
  // (0,0,0)/(1,0,0)/(0,1,0)): at fov 45 / z 10 / aspect 2 the screen band
  // sx ∈ (0.5, 0.56), sy ∈ (0.38, 0.5) projects into the triangle's interior.
  const camera = perspectiveCamera();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo);
  new THREE.Group().add(mesh);
  const { canvas, onSend, mode } = fixture({ viewer: { camera, _subMeshes: { body: mesh } } });
  mode.setEnabled(true);
  drag(canvas, [116, 65], [130, 80]); // start = screen (0.53, 0.45)
  mode.send();
  const payload = onSend.mock.calls[0][0];
  const anchor = payload.elements[0].anchors.find((a) => a.hit);
  expect(anchor, "no anchor hit the fixture triangle — retune the drag").toBeDefined();
  // plane through the hit point, perpendicular to the ray: the intersection
  // must give the hit point back (embedded ray, raycast, and helper agree)
  const back = rayPlane(anchor.ray, { point: anchor.hit.pointLocal, normal: anchor.ray.dir });
  expect(back).not.toBeNull();
  for (let i = 0; i < 3; i++) expect(back.point[i]).toBeCloseTo(anchor.hit.pointLocal[i], 2);
});

test("a circle-shaped ellipse is flagged and collapses to a single radius", () => {
  const { mode, canvas, onSend } = fixture();
  mode.setEnabled(true);
  mode.setTool("ellipse");
  drag(canvas, [30, 30], [50, 50]); // stage (0.2,0.1) -> (0.4,0.3): near-square drag snaps to a circle
  mode.send();
  const [el] = onSend.mock.calls[0][0].elements;
  expect(el.params.circle).toBe(true);
  expect(el.params).toHaveProperty("r");
  expect(el.params).not.toHaveProperty("rx");
});

test("capture size follows the ink bitmap's long edge, under the 2048 bound", () => {
  const { canvas, viewer, mode } = fixture();
  mode.setEnabled(true);
  drag(canvas, [60, 45], [110, 70]);
  mode.send();
  expect(viewer.captureCurrent).toHaveBeenCalledWith({ size: 400 });
});

test("both pictures are bounded to the same long edge", () => {
  // A large hi-DPI stage: unbounded, the ink layer would export at 5120px and
  // the model render would follow it, handing the host two multi-megabyte data
  // URLs to carry somewhere.
  const big = fakeCanvas();
  big.size = () => ({ width: 5120, height: 2560, dpr: 2 });
  const { viewer, onSend, mode } = fixture({ opts: { createCanvas: () => big } });
  mode.setEnabled(true);
  drag(big, [60, 45], [110, 70]);
  expect(mode.send()).toBe(true);
  expect(viewer.captureCurrent).toHaveBeenCalledWith({ size: 2048 });
  expect(big.toDataUrl).toHaveBeenCalledWith({ maxEdge: 2048 });
  expect(onSend).toHaveBeenCalledTimes(1);
});

test("send aborts (elements intact, still enabled) when captureCurrent returns null", () => {
  const { canvas, onSend, mode } = fixture({
    viewer: { captureCurrent: vi.fn(() => null) },
  });
  mode.setEnabled(true);
  drag(canvas, [60, 45], [110, 70]);
  expect(mode.send()).toBe(false);
  expect(onSend).not.toHaveBeenCalled();
  expect(mode.isEnabled()).toBe(true);
  expect(mode.strokeCount()).toBe(1);
});

test("send with no elements is a no-op", () => {
  const { onSend, mode } = fixture();
  mode.setEnabled(true);
  expect(mode.send()).toBe(false);
  expect(onSend).not.toHaveBeenCalled();
});

test("payload params are a snapshot, not the live object", () => {
  const params = { size: 1 };
  const { canvas, onSend, mode } = fixture({
    opts: { getContext: () => ({ view: "main", params }) },
  });
  mode.setEnabled(true);
  drag(canvas, [60, 45], [110, 70]);
  mode.send();
  params.size = 2;
  expect(onSend.mock.calls[0][0].context.params.size).toBe(1);
});

test("setEnabled(false) discards elements and hides the canvas", () => {
  const { canvas, mode } = fixture();
  mode.setEnabled(true);
  drag(canvas, [60, 45], [110, 70]);
  mode.setEnabled(false);
  expect(mode.strokeCount()).toBe(0);
  expect(canvas.hide).toHaveBeenCalled();
});

test("escape-like cancel: setEnabled(false) mid-gesture discards everything", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  canvas.element.dispatchEvent(pointer("pointerdown", 60, 45));
  mode.setEnabled(false);
  mode.setEnabled(true);
  expect(mode.strokeCount()).toBe(0);
});

test("tool and color persist across an enable/disable cycle", () => {
  const { mode } = fixture();
  mode.setEnabled(true);
  mode.setTool("rect");
  mode.setColor("blue");
  mode.setEnabled(false);
  mode.setEnabled(true);
  expect(mode.tool()).toBe("rect");
  expect(mode.color()).toBe("blue");
});

test("onToolChange fires for tool and color changes", () => {
  const { mode } = fixture();
  let calls = 0;
  mode.onToolChange(() => { calls += 1; });
  mode.setTool("rect");
  mode.setColor("blue");
  mode.setTool("rect"); // no-op: unchanged
  expect(calls).toBe(2);
});

test("canUndo tracks the store's history", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  expect(mode.canUndo()).toBe(false);
  drag(canvas, [60, 45], [110, 70]);
  expect(mode.canUndo()).toBe(true);
});

// The ink canvas is never focusable (no tabindex), so a real Escape keystroke
// never lands on canvas.element — it lands wherever focus actually is and
// only reaches this mode via a capture-phase listener on the document. These
// tests dispatch on `document`, bubbles+cancelable like a real keydown, and
// read `defaultPrevented` to prove whether the mode itself consumed the
// event. The mode now owns Escape-driven exit outright (mid-gesture, Escape
// cancels only the gesture; with none in flight, it exits the mode) and
// always consumes the keystroke when enabled, so downstream chrome never
// sees a sketch-mode Escape.
const escapeKey = () => new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });

test("Escape cancels a hand-tool drag by undoing it, without exiting the mode", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  mode.setTool("line");
  drag(canvas, [10, 70], [210, 70]); // y = 0.5 both ends
  mode.setTool("hand");
  canvas.element.dispatchEvent(pointer("pointerdown", 110, 70));
  canvas.element.dispatchEvent(pointer("pointermove", 110, 90));
  const evt = escapeKey();
  document.dispatchEvent(evt);
  expect(evt.defaultPrevented).toBe(true); // a gesture was in flight: the mode consumed it
  const el = lastScene(canvas).elements[0];
  expect(el.params.y1).toBeCloseTo(0.5);
  expect(el.params.y2).toBeCloseTo(0.5);
  expect(mode.isEnabled()).toBe(true); // only the gesture was cancelled, not the whole sketch
});

test("Escape during a shape drag drops the preview without committing", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  mode.setTool("rect");
  canvas.element.dispatchEvent(pointer("pointerdown", 30, 40));
  canvas.element.dispatchEvent(pointer("pointermove", 110, 90));
  const evt = escapeKey();
  document.dispatchEvent(evt);
  expect(evt.defaultPrevented).toBe(true);
  expect(mode.strokeCount()).toBe(0);
  expect(mode.isEnabled()).toBe(true);
  canvas.element.dispatchEvent(pointer("pointerup", 110, 90));
  expect(mode.strokeCount()).toBe(0); // gesture already cancelled: pointerup is a no-op
});

test("Escape during a pen stroke rolls back the partial stroke, leaving no stray snapshot", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  expect(mode.canUndo()).toBe(false);
  canvas.element.dispatchEvent(pointer("pointerdown", 60, 45));
  canvas.element.dispatchEvent(pointer("pointermove", 110, 70));
  const evt = escapeKey();
  document.dispatchEvent(evt);
  expect(evt.defaultPrevented).toBe(true);
  expect(mode.strokeCount()).toBe(0); // rolled back to its pre-gesture value
  expect(mode.canUndo()).toBe(false); // the snapshot taken at pointerdown was popped, not left behind
});

test("Escape with no in-flight gesture exits the mode and IS consumed", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  drag(canvas, [60, 45], [110, 70]); // pen stroke commits normally; no gesture left in flight
  expect(mode.strokeCount()).toBe(1); // committed normally: nothing to cancel
  const evt = escapeKey();
  document.dispatchEvent(evt);
  // Sketch mode owns exit now: while it's on, the toolbar replaces #viewbar
  // (mount.js) so the pencil toggle that used to hold the chrome's own
  // Escape handler is hidden and unreachable. This document-capture listener
  // is the only reliable keyboard path left, so it exits the mode itself and
  // consumes the event — downstream chrome (cutaway/measure Escape handlers)
  // must never also see a sketch-mode Escape.
  expect(evt.defaultPrevented).toBe(true);
  expect(mode.isEnabled()).toBe(false);
  // setEnabled(false) resets the store (spec: ink never survives an exit),
  // so the stroke is gone too — that's the existing exit contract, not
  // something this Escape path rolled back.
  expect(mode.strokeCount()).toBe(0);
});

test("Escape typed into a host composer field does not exit the mode or touch the drawing", () => {
  // partforge-cloud shows its own composer (an <input>/<textarea>) over the
  // stage while sketch mode is enabled. A user typing a note there and
  // pressing Escape to, say, clear the field must not also reach this
  // mode's document-capture listener as an exit request — setEnabled(false)
  // calls store.reset(), which would discard the whole drawing.
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  drag(canvas, [60, 45], [110, 70]); // one committed stroke, no gesture in flight
  expect(mode.strokeCount()).toBe(1);
  const input = document.createElement("input");
  document.body.appendChild(input);
  const evt = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  input.dispatchEvent(evt);
  expect(evt.defaultPrevented).toBe(false); // guard returned without consuming
  expect(mode.isEnabled()).toBe(true); // still in sketch mode
  expect(mode.strokeCount()).toBe(1); // drawing untouched
});

test("detach disposes the canvas and is idempotent", () => {
  const { canvas, mode } = fixture();
  mode.setEnabled(true);
  mode.detach();
  mode.detach();
  expect(canvas.dispose).toHaveBeenCalledTimes(1);
});

test("detach while enabled leaves the state machine honest", () => {
  const { canvas, mode } = fixture();
  mode.setEnabled(true);
  mode.detach();
  expect(mode.isEnabled()).toBe(false);
  expect(canvas.hide).toHaveBeenCalled();
  expect(canvas.dispose).toHaveBeenCalledTimes(1);
});

test("ink-canvas cursor classes follow tool, hover, and drag state", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  mode.setTool("line");
  drag(canvas, [10, 70], [210, 70]); // a line at y=0.5, full width
  mode.setTool("hand");
  expect(canvas.element.classList.contains("hand")).toBe(true);
  // hover the outline (no gesture): "over"
  canvas.element.dispatchEvent(pointer("pointermove", 110, 70));
  expect(canvas.element.classList.contains("over")).toBe(true);
  expect(canvas.element.classList.contains("dragging")).toBe(false);
  // grab it and drag: "dragging" replaces "over"
  canvas.element.dispatchEvent(pointer("pointerdown", 110, 70));
  canvas.element.dispatchEvent(pointer("pointermove", 110, 90));
  expect(canvas.element.classList.contains("dragging")).toBe(true);
  expect(canvas.element.classList.contains("over")).toBe(false);
  canvas.element.dispatchEvent(pointer("pointerup", 110, 90));
  expect(canvas.element.classList.contains("dragging")).toBe(false);
  // eraser tool: "erasing", no "hand"
  mode.setTool("eraser");
  expect(canvas.element.classList.contains("erasing")).toBe(true);
  expect(canvas.element.classList.contains("hand")).toBe(false);
});

test("onModeChange fires on enable and disable", () => {
  const { mode } = fixture();
  const cb = vi.fn();
  mode.onModeChange(cb);
  mode.setEnabled(true);
  mode.setEnabled(false);
  expect(cb).toHaveBeenCalledTimes(2);
});

test("a mode listener that throws does not silence the listeners after it", () => {
  // Listeners are registered in mount order: partforge's own first, the host
  // application's relay last. One throwing listener used to abort the loop,
  // so the host was never told the mode changed — and the throw escaped
  // setEnabled(false) inside send(), AFTER the ink had been discarded.
  const { mode } = fixture();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const later = vi.fn();
  mode.onModeChange(() => { throw new Error("boom"); });
  mode.onModeChange(later);
  expect(() => mode.setEnabled(true)).not.toThrow();
  expect(later).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalled();
  error.mockRestore();
});

describe("camera block under each projection", () => {
  it("is version 3 and reports a perspective camera by name", () => {
    // A consumer reconstructing the camera must be told which projection it is
    // looking at — an fov-shaped hole is how that fails silently.
    const { payload } = sendOneStroke({ ortho: false });
    expect(payload.version).toBe(ANNOTATION_VERSION);
    expect(payload.camera.world.projection).toBe("perspective");
    expect(payload.camera.world.fov).toBe(45);
    expect(payload.camera.world.orthoHeight).toBeNull();
  });

  it("reports an orthographic camera with its frustum height and no fov", () => {
    const { payload } = sendOneStroke({ ortho: true });
    expect(payload.camera.world.projection).toBe("orthographic");
    expect(payload.camera.world.fov).toBeNull();
    expect(payload.camera.world.orthoHeight).toBeCloseTo(40, 6);
  });

  // `parts` is the durable frame — pinned to the CAD geometry so it survives
  // a later rebuild's per-view recentring. A consumer re-referencing a sketch
  // against an updated model reads THIS frame, so it needs the same
  // projection/orthoHeight/fov as `world`, not just a copy of `fov` (which
  // would leave an ortho payload's parts frame with a null and no explanation).
  it("parts frame agrees with world on projection/fov/orthoHeight under perspective", () => {
    const { payload } = sendOneStrokeWithParts({ ortho: false });
    expect(payload.camera.parts).not.toBeNull(); // guards the assertions below against a no-op
    expect(payload.camera.parts.projection).toBe("perspective");
    expect(payload.camera.parts.fov).toBe(45);
    expect(payload.camera.parts.orthoHeight).toBeNull();
  });

  it("parts frame agrees with world on projection/fov/orthoHeight under orthographic", () => {
    const { payload } = sendOneStrokeWithParts({ ortho: true });
    expect(payload.camera.parts).not.toBeNull();
    expect(payload.camera.parts.projection).toBe("orthographic");
    expect(payload.camera.parts.fov).toBeNull();
    expect(payload.camera.parts.orthoHeight).toBeCloseTo(40, 6);
  });
});
