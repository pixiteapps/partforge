import { describe, expect, it } from "vitest";
import { modelToWorld, boundsOf, stylePose, fitPoseToPoints } from "../src/framework/style-camera.js";
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

// Signed NDC of a world point under a pose: [x/(z·tanH·aspect), y/(z·tanH)].
function ndc(pose, fov, aspect, p) {
  const f = norm(sub(pose.target, pose.position));
  const r = norm(cross(f, pose.up));
  const u = cross(r, f);
  const d = sub(p, pose.position);
  const z = dot(d, f), t = Math.tan((fov * Math.PI) / 360);
  return [dot(d, r) / (z * t * aspect), dot(d, u) / (z * t)];
}
const triples = (flat) => { const out = []; for (let i = 0; i < flat.length; i += 3) out.push([flat[i], flat[i + 1], flat[i + 2]]); return out; };
const flatCorners = (b) => corners(b).flat();

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

  it("canonical framing is cameraPoseForView with the max-extent radius", () => {
    const canonical = { ...RENDER_STYLES.cad, camera: { projection: "perspective", fov: 45, framing: "canonical" } };
    const { pose, fov, sceneBounds } = stylePose(canonical, "front", b);
    expect(pose).toEqual(cameraPoseForView("front", { center: [0, 4, 0], radius: 10 }));
    expect(fov).toBe(45);
    expect(sceneBounds.radius).toBeCloseTo(Math.hypot(20, 8, 10) / 2, 9);
  });

  it("cad fits too: every box corner inside its fill, touching it", () => {
    const st = RENDER_STYLES.cad;
    const { pose, fov } = stylePose(st, "iso", b);
    const offs = corners(b).map((c) => screen(pose, fov, 1, c)).flat();
    expect(Math.max(...offs)).toBeLessThanOrEqual(st.camera.fill + 1e-9);
    expect(Math.max(...offs)).toBeGreaterThan(st.camera.fill - 1e-6);
  });

  it("with points, fit frames the points (fitPoseToPoints) and keeps the box's sceneBounds", () => {
    const st = RENDER_STYLES.thumbnail;
    // A bar with a block at one end: its box is not its shape.
    const pts = [...flatCorners(box([0, 0, -1], [40, 2, 1])), ...flatCorners(box([36, 0, -6], [40, 10, 6]))];
    const bb = boundsOf([pts]);
    const withPts = stylePose(st, "iso", bb, { points: pts });
    expect(withPts.pose).toEqual(fitPoseToPoints("iso", pts, { fov: 45, aspect: 1, fill: st.camera.fill }));
    expect(withPts.sceneBounds).toEqual(stylePose(st, "iso", bb).sceneBounds);
    // Unusable points fall back to the box-corner fit.
    expect(stylePose(st, "iso", bb, { points: [] }).pose).toEqual(stylePose(st, "iso", bb).pose);
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
    expect(Math.max(...offs.map((o) => o[0]))).toBeLessThanOrEqual(RENDER_STYLES.thumbnail.camera.fill + 1e-9);
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

describe("fitPoseToPoints", () => {
  const opts = { fov: 45, aspect: 1, fill: 0.9 };
  const maxNdc = (pose, pts, aspect = 1) => Math.max(...triples(pts).flatMap((p) => ndc(pose, 45, aspect, p).map(Math.abs)));
  const ndcCentre = (pose, pts, aspect = 1) => {
    const n = triples(pts).map((p) => ndc(pose, 45, aspect, p));
    const xs = n.map((v) => v[0]), ys = n.map((v) => v[1]);
    return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  };
  const bar = [...flatCorners(box([0, 0, -1], [60, 2, 1])), ...flatCorners(box([52, 0, -8], [60, 14, 8]))];

  it("keeps every point within fill, touching it", () => {
    for (const view of ["iso", "front", "top", "left"]) {
      const pose = fitPoseToPoints(view, bar, opts);
      expect(maxNdc(pose, bar)).toBeLessThanOrEqual(0.9 + 1e-9);
      expect(maxNdc(pose, bar)).toBeGreaterThanOrEqual(0.9 - 1e-6);
    }
  });

  it("centres an off-centre point cloud in the frame", () => {
    for (const view of ["iso", "front", "top"]) {
      const pose = fitPoseToPoints(view, bar, opts);
      const [cx, cy] = ndcCentre(pose, bar);
      expect(Math.abs(cx)).toBeLessThan(0.01);
      expect(Math.abs(cy)).toBeLessThan(0.01);
    }
  });

  it("keeps the canonical view direction and up vector", () => {
    const pose = fitPoseToPoints("iso", bar, opts);
    const can = cameraPoseForView("iso", { center: [0, 0, 0], radius: 1 });
    const d1 = norm(sub(pose.position, pose.target)), d2 = norm(sub(can.position, can.target));
    d1.forEach((v, i) => expect(v).toBeCloseTo(d2[i], 9));
    expect(pose.up).toEqual(can.up);
  });

  it("is null for no points and for identical points", () => {
    expect(fitPoseToPoints("iso", [], opts)).toBeNull();
    expect(fitPoseToPoints("iso", new Float32Array(0), opts)).toBeNull();
    expect(fitPoseToPoints("iso", [3, 3, 3], opts)).toBeNull();
    expect(fitPoseToPoints("iso", [3, 3, 3, 3, 3, 3], opts)).toBeNull();
  });

  it("stays finite for a flat sheet, from every side", () => {
    const sheet = flatCorners(box([-10, 0, -5], [10, 0, 5]));
    for (const view of ["iso", "front", "top", "left"]) {
      const pose = fitPoseToPoints(view, sheet, opts);
      for (const v of [...pose.position, ...pose.target]) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("honours the aspect", () => {
    const wide = flatCorners(box([-50, 0, -2], [50, 4, 2]));
    const aspect = 800 / 600;
    const pose = fitPoseToPoints("front", wide, { ...opts, aspect });
    const n = triples(wide).map((p) => ndc(pose, 45, aspect, p));
    expect(Math.max(...n.map((v) => Math.abs(v[0])))).toBeLessThanOrEqual(0.9 + 1e-9);
    expect(Math.max(...n.map((v) => Math.abs(v[0])))).toBeGreaterThanOrEqual(0.9 - 1e-6);
    // and a square fit of the same points sits further back
    const square = fitPoseToPoints("front", wide, opts);
    expect(Math.hypot(...sub(square.position, square.target))).toBeGreaterThan(Math.hypot(...sub(pose.position, pose.target)));
  });
});
