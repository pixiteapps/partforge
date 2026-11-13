// A flat face keeps its own normal where another solid's fillet lands on it.
//
// A boolean re-triangulates the face around the seam as a fan of long slivers
// (about 0.02 mm tall, tens of mm long). The micro-ledge rule in
// creased-normals.js gives any triangle under MIN_FACE that touches a blend the
// band's analytic normal, and it took these slivers too: their seam corners
// shaded with the OTHER solid's fillet normal, 50-110° off the face, and each
// sliver carried that error across the whole face as a streak (cel mode drew
// ink lines along them). Cloud feedback #265: a palm plate's side above its
// thumb mount.
import { beforeAll, describe, expect, it } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { setCoreEnabled } from "../src/framework/core/core.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const unit = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
// A plate tapered in plan: its -Y side runs from (-75, -22) to (0, -30).
const SIDE_N = unit([-8, -75, 0]), SIDE_D = -30 * SIDE_N[1];
const plate = () => k.extrude({ profile: [[-75, -22], [0, -30], [0, 30], [-75, 22]], h: 16 });
// Filleted blocks standing through that side at an angle, like a hinge mount.
const MOUNTS = {
  "a filleted box": () => k.box({ min: [-6, -6, 2], max: [6, 6, 12] }).fillet(1.5).rotateZ(48).at([-45, -27, 0]),
  "a tilted filleted box": () => k.box({ min: [-6, -6, 2], max: [6, 6, 12] }).fillet(1.5).rotateZ(48).rotateX(20).at([-45, -27, 0]),
  "a filleted cylinder": () => k.cylinder({ r: 6, h: 10 }).fillet(1.5).rotateX(60).at([-45, -27, 6]),
};

// Worst vertex-normal error over the triangles lying in the side plane...
function sideFaceError(mesh) {
  const { positions: P, normals: N } = mesh;
  let worst = 0, tris = 0;
  for (let t = 0; t < P.length; t += 9) {
    let on = true;
    for (let v = 0; v < 3; v++) {
      const i = t + v * 3;
      if (Math.abs(P[i] * SIDE_N[0] + P[i + 1] * SIDE_N[1] + P[i + 2] * SIDE_N[2] - SIDE_D) > 2e-3) on = false;
    }
    if (!on) continue;
    // ...and FACING it: the seam also leaves micron-tall slivers of the mount and
    // of real ledges whose three vertices sit within the plane tolerance.
    const ux = P[t + 3] - P[t], uy = P[t + 4] - P[t + 1], uz = P[t + 5] - P[t + 2];
    const vx = P[t + 6] - P[t], vy = P[t + 7] - P[t + 1], vz = P[t + 8] - P[t + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const fl = Math.hypot(fx, fy, fz);
    if (!(fl > 0) || (fx * SIDE_N[0] + fy * SIDE_N[1] + fz * SIDE_N[2]) / fl < Math.cos(Math.PI / 180)) continue;
    tris++;
    for (let v = 0; v < 3; v++) {
      const i = t + v * 3;
      const d = N[i] * SIDE_N[0] + N[i + 1] * SIDE_N[1] + N[i + 2] * SIDE_N[2];
      worst = Math.max(worst, (Math.acos(Math.min(1, Math.abs(d))) * 180) / Math.PI);
    }
  }
  return { worst, tris };
}

describe("a flat face under another solid's fillet shades flat", () => {
  for (const coreOn of [true, false]) {
    for (const [name, mount] of Object.entries(MOUNTS)) {
      it(`${name} joined to a plate's side (core ${coreOn ? "on" : "off"})`, () => {
        setCoreEnabled(coreOn);
        try {
          const { worst, tris } = sideFaceError(k.union([plate(), mount()]).toMesh());
          expect(tris).toBeGreaterThan(20); // the seam fan is there
          expect(worst).toBeLessThan(0.05); // was 58-90° before the fix
        } finally { setCoreEnabled(true); }
      });
    }
  }

  it("a rounded, labelled plate too", () => {
    const base = plate().roundAll(1.5).label("Palm plate");
    const { worst, tris } = sideFaceError(k.union([base, MOUNTS["a filleted box"]()]).toMesh());
    expect(tris).toBeGreaterThan(20);
    expect(worst).toBeLessThan(0.05);
  });
});
