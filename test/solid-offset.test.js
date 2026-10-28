// Solid.offset on the Manifold backend: a 3-D ball offset (mesh-roundall.js
// meshOffset). Covers the numbers (box bounds/volume against the Steiner
// formula), the constant-thickness skin it exists for — measured along diagonal
// directions, where the old six-shifted-copies workaround came out t/√3 thick —
// imported meshes, and the calling-convention seams. The OCCT twin is
// test/solid-offset-occt.test.js (the two kernels never boot in one process).
import { beforeAll, describe, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { detectBackend } from "../src/framework/backend-select.js";
import { cubeSoup } from "./helpers/cube-soup.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const box = () => k.box({ min: [0, 0, 0], max: [30, 20, 10] });

// Steiner's formula for a box grown by a ball of radius d: faces push out,
// edges become quarter cylinders, corners one full sphere between them.
const steinerBox = (a, b, c, d) =>
  a * b * c + 2 * (a * b + b * c + c * a) * d + Math.PI * d * d * (a + b + c) + (4 / 3) * Math.PI * d ** 3;

// Wall thickness along the unit direction `dir` from the origin: intersect the
// solid with a thin rod along `dir` and divide by the rod's cross-section. A
// square rod, so its cross-section is exact rather than a faceted circle's.
const thicknessAlong = (solid, dir, w = 0.4) => {
  const L = 100;
  const rod = k.box({ min: [-w / 2, -w / 2, 0], max: [w / 2, w / 2, L] });
  const [x, y, z] = dir;
  const n = Math.hypot(x, y, z);
  const tilt = (Math.acos(z / n) * 180) / Math.PI;
  const yaw = (Math.atan2(y, x) * 180) / Math.PI;
  const aimed = rod.rotateY(tilt).rotateZ(yaw);
  return solid.intersect(aimed).volume() / (w * w);
};

// Preview tier: the ball's facets sit up to its 0.05 mm sagitta inside the true
// ball, and the sphere being offset is faceted too, so allow 0.1 mm. The old
// workaround was off by 42% on the XYZ diagonal (2 mm → 1.15 mm) — far outside.
const expectThickness = (got, t, name) => expect(Math.abs(got - t), `${name}: ${got}`).toBeLessThanOrEqual(0.1);

const DIRECTIONS = {
  "+X": [1, 0, 0],
  "+Z": [0, 0, 1],
  "XY diagonal": [1, 1, 0],
  "XYZ diagonal": [1, 1, 1],
  "off-axis": [0.3, -0.7, 0.5],
};

describe("box", () => {
  test("offset(+2) grows every face by 2 and rounds the edges", () => {
    const out = box().offset(2);
    const bb = out.boundingBox();
    for (let i = 0; i < 3; i++) {
      expect(bb.min[i]).toBeCloseTo(-2, 3);
      expect(bb.max[i]).toBeCloseTo([30, 20, 10][i] + 2, 3);
    }
    // the faceted ball sits inside the true one, so the edges and corners run a
    // little under the exact Steiner volume — never over it
    const exact = steinerBox(30, 20, 10, 2);
    expect(out.volume()).toBeLessThanOrEqual(exact + 1e-6);
    expect(out.volume()).toBeGreaterThan(exact * 0.995);
  });

  test("offset(-2) shrinks every face by 2 and keeps the convex corners sharp", () => {
    const out = box().offset(-2);
    const bb = out.boundingBox();
    for (let i = 0; i < 3; i++) {
      expect(bb.min[i]).toBeCloseTo(2, 3);
      expect(bb.max[i]).toBeCloseTo([30, 20, 10][i] - 2, 3);
    }
    expect(out.volume()).toBeCloseTo(26 * 16 * 6, 1);
  });

  test("an erode past half the thinnest wall consumes the solid", () => {
    expect(box().offset(-6).volume()).toBeCloseTo(0, 6);
  });

  test("an offset face shades flat: its normals point straight along the face normal", () => {
    const mesh = box().offset(2).toMesh();
    const { positions, normals } = mesh;
    let onTop = 0;
    for (let i = 0; i < positions.length; i += 3) {
      if (Math.abs(positions[i + 2] - 12) > 1e-4) continue;
      onTop++;
      expect(normals[i + 2]).toBeCloseTo(1, 4);
    }
    expect(onTop).toBeGreaterThan(0);
  });
});

describe("constant-thickness skin", () => {
  test("a sphere's skin is t thick in every direction, diagonals included", () => {
    const body = k.sphere(20);
    const skin = body.cut(body.offset(-2));
    for (const [name, dir] of Object.entries(DIRECTIONS)) {
      expectThickness(thicknessAlong(skin, dir), 2, name);
    }
  });

  test("a grown shell around a sphere is t thick in every direction", () => {
    const body = k.sphere(20);
    const skin = body.offset(1.5).cut(body);
    for (const [name, dir] of Object.entries(DIRECTIONS)) {
      expectThickness(thicknessAlong(skin, dir), 1.5, name);
    }
  });
});

describe("imported meshes", () => {
  test("an imported cube offsets like a native one", () => {
    k._registerImport({ name: "offset-cube", digest: "offset-cube", ...cubeSoup(10) });
    const s = k.import("offset-cube");
    expect(s.offset(1).volume()).toBeGreaterThan(steinerBox(10, 10, 10, 1) * 0.995);
    expect(s.offset(1).volume()).toBeLessThanOrEqual(steinerBox(10, 10, 10, 1) + 1e-6);
    expect(s.offset(-1).volume()).toBeCloseTo(512, 1);
  });

  test("an imported curved mesh takes a uniform skin (the fit-cage case)", () => {
    const { positions, indices } = k.sphere(20).toIndexedMesh();
    k._registerImport({ name: "offset-dome", digest: "offset-dome", positions, indices });
    const body = k.import("offset-dome");
    const skin = body.cut(body.offset(-2));
    for (const [name, dir] of Object.entries(DIRECTIONS)) {
      expectThickness(thicknessAlong(skin, dir), 2, name);
    }
  });
});

describe("calling convention", () => {
  test("scalar and options forms agree", () => {
    expect(box().offset({ d: 2 }).volume()).toBeCloseTo(box().offset(2).volume(), 6);
  });

  test("offset(0) is the identity", () => {
    expect(box().offset(0).volume()).toBeCloseTo(6000, 3);
    expect(box().offset({ d: 0 }).volume()).toBeCloseTo(6000, 3);
  });

  test("options form rejects unknown keys and a missing d", () => {
    expect(() => box().offset({ d: 2, r: 1 })).toThrow(/offset/);
    expect(() => box().offset({})).toThrow(/offset/);
  });

  test("a non-finite d throws", () => {
    expect(() => box().offset(NaN)).toThrow(/offset: d must be a finite number/);
  });

  test("a part using offset stays on manifold", () => {
    const part = {
      defaults: {}, views: { v: { label: "V" } },
      parts: { a: { views: ["v"], build: (kk) => { const b = kk.sphere(10); return b.cut(b.offset(-1)); } } },
    };
    expect(detectBackend(part)).toBe("manifold");
  });
});
