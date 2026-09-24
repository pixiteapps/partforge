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
  expect(rig.exposure).toBeCloseTo(0.88);
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

// The equirect HDR is ~16 MB of half-float. A gradient backdrop (studio) only
// needs it for the PMREM filter, so it goes as soon as that is done; a blurred
// backdrop draws it, so it lives as long as the rig. Either way it is freed once.
test("a gradient-backdrop rig frees its HDR right after filtering it, and only once", async () => {
  const hdr = new THREE.DataTexture();
  const dispose = vi.spyOn(hdr, "dispose");
  const filtered = [];
  const rig = await loadEnvironmentRig(fakeRenderer(), "studio", {
    loadHdr: async () => hdr, loadTexture: () => new THREE.Texture(),
    pmrem: { fromEquirectangular: (t) => { filtered.push(t); expect(dispose).not.toHaveBeenCalled(); return { texture: new THREE.Texture() }; } },
  });
  expect(filtered).toEqual([hdr]);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(rig.background).not.toBe(hdr);
  rig.dispose();
  expect(dispose).toHaveBeenCalledTimes(1);
});

test("a blurred-backdrop rig keeps its HDR as the background until the rig is disposed", async () => {
  const hdr = new THREE.DataTexture();
  const dispose = vi.spyOn(hdr, "dispose");
  const rig = await loadEnvironmentRig(fakeRenderer(), "workshop", {
    loadHdr: async () => hdr, loadTexture: () => new THREE.Texture(), pmrem,
  });
  expect(rig.background).toBe(hdr);
  expect(dispose).not.toHaveBeenCalled();
  rig.dispose();
  expect(dispose).toHaveBeenCalledTimes(1);
});

test("the ground texture repeats per tileMm when set, so studio paper grain is finer than the disc's size", async () => {
  const tex = new THREE.Texture();
  const rig = await loadEnvironmentRig(fakeRenderer(), "studio", {
    loadHdr: async () => new THREE.DataTexture(), loadTexture: () => tex, pmrem,
  });
  rig.setGround({ y: 0, radius: 10 });
  // disc is max(10*4, 400/2)=200 mm radius → 400 mm across; tileMm 200 → 2 repeats
  expect(tex.repeat.x).toBeCloseTo(2);
  rig.dispose();
});
