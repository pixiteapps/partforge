// Free-form camera cues: `{ azimuth, elevation, distance? }` beside the named
// angles. The pose math, the lint rule, the timeline, the headless renderer and
// the inverse (the user's live view read back as a cue) must all agree.
import { describe, expect, test } from "vitest";
import {
  cameraPoseForView, cameraOrbitProblem, isCameraCue, cameraCueLabel, cameraCueForPose,
} from "../../src/framework/view-angles.js";
import { normalizeAnimation } from "../../src/framework/animation.js";
import { stylePose } from "../../src/framework/style-camera.js";
import { RENDER_STYLES } from "../../src/framework/renderStyles.js";
import { renderAngle } from "../../src/testing/render.js";
import { lintPart } from "../../src/lint.js";

const center = [1, 2, 3];
const radius = 10;
const dirOf = (pose) => {
  const d = pose.position.map((p, i) => p - pose.target[i]);
  const l = Math.hypot(...d);
  return d.map((x) => x / l);
};
const distOf = (pose) => Math.hypot(...pose.position.map((p, i) => p - pose.target[i]));
const close = (a, b) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 5));

describe("cameraPoseForView with an orbit", () => {
  test("lands on the named angles it describes", () => {
    const iso = { azimuth: 45, elevation: Math.asin(1 / Math.sqrt(3)) * 180 / Math.PI };
    close(dirOf(cameraPoseForView(iso, { center, radius })), dirOf(cameraPoseForView("iso", { center, radius })));
    for (const [name, azimuth, elevation] of [
      ["front", 0, 0], ["right", 90, 0], ["back", 180, 0], ["left", -90, 0], ["left", 270, 0],
      ["front-right", 45, 0], ["top", 0, 90], ["bottom", 0, -90], ["top-front", 0, 45],
    ]) {
      const named = cameraPoseForView(name, { center, radius });
      const orbit = cameraPoseForView({ azimuth, elevation }, { center, radius });
      close(dirOf(orbit), dirOf(named));
      expect(distOf(orbit)).toBeCloseTo(distOf(named), 6);
      expect(orbit.target).toEqual(center);
    }
  });

  test("a pole keeps the named top/bottom roll at azimuth 0 and turns with azimuth", () => {
    expect(cameraPoseForView({ azimuth: 0, elevation: 90 }, { center, radius }).up.map((v) => v + 0))
      .toEqual(cameraPoseForView("top", { center, radius }).up);
    expect(cameraPoseForView({ azimuth: 0, elevation: -90 }, { center, radius }).up.map((v) => v + 0))
      .toEqual(cameraPoseForView("bottom", { center, radius }).up);
    close(cameraPoseForView({ azimuth: 90, elevation: 90 }, { center, radius }).up, [-1, 0, 0]);
    expect(cameraPoseForView({ azimuth: 30, elevation: 20 }, { center, radius }).up).toEqual([0, 1, 0]);
  });

  test("distance multiplies the framing distance", () => {
    const one = distOf(cameraPoseForView({ azimuth: 30, elevation: 20 }, { center, radius }));
    expect(distOf(cameraPoseForView({ azimuth: 30, elevation: 20, distance: 2.5 }, { center, radius }))).toBeCloseTo(one * 2.5, 6);
  });

  test("a malformed orbit throws with its problem", () => {
    expect(() => cameraPoseForView({ azimuth: 0 }, { center, radius })).toThrow(/elevation/);
  });
});

describe("cameraOrbitProblem / isCameraCue", () => {
  test("accepts names and well-formed orbits", () => {
    expect(isCameraCue("iso")).toBe(true);
    expect(isCameraCue("top-back-left")).toBe(true);
    expect(isCameraCue({ azimuth: 30, elevation: 20 })).toBe(true);
    expect(isCameraCue({ azimuth: -400, elevation: -90, distance: 10 })).toBe(true);
  });
  test.each([
    [{ elevation: 0 }, /azimuth/],
    [{ azimuth: 0, elevation: "10" }, /elevation/],
    [{ azimuth: 0, elevation: 91 }, /-90\.\.90/],
    [{ azimuth: 0, elevation: 0, distance: 0 }, /distance/],
    [{ azimuth: 0, elevation: 0, distance: 11 }, /distance/],
    [{ azimuth: 0, elevation: 0, zoom: 2 }, /unknown key `zoom`/],
    [[0, 0], /object/],
    [null, /object/],
  ])("rejects %j", (v, re) => {
    expect(cameraOrbitProblem(v)).toMatch(re);
    expect(isCameraCue(v)).toBe(false);
  });
  test("rejects unknown names and non-cues", () => {
    expect(isCameraCue("sideways")).toBe(false);
    expect(isCameraCue(5)).toBe(false);
  });
});

test("cameraCueLabel names files and logs", () => {
  expect(cameraCueLabel("iso")).toBe("iso");
  expect(cameraCueLabel({ azimuth: 30, elevation: 17.5 })).toBe("az30-el17.5");
  expect(cameraCueLabel({ azimuth: -45, elevation: 20, distance: 1.5 })).toBe("azm45-el20-d1.5");
  expect(cameraCueLabel({ azimuth: 0, elevation: 0, distance: 1 })).toBe("az0-el0");
});

describe("cameraCueForPose (the live view read back as a cue)", () => {
  test("round-trips an orbit through its own pose", () => {
    for (const cue of [
      { azimuth: 30, elevation: 17.5 },
      { azimuth: -120.3, elevation: -40, distance: 1.75 },
      { azimuth: 180, elevation: 5, distance: 0.5 },
    ]) {
      const pose = cameraPoseForView(cue, { center, radius });
      expect(cameraCueForPose(pose, { center, radius })).toEqual({ cue, panned: 0 });
    }
  });
  test("reads a named angle as its orbit", () => {
    const pose = cameraPoseForView("front-right", { center, radius });
    expect(cameraCueForPose(pose, { center, radius }).cue).toEqual({ azimuth: 45, elevation: 0 });
  });
  test("a pole reads azimuth 0", () => {
    const pose = cameraPoseForView("top", { center, radius });
    expect(cameraCueForPose(pose, { center, radius }).cue).toEqual({ azimuth: 0, elevation: 90 });
  });
  test("reports a pan instead of dropping it silently", () => {
    const pose = cameraPoseForView({ azimuth: 30, elevation: 20 }, { center, radius });
    const target = [center[0] + 5, center[1], center[2]];
    const panned = { position: pose.position.map((p, i) => p + (target[i] - center[i])), target };
    expect(cameraCueForPose(panned, { center, radius })).toEqual({ cue: { azimuth: 30, elevation: 20 }, panned: 0.5 });
  });
  test("clamps distance into the lintable range, and is null on its target", () => {
    const far = cameraPoseForView({ azimuth: 0, elevation: 0, distance: 10 }, { center, radius });
    const farther = { position: far.position.map((p, i) => center[i] + (p - center[i]) * 3), target: center };
    expect(cameraCueForPose(farther, { center, radius }).cue.distance).toBe(10);
    expect(cameraCueForPose({ position: center, target: center }, { center, radius })).toBeNull();
  });
});

describe("animations carry orbit cues", () => {
  const base = (anims) => ({
    meta: { title: "T" },
    parameters: [{ id: "s", title: "S", advanced: [{ key: "a", label: "A", min: 0, max: 100, step: 1 }] }],
    defaults: { a: 0 },
    parts: { p: { views: ["v"], build: (k) => k.box({ size: [1, 1, 1] }) } },
    views: { v: { label: "V", animations: anims } },
  });
  const tracks = { a: [[0, 0], [1, 100]] };
  const cameraFindings = (anims) => {
    const r = lintPart(base(anims));
    return [...r.errors, ...r.warnings].filter((f) => f.rule === "animation-camera-invalid");
  };

  test("lint accepts an orbit in every camera position", () => {
    expect(cameraFindings({ x: { duration: 1, tracks, camera: { azimuth: 30, elevation: 20 } } })).toEqual([]);
    expect(cameraFindings({ x: { duration: 1, tracks, camera: [[0, "iso"], [0.5, { azimuth: 45, elevation: 17, distance: 1.4 }]] } })).toEqual([]);
    expect(cameraFindings({ x: { steps: [
      { label: "Start", camera: "iso", duration: 0.5 },
      { label: "Drop", camera: { azimuth: 45, elevation: 17 }, duration: 1, tracks },
    ] } })).toEqual([]);
  });

  test("lint names what is wrong with a malformed orbit", () => {
    const [f] = cameraFindings({ x: { duration: 1, tracks, camera: { azimuth: 30, elevation: 120 } } });
    expect(f.message).toMatch(/elevation.*-90\.\.90/);
    expect(f.path).toBe("views.v.animations.x.camera");
    const [g] = cameraFindings({ x: { steps: [{ label: "S", camera: { azimuth: 30 }, duration: 1, tracks }] } });
    expect(g.message).toMatch(/step 0 camera orbit needs a finite numeric `elevation`/);
    expect(cameraFindings({ x: { duration: 1, tracks, camera: [[0, { azimuth: 1, elevation: 1, distance: 50 }]] } })).toHaveLength(1);
  });

  test("an animation-level orbit is an intro cue; per-step and listed ones sweep", () => {
    const orbit = { azimuth: 45, elevation: 17 };
    expect(normalizeAnimation("x", { duration: 2, tracks, camera: orbit }).cues)
      .toEqual([{ t: 0, view: orbit, sweep: null }]);
    expect(normalizeAnimation("x", { duration: 2, tracks, camera: [[0, "iso"], [0.5, orbit]] }).cues[1])
      .toEqual({ t: 0.5, view: orbit, sweep: 1 });
    expect(normalizeAnimation("x", { steps: [
      { label: "A", camera: "iso", duration: 1 }, { label: "B", camera: orbit, duration: 3, tracks },
    ] }).cues[1]).toEqual({ t: 0.25, view: orbit, sweep: 3 });
  });
});

describe("headless stills", () => {
  test("renderAngle resolves an orbit to the same direction as the viewer", () => {
    const toWorld = ([x, y, z]) => [x, z, -y];
    const orbit = { azimuth: 30, elevation: 20 };
    const a = renderAngle(orbit);
    const l = Math.hypot(...a.dir);
    close(toWorld(a.dir).map((v) => v / l), dirOf(cameraPoseForView(orbit, { center: [0, 0, 0], radius: 1 })));
    expect(renderAngle({ azimuth: 30 })).toBeNull();
  });

  test("a fitted still scales its framing by the orbit's distance", () => {
    const box = { min: [-5, -2, -1], max: [5, 2, 1] };
    const style = RENDER_STYLES.cad;
    const near = stylePose(style, { azimuth: 30, elevation: 20 }, box).pose;
    const far = stylePose(style, { azimuth: 30, elevation: 20, distance: 2 }, box).pose;
    expect(distOf(far)).toBeCloseTo(distOf(near) * 2, 6);
    close(dirOf(far), dirOf(near));
    expect(Object.keys(stylePose(style, "iso", box)).sort()).toEqual(["fov", "pose", "sceneBounds"]);
  });
});
