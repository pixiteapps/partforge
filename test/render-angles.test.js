import { describe, expect, it } from "vitest";
import { RENDER_ANGLES, RENDER_VIEWS, renderAngle } from "../src/testing/render.js";
import { CANONICAL_VIEWS, CAMERA_CUE_VIEWS, cameraPoseForView } from "../src/framework/view-angles.js";

// Two surfaces render the same canonical angles: the browser viewer's offscreen
// captureViews (framework/view-angles.js, stated in the viewer's Y-up WORLD space)
// and the headless software rasterizer used by the CLI and by consumers' eval
// harnesses (testing/render.js, stated in Z-up MODEL space). An agent asking for
// `left` must be shown the same face either way, so these tests hold both tables
// to one set of cameras.
//
// The viewer's pivot rotates the Z-up model into Y-up world, which is exactly:
const toWorld = ([x, y, z]) => [x, z, -y];

const BOUNDS = { center: [0, 0, 0], radius: 10 };
const norm = (v) => {
  const l = Math.hypot(...v) || 1;
  return v.map((c) => c / l);
};
const sub = (a, b) => a.map((c, i) => c - b[i]);

describe("headless render angles", () => {
  it("covers every canonical view the viewer offers", () => {
    expect(RENDER_VIEWS).toEqual(CANONICAL_VIEWS);
  });

  it("points each camera the same way as the viewer's matching view", () => {
    for (const view of CANONICAL_VIEWS) {
      const pose = cameraPoseForView(view, BOUNDS);
      // direction from the part centre toward the camera, in world space
      const viewerDir = norm(sub(pose.position, BOUNDS.center));
      const headlessDir = norm(toWorld(RENDER_ANGLES[view].dir));

      for (const [i, c] of headlessDir.entries())
        expect(c, `${view} dir[${i}]`).toBeCloseTo(viewerDir[i], 6);
    }
  });

  it("orients each camera the same way up as the viewer's matching view", () => {
    for (const view of CANONICAL_VIEWS) {
      const pose = cameraPoseForView(view, BOUNDS);
      const headlessUp = norm(toWorld(RENDER_ANGLES[view].up));

      for (const [i, c] of headlessUp.entries())
        expect(c, `${view} up[${i}]`).toBeCloseTo(norm(pose.up)[i], 6);
    }
  });

  it("never makes `up` parallel to the view axis (a degenerate camera basis)", () => {
    for (const view of CANONICAL_VIEWS) {
      const { dir, up } = RENDER_ANGLES[view];
      const cross = [
        up[1] * dir[2] - up[2] * dir[1],
        up[2] * dir[0] - up[0] * dir[2],
        up[0] * dir[1] - up[1] * dir[0],
      ];
      expect(Math.hypot(...cross), `${view}`).toBeGreaterThan(1e-6);
    }
  });
});

describe("headless render of view-cube angles (animation camera cues)", () => {
  it("points every cue angle the same way as the viewer", () => {
    for (const view of CAMERA_CUE_VIEWS) {
      const pose = cameraPoseForView(view, BOUNDS);
      const viewerDir = norm(sub(pose.position, pose.target));
      const headlessDir = norm(toWorld(renderAngle(view).dir));
      headlessDir.forEach((c, i) => expect(c).toBeCloseTo(viewerDir[i], 6));
    }
  });

  it("refuses a name that is not an angle", () => {
    expect(renderAngle("sideways")).toBeNull();
    expect(renderAngle("constructor")).toBeNull();
  });
});
