// The shared gizmo module (src/framework/gizmo/): the hover rule, centre-vs-proxy
// picking order and the rotate-drag math, used by the cutaway control and Pose mode's
// aim gizmo.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  GIZMO_PALETTE,
  HANDLE_HOVER_THICKNESS,
  HANDLE_HOVER_WHITE_MIX,
  applyHandleAppearance,
  handleMaterial,
  hitMaterial,
  hoverGeometryPair,
} from "../../src/framework/gizmo/gizmo-handles.js";
import { pickGizmoHandle } from "../../src/framework/gizmo/gizmo-pick.js";
import {
  SCREEN_ROTATION_RADIANS_PER_PIXEL,
  beginRotateDrag,
  rotateDragAngle,
} from "../../src/framework/gizmo/gizmo-rotate.js";
import { CUTAWAY_GIZMO_THEMES } from "../../src/framework/cutaway-gizmo.js";

function ringHandle(color) {
  const pair = hoverGeometryPair((k) => new THREE.TorusGeometry(1, 0.05 * k, 4, 16));
  const material = handleMaterial(color);
  const mesh = new THREE.Mesh(pair.normal, material);
  return { pair, material, mesh, entry: { visual: mesh, material, geometryPairs: [{ mesh, ...pair }] } };
}

describe("handle appearance", () => {
  it("builds the hovered twin thicker by HANDLE_HOVER_THICKNESS", () => {
    const { pair } = ringHandle(0xff0000);
    expect(pair.normal.parameters.tube).toBeCloseTo(0.05, 12);
    expect(pair.hovered.parameters.tube).toBeCloseTo(0.05 * HANDLE_HOVER_THICKNESS, 12);
  });

  it("hovered: lifts the colour toward white, swaps to the thick twin, full opacity", () => {
    const red = GIZMO_PALETTE.dark.red;
    const { pair, material, mesh, entry } = ringHandle(red);
    applyHandleAppearance(entry, { color: red, hovered: false, idleOpacity: 0.48 });
    expect(material.color.getHex()).toBe(red);
    expect(material.opacity).toBe(0.48);
    expect(mesh.geometry).toBe(pair.normal);

    applyHandleAppearance(entry, { color: red, hovered: true, idleOpacity: 0.48 });
    const want = new THREE.Color(red).lerp(new THREE.Color(0xffffff), HANDLE_HOVER_WHITE_MIX);
    expect(material.color.equals(want)).toBe(true);
    expect(material.opacity).toBe(1);
    expect(mesh.geometry).toBe(pair.hovered);

    applyHandleAppearance(entry, { color: red, hovered: false });
    expect(material.color.getHex()).toBe(red);
    expect(material.opacity).toBe(1); // idleOpacity defaults to 1
    expect(mesh.geometry).toBe(pair.normal);
  });

  it("is the cutaway's palette: translate green, X ring red, Y ring blue", () => {
    for (const mode of ["dark", "light"]) {
      const p = GIZMO_PALETTE[mode];
      expect(CUTAWAY_GIZMO_THEMES[mode]).toEqual({
        fill: p.fill, border: p.border, translate: p.green, rotateX: p.red, rotateY: p.blue,
      });
    }
  });
});

describe("pickGizmoHandle", () => {
  // A ring about the view axis whose band passes through the centre's pick radius:
  // looking down -Z at a torus of radius 1 lying across the view (axis +X), so it
  // projects to a vertical line through the centre.
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.2, 8, 32), hitMaterial());
  ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0));
  ring.userData.part = "ring";
  ring.updateMatrixWorld(true);
  const raycaster = new THREE.Raycaster();
  const pickAt = (ndc, centerFirst) => {
    raycaster.setFromCamera(ndc, camera);
    // screen space here: NDC * 100 px
    return pickGizmoHandle({
      raycaster,
      proxies: [ring],
      handleOf: (hit) => hit?.object?.userData.part ?? null,
      pointer: { x: ndc.x * 100, y: ndc.y * 100 },
      center: { x: 0, y: 0 },
      centerRadiusPx: 10,
      centerHandle: "center",
      centerFirst,
    });
  };
  // the ring's projection runs up the screen through the centre: (0, 0.06) is on it
  const onRingNearCenter = { x: 0, y: 0.06 };

  it("centerFirst: the centre wins over a ring that crosses it", () => {
    expect(pickAt(onRingNearCenter, true)).toBe("center");
  });

  it("proxies first (the cutaway's order): the ring wins, the centre only where no proxy is", () => {
    expect(pickAt(onRingNearCenter, false)).toBe("ring");
    expect(pickAt({ x: 0.06, y: 0 }, false)).toBe("center"); // off the ring, inside the radius
  });

  it("centerOf: the centre is projected only when it is consulted (a proxy miss)", () => {
    let calls = 0;
    const pick = (ndc) => {
      raycaster.setFromCamera(ndc, camera);
      return pickGizmoHandle({
        raycaster, proxies: [ring], handleOf: (hit) => hit?.object?.userData.part ?? null,
        pointer: { x: ndc.x * 100, y: ndc.y * 100 },
        centerOf: () => { calls++; return { x: 0, y: 0 }; },
        centerRadiusPx: 10, centerHandle: "center",
      });
    };
    expect(pick(onRingNearCenter)).toBe("ring");
    expect(calls).toBe(0);
    expect(pick({ x: 0.06, y: 0 })).toBe("center");
    expect(calls).toBe(1);
  });

  it("misses: neither ring nor centre", () => {
    expect(pickAt({ x: 0.5, y: 0 }, true)).toBeNull();
    expect(pickAt({ x: 0.5, y: 0 }, false)).toBeNull();
  });

  it("a ring point away from the centre picks the ring either way", () => {
    expect(pickAt({ x: 0, y: 0.15 }, true)).toBe("ring");
  });
});

describe("rotate drag", () => {
  const center = new THREE.Vector3(0, 0, 0);
  const rayTo = (p) => new THREE.Ray(new THREE.Vector3(p.x, p.y, 10), new THREE.Vector3(0, 0, -1));
  // a plain orthographic-ish projection: x right, y down, 10 px per unit
  const project = (v) => new THREE.Vector2(v.x * 10, -v.y * 10);

  it("looking down the axis: the turn of the radial, signed about the axis", () => {
    const axis = new THREE.Vector3(0, 0, 1);
    const drag = beginRotateDrag({ ray: rayTo({ x: 1, y: 0 }), center, axis, alignment: 1, projectToClient: project });
    expect(drag.mode).toBe("plane-rotate");
    const a = rotateDragAngle(drag, { ray: rayTo({ x: 0, y: 1 }), center, axis, pointerDelta: new THREE.Vector2() });
    expect(a).toBeCloseTo(Math.PI / 2, 9);
    // about -Z the same pointer path is a negative turn
    const neg = beginRotateDrag({ ray: rayTo({ x: 1, y: 0 }), center, axis: axis.clone().negate(), alignment: 1, projectToClient: project });
    expect(rotateDragAngle(neg, { ray: rayTo({ x: 0, y: 1 }), center, axis: axis.clone().negate(), pointerDelta: new THREE.Vector2() })).toBeCloseTo(-Math.PI / 2, 9);
  });

  it("unwrap keeps counting past 180 degrees; without it the angle wraps", () => {
    const axis = new THREE.Vector3(0, 0, 1);
    const go = (unwrap) => {
      const drag = beginRotateDrag({ ray: rayTo({ x: 1, y: 0 }), center, axis, alignment: 1, projectToClient: project });
      let a = 0;
      for (let deg = 30; deg <= 270; deg += 30) {
        const t = (deg * Math.PI) / 180;
        a = rotateDragAngle(drag, { ray: rayTo({ x: Math.cos(t), y: Math.sin(t) }), center, axis, pointerDelta: new THREE.Vector2(), unwrap });
      }
      return (a * 180) / Math.PI;
    };
    expect(go(true)).toBeCloseTo(270, 6);
    expect(go(false)).toBeCloseTo(-90, 6);
  });

  it("edge-on: pointer travel across the on-screen axis turns it", () => {
    const axis = new THREE.Vector3(0, 1, 0); // up the screen: travel along x turns it
    const drag = beginRotateDrag({ ray: rayTo({ x: 1, y: 0 }), center, axis, alignment: 0, projectToClient: project });
    expect(drag.mode).toBe("screen-rotate");
    const a = rotateDragAngle(drag, { center, axis, pointerDelta: new THREE.Vector2(120, 0) });
    expect(Math.abs(a)).toBeCloseTo(120 * SCREEN_ROTATION_RADIANS_PER_PIXEL, 9);
    expect(Math.abs(a)).toBeCloseTo(Math.PI / 2, 9);
    expect(rotateDragAngle(drag, { center, axis, pointerDelta: new THREE.Vector2(0, 50) })).toBeCloseTo(0, 9);
  });

  it("aborts when the axis has no on-screen direction and the plane is unusable", () => {
    const axis = new THREE.Vector3(0, 0, 1);
    const drag = beginRotateDrag({ ray: rayTo({ x: 0, y: 0 }), center, axis, alignment: 1, projectToClient: project });
    expect(drag).toBeNull(); // the ray hits the centre: no radial, and +Z projects to a point
  });
});
