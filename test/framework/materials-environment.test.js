// test/framework/materials-environment.test.js
import * as THREE from "three";
import { expect, test, vi } from "vitest";

vi.mock("../../src/framework/materials/contact-shadow.js", () => ({
  createContactShadow: () => ({ group: new THREE.Group(), render: vi.fn(), setSize: vi.fn(), dispose: vi.fn() }),
}));
const { loadEnvironmentRig } = await import("../../src/framework/materials/environment.js");

const fakeRenderer = () => ({});
const pmrem = { fromEquirectangular: () => ({ texture: new THREE.Texture() }), dispose: vi.fn() };

test("a rig carries its exposure, env map and a ground at the requested height", async () => {
  const rig = await loadEnvironmentRig(fakeRenderer(), "workshop", {
    loadHdr: async () => new THREE.DataTexture(), loadTexture: () => new THREE.Texture(), pmrem,
  });
  expect(rig.id).toBe("workshop");
  expect(rig.exposure).toBeCloseTo(1.1);
  expect(rig.envMap).toBeInstanceOf(THREE.Texture);
  rig.setGround({ y: -12, centerX: 3, centerZ: 4, radius: 50 });
  expect(rig.ground.position.y).toBeCloseTo(-12, 1);
  expect(rig.ground.position.x).toBeCloseTo(3);
  expect(rig.ground.scale.x).toBeGreaterThanOrEqual(50 * 4);
  rig.dispose();
});

test("an unknown id loads studio", async () => {
  const rig = await loadEnvironmentRig(fakeRenderer(), "moon", { loadHdr: async () => new THREE.DataTexture(), loadTexture: () => new THREE.Texture(), pmrem });
  expect(rig.id).toBe("studio");
});

test("a failed HDR load rejects (the viewer then stays in CAD)", async () => {
  await expect(loadEnvironmentRig(fakeRenderer(), "studio", {
    loadHdr: async () => { throw new Error("404"); }, loadTexture: () => new THREE.Texture(), pmrem,
  })).rejects.toThrow("404");
});
