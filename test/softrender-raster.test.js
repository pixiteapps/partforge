import { describe, expect, it } from "vitest";
import { makeCamera, } from "../src/framework/softrender/camera.js";
import { createGBuffer, rasterizeMesh } from "../src/framework/softrender/raster.js";

const pose = { position: [0, 0, 10], up: [0, 1, 0], target: [0, 0, 0] };
// A 4×4 square facing the camera at z = 0 (two triangles, CCW from +z).
const square = (z = 0, withNormals = true) => ({
  positions: new Float32Array([-2, -2, z, 2, -2, z, 2, 2, z, -2, -2, z, 2, 2, z, -2, 2, z]),
  ...(withNormals ? { normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]) } : {}),
});

describe("makeCamera", () => {
  const cam = makeCamera(pose, { fov: 45, width: 200, height: 100 });
  it("projects the target to the image centre at the camera distance", () => {
    const [sx, sy, z] = cam.project(0, 0, 0);
    expect(sx).toBeCloseTo(100); expect(sy).toBeCloseTo(50); expect(z).toBeCloseTo(10);
  });
  it("matches three's right/up convention: +x right, +y up (screen y down)", () => {
    expect(cam.project(1, 0, 0)[0]).toBeGreaterThan(100);
    expect(cam.project(0, 1, 0)[1]).toBeLessThan(50);
  });
  it("ray() inverts project()", () => {
    const p = [1.5, -0.7, 2];
    const [sx, sy, z] = cam.project(...p);
    const r = cam.ray(sx, sy);
    const q = [0, 1, 2].map((i) => cam.position[i] + r[i] * z);
    q.forEach((v, i) => expect(v).toBeCloseTo(p[i], 6));
  });
});

describe("rasterizeMesh", () => {
  const cam = makeCamera(pose, { fov: 45, width: 64, height: 64 });

  it("covers the square's pixels with its owner, depth and normal", () => {
    const gb = createGBuffer(64, 64);
    rasterizeMesh(gb, cam, square(), 3);
    const c = 32 * 64 + 32;
    expect(gb.owner[c]).toBe(3);
    expect(gb.depth[c]).toBeCloseTo(10, 4);
    expect([gb.normal[c * 3], gb.normal[c * 3 + 1], gb.normal[c * 3 + 2]]).toEqual([0, 0, 1]);
    expect(gb.owner[0]).toBe(-1);
  });

  it("keeps the nearer surface (z-buffer)", () => {
    const gb = createGBuffer(64, 64);
    rasterizeMesh(gb, cam, square(0), 1);
    rasterizeMesh(gb, cam, square(1), 2);
    rasterizeMesh(gb, cam, square(-1), 3);
    expect(gb.owner[32 * 64 + 32]).toBe(2);
  });

  it("falls back to a camera-facing face normal without normals (Review Focus 4)", () => {
    const gb = createGBuffer(64, 64);
    const m = square(0, false);
    // reverse winding so the geometric normal points AWAY from the camera
    m.positions = new Float32Array([-2, -2, 0, 2, 2, 0, 2, -2, 0, -2, -2, 0, -2, 2, 0, 2, 2, 0]);
    rasterizeMesh(gb, cam, m, 0);
    const c = 32 * 64 + 32;
    expect(gb.normal[c * 3 + 2]).toBeCloseTo(1);
  });

  it("skips triangles crossing the near plane instead of exploding", () => {
    const gb = createGBuffer(64, 64);
    rasterizeMesh(gb, cam, { positions: new Float32Array([-1, 0, 20, 1, 0, 20, 0, 1, 0]) }, 0);
    expect(gb.owner.every((o) => o === -1)).toBe(true);
  });
});
