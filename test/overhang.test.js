// Overhang detection (oracle/overhang.js): one pass over a mesh's triangles,
// pure, no BVH. A face counts when it points DOWN more steeply than the process
// allows — angle measured from vertical, so a wall is 0° and a ceiling 90° — and
// does not lie on the bed plane (the mesh's own lowest Z). Hand-built meshes
// here so every number is known; the measure/verify integration is in
// verify.test.js.
import { describe, expect, it } from "vitest";
import { overhang } from "../src/framework/oracle/overhang.js";

// A closed box as a Manifold-style soup (9 floats per triangle), outward CCW.
function box([x0, y0, z0], [x1, y1, z1]) {
  const P = [];
  const quad = (a, b, c, d) => { P.push(...a, ...b, ...c, ...a, ...c, ...d); };
  const v = (x, y, z) => [x, y, z];
  quad(v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)); // top (+Z)
  quad(v(x0, y1, z0), v(x1, y1, z0), v(x1, y0, z0), v(x0, y0, z0)); // bottom (−Z)
  quad(v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1)); // −Y
  quad(v(x1, y1, z0), v(x0, y1, z0), v(x0, y1, z1), v(x1, y1, z1)); // +Y
  quad(v(x0, y1, z0), v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1)); // −X
  quad(v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1), v(x1, y0, z1)); // +X
  return { positions: Float32Array.from(P), triangles: P.length / 9 };
}

// A wedge: a box whose underside is tilted by `deg` from horizontal along X —
// i.e. its down-facing face is (90 − deg)° from vertical.
function wedge(deg, { w = 10, d = 10, h = 10 } = {}) {
  const rise = w * Math.tan((deg * Math.PI) / 180);
  const P = [];
  const tri = (a, b, c) => P.push(...a, ...b, ...c);
  const quad = (a, b, c, d2) => { tri(a, b, c); tri(a, c, d2); };
  // bottom face runs from z=0 at x=0 up to z=rise at x=w
  const b00 = [0, 0, 0], b10 = [w, 0, rise], b11 = [w, d, rise], b01 = [0, d, 0];
  const t00 = [0, 0, h + rise], t10 = [w, 0, h + rise], t11 = [w, d, h + rise], t01 = [0, d, h + rise];
  quad(b01, b11, b10, b00);      // underside, faces down-ish
  quad(t00, t10, t11, t01);      // top
  quad(b00, b10, t10, t00);      // −Y
  quad(b11, b01, t01, t11);      // +Y
  quad(b01, b00, t00, t01);      // −X
  quad(b10, b11, t11, t10);      // +X
  return { positions: Float32Array.from(P), triangles: P.length / 9 };
}

describe("overhang", () => {
  it("a box sitting on its base has no overhang: the bed face is excluded, walls are vertical", () => {
    const r = overhang(box([0, 0, 0], [10, 10, 10]), { maxAngle: 45 });
    expect(r.area).toBe(0);
    expect(r.worstAngle).toBeNull();
    expect(r.at).toBeNull();
  });

  it("the bed is the mesh's OWN lowest Z, so a lifted box is judged as printed on its base", () => {
    expect(overhang(box([0, 0, 30], [10, 10, 40]), { maxAngle: 45 }).area).toBe(0);
  });

  it("a wedge whose underside is 30° from horizontal (60° from vertical) is an overhang past 45°", () => {
    const r = overhang(wedge(30), { maxAngle: 45 });
    const w = 10, d = 10;
    expect(r.area).toBeCloseTo((w / Math.cos(Math.PI / 6)) * d, 3); // the sloped face's true area
    expect(r.worstAngle).toBeCloseTo(60, 3);
    expect(r.at).toHaveLength(3);
    expect(r.at[2]).toBeLessThan(5); // on the underside
  });

  it("a wedge at exactly the threshold does not fire, and one just past it does", () => {
    expect(overhang(wedge(45), { maxAngle: 45 }).area).toBe(0);
    expect(overhang(wedge(44), { maxAngle: 45 }).area).toBeGreaterThan(0); // 46° from vertical
    expect(overhang(wedge(30), { maxAngle: 70 }).area).toBe(0);            // a permissive process
  });

  it("a ceiling counts (a bridge is indistinguishable from one and is reported as an overhang)", () => {
    // two blocks joined by a raised slab: the slab's underside is a 90° ceiling
    const P = [];
    for (const m of [box([0, 0, 0], [4, 10, 10]), box([16, 0, 0], [20, 10, 10]), box([4, 0, 6], [16, 10, 10])]) P.push(...m.positions);
    const r = overhang({ positions: Float32Array.from(P), triangles: P.length / 9 }, { maxAngle: 45 });
    expect(r.area).toBeCloseTo(12 * 10, 3);
    expect(r.worstAngle).toBeCloseTo(90, 6);
  });

  it("reads the OCCT indexed form too", () => {
    const soup = wedge(30);
    const positions = soup.positions, indices = Uint32Array.from({ length: soup.triangles * 3 }, (_, i) => i);
    const r = overhang({ positions, indices, triangles: soup.triangles }, { maxAngle: 45 });
    expect(r.area).toBeCloseTo(overhang(soup, { maxAngle: 45 }).area, 6);
  });

  it("an empty mesh is null, and degenerate triangles are skipped", () => {
    expect(overhang({ positions: new Float32Array(0), triangles: 0 }, { maxAngle: 45 })).toBeNull();
    const degenerate = { positions: Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0]), triangles: 1 };
    expect(overhang(degenerate, { maxAngle: 45 }).area).toBe(0);
  });
});

// ── the review-driven edges: float32 at the threshold, a noisy bed, near-bed bands ──

// Rotate a soup about Z — an overhang angle cannot change under it.
const rotateZ = (mesh, deg) => {
  const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180);
  const P = Float32Array.from(mesh.positions);
  for (let i = 0; i < P.length; i += 3) { const x = P[i], y = P[i + 1]; P[i] = c * x - s * y; P[i + 1] = s * x + c * y; }
  return { positions: P, triangles: mesh.triangles };
};

describe("overhang — tolerance and bed edges", () => {
  it("a 45° underside authored at the threshold never warns, at any Z rotation, in float32", () => {
    // float32 quantization perturbs a normal by ~1e-6 (a thousandth of a degree),
    // which a sine-space epsilon let fire on most rotations
    for (let deg = 0; deg < 360; deg += 9) {
      expect(overhang(rotateZ(wedge(45, { w: 12.7, d: 9.3 }), deg), { maxAngle: 45 }).area).toBe(0);
    }
  });

  it("a single vertex a few microns below the bed, or a micro-tilt, does not lift the footprint into a 90° ceiling", () => {
    const plate = box([0, 0, 0], [60, 60, 5]);
    const P = Float32Array.from(plate.positions);
    P[20] -= 0.005; // one BOTTOM vertex (the second quad's first) 5 µm low
    expect(overhang({ positions: P, triangles: plate.triangles }, { maxAngle: 45 }).area).toBe(0);
    const tilted = Float32Array.from(plate.positions);
    const t = Math.tan((0.001 * Math.PI) / 180);
    for (let i = 0; i < tilted.length; i += 3) tilted[i + 2] += tilted[i] * t; // 0.001° about Y
    expect(overhang({ positions: tilted, triangles: plate.triangles }, { maxAngle: 45 }).area).toBe(0);
  });

  it("faces within the near-bed band (a bottom fillet's lower curl) are not counted; the same faces higher up are", () => {
    // a small 60°-from-vertical underside whose centroid sits 0.5 mm above the bed…
    const low = wedge(30, { w: 1, d: 10, h: 10 });        // rise 0.58 → centroid ≈ 0.2–0.4 mm
    expect(overhang(low, { maxAngle: 45 }).area).toBe(0);
    // …and the identical wedge with a 3 mm plinth underneath, so the band no longer covers it
    const P = [...low.positions].map((v, i) => (i % 3 === 2 ? v + 3 : v));
    const plinth = box([0, 0, 0], [1, 10, 3]);
    const raised = { positions: Float32Array.from([...plinth.positions, ...P]), triangles: plinth.triangles + low.triangles };
    expect(overhang(raised, { maxAngle: 45 }).area).toBeGreaterThan(0);
  });

  it("a caller-supplied bedZ is honoured, and bedBand can be widened or zeroed", () => {
    const w = wedge(30);
    expect(overhang(w, { maxAngle: 45, bedZ: 0 }).area).toBeCloseTo(overhang(w, { maxAngle: 45 }).area, 6);
    expect(overhang(wedge(30, { w: 1, d: 10, h: 10 }), { maxAngle: 45, bedBand: 0 }).area).toBeGreaterThan(0);
  });

  it("a float32 sliver contributes no worst angle", () => {
    const base = box([0, 0, 0], [10, 10, 10]);
    // a 1e-4 mm DOWNWARD-facing needle (clockwise from above) mid-height
    const sliver = [0, 0, 5, 0, 1e-4, 5, 1e-4, 0, 5];
    const mesh = { positions: Float32Array.from([...base.positions, ...sliver]), triangles: base.triangles + 1 };
    const r = overhang(mesh, { maxAngle: 45 });
    expect(r.worstAngle).toBeNull();
    expect(r.area).toBeLessThan(1e-6);
  });

  it("returns only area, worstAngle and at", () => {
    expect(Object.keys(overhang(wedge(30), { maxAngle: 45 })).sort()).toEqual(["area", "at", "worstAngle"]);
  });
});
