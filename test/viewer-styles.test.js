import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createHemisphereLight, createCaptureLights, captureLightPoses } from "../src/framework/viewer-lighting.js";
import { buildContactShadowPlane } from "../src/framework/contact-shadow-plane.js";
import { thumbnailBackground, THUMBNAIL_BG } from "../src/framework/viewer.js";
import { RENDER_STYLES } from "../src/framework/renderStyles.js";

describe("viewer lighting reads styles", () => {
  it("defaults to cad, unchanged", () => {
    const h = createHemisphereLight();
    expect(h.intensity).toBe(1.35);
    expect(h.color.getHex()).toBe(new THREE.Color(0xdce9ff).getHex());
    const { key, fill } = createCaptureLights();
    expect([key.intensity, fill.intensity]).toEqual([1.45, 0.65]);
  });

  it("builds the thumbnail's lights from its style", () => {
    const L = RENDER_STYLES.thumbnail.lights;
    expect(createHemisphereLight(L).intensity).toBe(L.hemisphere.intensity);
    expect(createCaptureLights(L).key.intensity).toBe(L.key.intensity);
  });

  it("captureLightPoses keeps its exact cad placement (regression)", () => {
    const pose = { position: [0, 0, 10], up: [0, 1, 0], target: [0, 0, 0] };
    const { key, fill } = captureLightPoses(pose);
    expect(key.map((v) => +v.toFixed(9))).toEqual([4.5, 7.5, 10]);
    expect(fill.map((v) => +v.toFixed(9))).toEqual([-7, 1.5, 10]);
  });
});

describe("thumbnail background", () => {
  it("is the thumbnail style's light background", () => {
    expect(THUMBNAIL_BG).toBe(RENDER_STYLES.thumbnail.background);
    expect(thumbnailBackground().getHex()).toBe(new THREE.Color(RENDER_STYLES.thumbnail.background).getHex());
    expect(thumbnailBackground(null)).toBeNull();
  });
});

describe("buildContactShadowPlane", () => {
  const mask = { width: 2, height: 2, data: new Float32Array([1, 0, 0, 0]), rect: { x0: -4, x1: 6, z0: -2, z1: 2 }, y: 3 };
  it("lies flat on the floor, centred on the rect, sized to it", () => {
    const m = buildContactShadowPlane(mask, RENDER_STYLES.thumbnail.shadow);
    expect(m.position.x).toBeCloseTo(1);
    expect(m.position.z).toBeCloseTo(0);
    expect(m.position.y).toBeLessThan(3);
    expect(m.rotation.x).toBeCloseTo(-Math.PI / 2);
    expect(m.geometry.parameters.width).toBeCloseTo(10);
    expect(m.geometry.parameters.height).toBeCloseTo(4);
    expect(m.material.opacity).toBe(RENDER_STYLES.thumbnail.shadow.opacity);
    expect(m.material.depthWrite).toBe(false);
  });
  it("flips rows: mask row 0 (z0) is the texture's TOP row (v = 1)", () => {
    const tex = buildContactShadowPlane(mask, RENDER_STYLES.thumbnail.shadow).material.alphaMap;
    const px = tex.image.data;
    expect(px[(1 * 2 + 0) * 4 + 1]).toBe(255);
    expect(px[(0 * 2 + 0) * 4 + 1]).toBe(0);
  });
});
