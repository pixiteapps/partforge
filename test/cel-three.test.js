import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { buildCelMaterial } from "../src/framework/cel/cel-material.js";
import { createCelInk, CEL_LAYER } from "../src/framework/cel/cel-ink.js";
import { createCelGround } from "../src/framework/cel/cel-ground.js";
import { CEL, celTones } from "../src/framework/cel/cel-style.js";

describe("buildCelMaterial", () => {
  it("is a clipping-capable ShaderMaterial that writes sRGB and exposes its lit colour", () => {
    const m = buildCelMaterial({ color: 0xe8442c });
    expect(m.isShaderMaterial && m.userData.pfCel && m.clipping).toBe(true);
    expect(m.fragmentShader).toContain("#include <colorspace_fragment>");
    expect(m.fragmentShader).toContain("#include <clipping_planes_fragment>");
    expect(m.vertexShader).toContain("#include <clipping_planes_vertex>");
    expect(m.color.getHex()).toBe(celTones(0xe8442c).lit);
    expect(m.uniforms.uShadow.value.getHex()).toBe(celTones(0xe8442c).shadow);
    expect(m.transparent).toBe(false);
  });
  it("a ghost is transparent with depthWrite off, like the CAD material", () => {
    const m = buildCelMaterial({ color: 0xffffff, opacity: 0.4 });
    expect(m.transparent).toBe(true); expect(m.opacity).toBe(0.4); expect(m.depthWrite).toBe(false);
  });
  it("a clone keeps its tones (the cutaway and fades clone it)", () => {
    const c = buildCelMaterial({ color: 0x3366cc }).clone();
    expect(c.uniforms.uLit.value.getHex()).toBe(celTones(0x3366cc).lit);
    expect(c.userData.pfCel).toBe(true);
  });
});
describe("createCelInk", () => {
  it("constructs, names the sub-part layer, and disposes", () => {
    const ink = createCelInk();
    expect(CEL_LAYER).toBe(1);
    expect(typeof ink.render).toBe("function");
    expect(() => ink.dispose()).not.toThrow();
  });
});
function stubRenderer(buffer, bound = null) {
  const calls = [];
  let current = bound;
  return {
    calls, autoClear: true,
    getRenderTarget: () => current,
    setRenderTarget: (t) => { current = t; calls.push(["set", t]); },
    getDrawingBufferSize: (v) => v.set(buffer[0], buffer[1]),
    getClearColor: (c) => c.set(0x123456), getClearAlpha: () => 0.5, setClearColor: () => {}, clear: () => {},
    render: (scene) => calls.push(["render", scene, current]),
  };
}
describe("createCelInk render", () => {
  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera();
  it("draws the quad into the target that was bound, and restores it", () => {
    const bound = { width: 64, height: 48 };
    const r = stubRenderer([800, 600], bound);
    const ink = createCelInk();
    ink.render(r, scene, cam, { pixelScale: 1, field: null });
    const renders = r.calls.filter((c) => c[0] === "render");
    expect(renders).toHaveLength(2);
    expect(renders[1][2]).toBe(bound);
    expect(r.calls.at(-1)).toEqual(["set", bound]);
    ink.dispose();
  });
  it("skips a 1x1 drawing buffer entirely", () => {
    const r = stubRenderer([1, 1]);
    const ink = createCelInk();
    ink.render(r, scene, cam, {});
    expect(r.calls).toEqual([]);
    ink.dispose();
  });
});
describe("createCelGround", () => {
  it("fit ignores an empty box", () => {
    const g = createCelGround({ mapSize: 1024 });
    g.fit(new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1)));
    const pos = g.plane.position.clone(), far = g.light.shadow.camera.far;
    g.fit(new THREE.Box3());
    expect(g.plane.position.equals(pos)).toBe(true);
    expect(g.light.shadow.camera.far).toBe(far);
  });
  const bounds = new THREE.Box3(new THREE.Vector3(-10, 0, -20), new THREE.Vector3(10, 30, 20));
  const R = bounds.getSize(new THREE.Vector3()).length() / 2;
  it("fits the plane under the bounds, inside the shadow frustum, with the slab per spec", () => {
    const g = createCelGround({ mapSize: 2048 });
    g.fit(bounds);
    expect(g.plane.position.y).toBeCloseTo(0 - 1e-3 * R, 5);
    expect(g.plane.geometry.parameters.width).toBeCloseTo((2 * CEL.ground.frustumR * R) / Math.SQRT2 * CEL.ground.planeFill, 5);
    const sc = g.light.shadow.camera;
    expect([sc.right, sc.near, sc.far]).toEqual([CEL.ground.frustumR * R, CEL.ground.nearR * R, CEL.ground.farR * R]);
    expect(g.light.shadow.radius).toBeCloseTo(CEL.ground.penumbra * 2048 / (2 * CEL.ground.frustumR), 5);
    expect(g.plane.material.side).toBe(THREE.FrontSide);
    expect(g.light.intensity).toBe(0);
  });
  it("the plane's corners stay inside the map under every azimuth", () => {
    const g = createCelGround({ mapSize: 1024 });
    g.fit(bounds);
    const cam = new THREE.PerspectiveCamera(); cam.position.set(50, 40, 50); cam.lookAt(0, 15, 0); cam.updateMatrixWorld();
    const half = g.plane.geometry.parameters.width / 2;
    for (let az = -180; az < 180; az += 10) {
      g.aim(cam, { azimuthDeg: az, elevationDeg: CEL.ground.elevationDeg });
      g.light.shadow.camera.updateMatrixWorld(); g.light.shadow.updateMatrices(g.light);
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const p = new THREE.Vector3(g.plane.position.x + sx * half, g.plane.position.y, g.plane.position.z + sz * half)
          .applyMatrix4(g.light.shadow.camera.matrixWorldInverse).applyMatrix4(g.light.shadow.camera.projectionMatrix);
        expect(Math.abs(p.x)).toBeLessThan(1); expect(Math.abs(p.y)).toBeLessThan(1); expect(Math.abs(p.z)).toBeLessThan(1);
      }
    }
  });
  it("clamps the light's world elevation to 40° from a top-down camera", () => {
    const g = createCelGround({ mapSize: 1024 });
    g.fit(bounds);
    const cam = new THREE.PerspectiveCamera(); cam.position.set(0, 200, 0); cam.up.set(0, 0, -1); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
    g.aim(cam, { azimuthDeg: -35, elevationDeg: 60 });
    const d = g.light.position.clone().sub(g.light.target.position).normalize();
    expect(Math.asin(d.y) * 180 / Math.PI).toBeGreaterThanOrEqual(CEL.ground.minWorldElevationDeg - 1e-6);
  });
});
