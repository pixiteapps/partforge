import { describe, expect, it } from "vitest";
import { modelToWorld, boundsOf, stylePose } from "../src/framework/style-camera.js";
import { cameraPoseForView } from "../src/framework/view-angles.js";
import { RENDER_STYLES } from "../src/framework/renderStyles.js";

const box = (min, max) => ({ min, max });
const corners = ({ min, max }) => {
  const out = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) out.push([x, y, z]);
  return out;
};
const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => { const l = Math.hypot(...v); return v.map((c) => c / l); };
// Normalised screen offset of a world point: |x|/(z·tanH·aspect), |y|/(z·tanH).
function screen(pose, fov, aspect, p) {
  const f = norm(sub(pose.target, pose.position));
  const r = norm(cross(f, pose.up));
  const u = cross(r, f);
  const d = sub(p, pose.position);
  const z = dot(d, f), t = Math.tan((fov * Math.PI) / 360);
  return [Math.abs(dot(d, r)) / (z * t * aspect), Math.abs(dot(d, u)) / (z * t)];
}

describe("modelToWorld", () => {
  it("maps model (x, y, z) to world (x, z, -y)", () => {
    expect([...modelToWorld([1, 2, 3, 4, 5, 6])]).toEqual([1, 3, -2, 4, 6, -5]);
  });
});

describe("boundsOf", () => {
  it("spans every array and is null for nothing", () => {
    expect(boundsOf([new Float32Array([0, 0, 0, 1, 2, 3]), new Float32Array([-1, 5, 0])]))
      .toEqual({ min: [-1, 0, 0], max: [1, 5, 3] });
    expect(boundsOf([new Float32Array(0)])).toBeNull();
  });
});

describe("stylePose", () => {
  const b = box([-10, 0, -5], [10, 8, 5]);

  it("cad framing is cameraPoseForView with the max-extent radius (the canonical capture's)", () => {
    const { pose, fov, sceneBounds } = stylePose(RENDER_STYLES.cad, "front", b);
    expect(pose).toEqual(cameraPoseForView("front", { center: [0, 4, 0], radius: 10 }));
    expect(fov).toBe(45);
    expect(sceneBounds.radius).toBeCloseTo(Math.hypot(20, 8, 10) / 2, 9);
  });

  it("fit framing keeps every corner inside `fill` of the frame and touches it", () => {
    const st = RENDER_STYLES.thumbnail;
    const { pose, fov } = stylePose(st, "iso", b, { aspect: 1 });
    const offs = corners(b).map((c) => screen(pose, fov, 1, c)).flat();
    expect(Math.max(...offs)).toBeLessThanOrEqual(st.camera.fill + 1e-9);
    expect(Math.max(...offs)).toBeGreaterThan(st.camera.fill - 1e-6);
  });

  it("fit framing honours a wide aspect (Review Focus 5)", () => {
    const wide = box([-50, 0, -2], [50, 4, 2]);
    const { pose, fov } = stylePose(RENDER_STYLES.thumbnail, "front", wide, { aspect: 800 / 600 });
    const offs = corners(wide).map((c) => screen(pose, fov, 800 / 600, c));
    expect(Math.max(...offs.map((o) => o[0]))).toBeLessThanOrEqual(0.82 + 1e-9);
  });

  it("fit keeps the canonical view direction and up vector", () => {
    const fit = stylePose(RENDER_STYLES.thumbnail, "iso", b).pose;
    const can = cameraPoseForView("iso", { center: [0, 4, 0], radius: 1 });
    const d1 = norm(sub(fit.position, fit.target)), d2 = norm(sub(can.position, can.target));
    d1.forEach((v, i) => expect(v).toBeCloseTo(d2[i], 9));
    expect(fit.up).toEqual(can.up);
  });

  it("stays finite for a flat sheet and for a single point (Review Focus 1)", () => {
    for (const bb of [box([-10, 0, -5], [10, 0, 5]), box([3, 3, 3], [3, 3, 3]), null]) {
      for (const st of [RENDER_STYLES.cad, RENDER_STYLES.thumbnail]) {
        const { pose, sceneBounds } = stylePose(st, "iso", bb);
        for (const v of [...pose.position, ...pose.target, sceneBounds.radius]) expect(Number.isFinite(v)).toBe(true);
        expect(sceneBounds.radius).toBeGreaterThan(0);
      }
    }
  });

  it("a shadowed style widens sceneBounds to hold the shadow plane", () => {
    const plain = stylePose({ ...RENDER_STYLES.thumbnail, shadow: null }, "iso", b).sceneBounds.radius;
    const shadowed = stylePose(RENDER_STYLES.thumbnail, "iso", b).sceneBounds.radius;
    expect(shadowed).toBeGreaterThan(plain);
  });
});
