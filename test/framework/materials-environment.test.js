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

// The equirect HDR is ~16 MB of half-float; every backdrop draws it, so it
// lives as long as the rig and is freed exactly once.
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

test("studio shows its own blurred photo, turned so the softboxes sit behind the part", async () => {
  const rig = await loadEnvironmentRig(fakeRenderer(), "studio", {
    loadHdr: async () => new THREE.DataTexture(), loadTexture: () => new THREE.Texture(), pmrem,
  });
  expect(rig.background).toBeInstanceOf(THREE.Texture);
  expect(rig.backgroundBlurriness).toBeCloseTo(0.3);
  expect(rig.rotationY).toBeCloseTo((300 * Math.PI) / 180);
  rig.dispose();
});

test("an environment without rotation or blur settings keeps the defaults", async () => {
  const rig = await loadEnvironmentRig(fakeRenderer(), "workshop", {
    loadHdr: async () => new THREE.DataTexture(), loadTexture: () => new THREE.Texture(), pmrem,
  });
  expect(rig.rotationY).toBe(0);
  expect(rig.backgroundBlurriness).toBeCloseTo(0.6);
  rig.dispose();
});

// The workshop floor is unfinished maple: a colour map (sRGB) and a normal map
// (raw data, never sRGB-decoded; OpenGL-format, so normalScale stays positive),
// and deliberately NO roughness map — a flat, matte roughness so it never shows
// a glossy spot.
test("the workshop floor is matte maple: colour + gentle normal map, no roughness map", async () => {
  const loaded = {};
  const rig = await loadEnvironmentRig(fakeRenderer(), "workshop", {
    loadHdr: async () => new THREE.DataTexture(), loadTexture: (f) => (loaded[f] = new THREE.Texture()), pmrem,
  });
  const m = rig.ground.material;
  expect(m.map).toBe(loaded["ground-maple-color.jpg"]);
  expect(m.map.colorSpace).toBe(THREE.SRGBColorSpace);
  expect(m.normalMap).toBe(loaded["ground-maple-normal.jpg"]);
  expect(m.normalMap.colorSpace).toBe(THREE.NoColorSpace);
  expect(m.normalScale.x).toBeCloseTo(0.8);
  expect(m.roughnessMap).toBeNull();
  expect(m.roughness).toBeGreaterThanOrEqual(0.9);
  rig.setGround({ y: 0, radius: 10 });
  expect(m.normalMap.repeat.x).toBeCloseTo(m.map.repeat.x);
  rig.dispose();
});

// The studio paper's grain is in its relief (its colour map is nearly flat):
// normal + roughness maps and a detail layer, so it stays crisp up close.
test("the studio paper carries its fibre relief and a detail layer", async () => {
  const loaded = {};
  const rig = await loadEnvironmentRig(fakeRenderer(), "studio", {
    loadHdr: async () => new THREE.DataTexture(), loadTexture: (f) => (loaded[f] = new THREE.Texture()), pmrem,
  });
  const m = rig.ground.material;
  expect(m.normalMap).toBe(loaded["ground-paper-normal.jpg"]);
  expect(m.roughnessMap).toBe(loaded["ground-paper-rough.jpg"]);
  expect(m.customProgramCacheKey()).toBe("pf-ground-detail");
  rig.dispose();
});

// The print bed is a cut-out, standard-size build plate under a harsh overhead
// light, not a disc fading into the backdrop.
test("the print bed is a plate sized to the part's footprint, with a hard key light and a dimmed backdrop", async () => {
  const rig = await loadEnvironmentRig(fakeRenderer(), "print-bed", {
    loadHdr: async () => new THREE.DataTexture(), loadTexture: () => new THREE.Texture(), pmrem, createCanvas: () => null,
  });
  expect(rig.ground).toBeInstanceOf(THREE.Group);
  expect(rig.backgroundIntensity).toBeLessThan(1);
  // The key light is NOT a child of the bed group — updateForCamera hides
  // that whole group from below, and a hidden parent would take its light
  // down with it. It rides on the rig's own `lights` array instead.
  expect(rig.ground.children.find((c) => c.isDirectionalLight)).toBeUndefined();
  const [key] = rig.lights;
  expect(key.isDirectionalLight).toBe(true);
  expect(key.intensity).toBeGreaterThan(0);
  // its target still tracks the bed for free, as a child of the (possibly
  // hidden) group: matrixWorld updates run regardless of .visible
  expect(key.target.parent).toBe(rig.ground);
  rig.setGround({ y: -3, centerX: 1, centerZ: 2, radius: 150, footprintMm: 170 });
  expect(rig.ground.position.y).toBeCloseTo(-3, 1);
  // the light itself moved to keep its fixed offset off the bed's new origin
  expect(key.position.x).toBeCloseTo(1 + 0.4);
  expect(key.position.z).toBeCloseTo(2 + 0.6);
  const plate = rig.ground.children.find((c) => c.isMesh && Array.isArray(c.material));
  plate.geometry.computeBoundingBox();
  expect(plate.geometry.boundingBox.max.x - plate.geometry.boundingBox.min.x).toBeCloseTo(220);
  // the contact shadow never hangs off the plate's edge
  expect(rig.shadow.setSize.mock.calls.at(-1)[0]).toBeLessThanOrEqual(220);
  rig.dispose();
});

test("the print bed rig exposes updateForCamera, delegating to the bed's own hide/show", async () => {
  const rig = await loadEnvironmentRig(fakeRenderer(), "print-bed", {
    loadHdr: async () => new THREE.DataTexture(), loadTexture: () => new THREE.Texture(), pmrem, createCanvas: () => null,
  });
  rig.setGround({ y: 0, radius: 50, footprintMm: 60 });
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 50, 0);
  rig.updateForCamera(camera);
  expect(rig.ground.visible).toBe(true);
  camera.position.set(0, -50, 0);
  rig.updateForCamera(camera);
  expect(rig.ground.visible).toBe(false);
  rig.dispose();
});

test("environments other than the print bed carry no lights of their own and no updateForCamera (the disc culls by its material's own side)", async () => {
  const rig = await loadEnvironmentRig(fakeRenderer(), "studio", {
    loadHdr: async () => new THREE.DataTexture(), loadTexture: () => new THREE.Texture(), pmrem,
  });
  expect(rig.lights).toEqual([]);
  expect(rig.updateForCamera).toBeUndefined();
  rig.dispose();
});

test("environments other than the print bed keep a full-strength backdrop", async () => {
  const rig = await loadEnvironmentRig(fakeRenderer(), "studio", {
    loadHdr: async () => new THREE.DataTexture(), loadTexture: () => new THREE.Texture(), pmrem,
  });
  expect(rig.backgroundIntensity).toBe(1);
  rig.dispose();
});

// Outdoor concrete is seen up close under small parts: exposed-aggregate
// colour on a 400 mm tile, its own normal map, and a finer detail layer
// blended into the colour so the grain stays crisp past the map's texels.
test("the outdoor concrete carries a normal map, a tight tile and a detail layer", async () => {
  const loaded = {};
  const rig = await loadEnvironmentRig(fakeRenderer(), "outdoor", {
    loadHdr: async () => new THREE.DataTexture(), loadTexture: (f) => (loaded[f] = new THREE.Texture()), pmrem,
  });
  const m = rig.ground.material;
  expect(m.normalMap).toBe(loaded["ground-concrete-normal.jpg"]);
  expect(m.normalMap.colorSpace).toBe(THREE.NoColorSpace);
  rig.setGround({ y: 0, radius: 10 });
  // 800 mm disc / 400 mm tile
  expect(m.map.repeat.x).toBeCloseTo(2);
  expect(m.customProgramCacheKey()).toBe("pf-ground-detail");
  const shader = { vertexShader: "#include <common>\n#include <begin_vertex>", fragmentShader: "#include <common>\n#include <map_fragment>\n#include <dithering_fragment>" };
  m.onBeforeCompile(shader);
  expect(shader.fragmentShader).toContain("vMapUv * 7.130");
  rig.dispose();
});
