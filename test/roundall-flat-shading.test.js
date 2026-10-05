// roundAll's Minkowski (reference) path shades its flat faces flat.
//
// The result is one fresh surface shaded SMOOTH (35° crease), and the rounding
// ball's facets bend far less than that, so a flat face's corner vertices used to
// average in the band facets around them. The sum is unweighted, so a big face
// split into two triangles — a sloped palm plate's top — took a several-degree
// tilt at every corner, interpolated across the whole face as a shading gradient
// (cloud feedback #167). The prism fast path never had it (its fillet bands carry
// analytic normals); a sloped top is not a Z-prism, so it reaches the reference path.
import { beforeAll, describe, expect, it } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { flatFacePlanes } from "../src/framework/geometry/mesh-roundall.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const angle = (a, b) => (Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;
const unit = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };

// A plate in plan, tapered in thickness from back (x = -75) to front (x = 0): its
// top is one sloped plane, so the solid is no Z-prism.
const BACK_T = 16, FRONT_T = 10, LEN = 75, SLOPE = (FRONT_T - BACK_T) / LEN;
const topZ = (x) => BACK_T + SLOPE * (x + LEN);
const TOP_N = unit([-SLOPE, 0, 1]);
function slopedPlate() {
  const plan = [[-LEN, -22], [0, -30], [0, 30], [-LEN, 22]];
  const side = k.extrude({ profile: [[-LEN, 0], [4, 0], [4, topZ(4)], [-LEN, BACK_T]], h: 80 })
    .rotateX(90).at([0, 40, 0]);
  return k.extrude({ profile: plan, h: BACK_T + 2 }).intersect(side);
}

// Worst vertex-normal error over the triangles lying in the top plane.
function topFaceError(mesh, { onTop = (p) => Math.abs(p[2] - topZ(p[0])) < 2e-3, n = TOP_N } = {}) {
  const { positions, normals } = mesh;
  let worst = 0, tris = 0;
  for (let t = 0; t < positions.length; t += 9) {
    const ps = [0, 1, 2].map((v) => [positions[t + v * 3], positions[t + v * 3 + 1], positions[t + v * 3 + 2]]);
    if (!ps.every(onTop)) continue;
    tris++;
    for (let v = 0; v < 3; v++) {
      const i = t + v * 3;
      worst = Math.max(worst, angle([normals[i], normals[i + 1], normals[i + 2]], n));
    }
  }
  return { worst, tris };
}

describe("roundAll reference path: flat faces shade flat", () => {
  it("a sloped plate's top carries its plane normal at every vertex", () => {
    const { worst, tris } = topFaceError(slopedPlate().roundAll(1.5).toMesh());
    expect(tris).toBeGreaterThan(0);
    expect(worst).toBeLessThan(0.05); // was 4-8° before the fix
  });

  it("survives label(), a later pose and a union with another solid", () => {
    const plate = slopedPlate().roundAll(1.5).label("Palm plate");
    expect(topFaceError(plate.toMesh()).worst).toBeLessThan(0.05);

    const peg = k.box({ min: [-10, -5, 0], max: [-5, 5, 30] });
    const joined = k.union([plate, peg]).translate([5, 7, 3]);
    const moved = topFaceError(joined.toMesh(), {
      onTop: (p) => Math.abs(p[2] - 3 - topZ(p[0] - 5)) < 2e-3,
    });
    expect(moved.tris).toBeGreaterThan(0);
    expect(moved.worst).toBeLessThan(0.05);
  });

  it("only faces the input itself shades flat count — a curved wall's facets do not", () => {
    // a rod's wall facets meet at a few degrees, so the input shades them smooth;
    // pinning each to its own plane would facet the rounded wall
    const rod = k.cylinder(8, 8, 20).rotateY(90);
    const planes = flatFacePlanes(rod._m.getMesh());
    expect(planes.map((p) => Math.round(Math.abs(p.n[0])))).toEqual([1, 1]); // the two end caps
    expect(flatFacePlanes(slopedPlate()._m.getMesh())).toHaveLength(6);
  });

  it("a face that meets its neighbour tangentially is not a flat face", () => {
    // a slot's straight sides run into its round ends at a facet's worth of bend:
    // the input shades that seam smooth, so the sides are not flat faces either
    const pts = [];
    for (let i = 0; i <= 12; i++) { const a = -Math.PI / 2 + (Math.PI * i) / 12; pts.push([10 + 5 * Math.cos(a), 5 * Math.sin(a)]); }
    for (let i = 0; i <= 12; i++) { const a = Math.PI / 2 + (Math.PI * i) / 12; pts.push([-10 + 5 * Math.cos(a), 5 * Math.sin(a)]); }
    const planes = flatFacePlanes(k.extrude({ profile: pts, h: 6 })._m.getMesh());
    expect(planes.map((p) => Math.round(Math.abs(p.n[2])))).toEqual([1, 1]); // top and bottom only
  });
});
