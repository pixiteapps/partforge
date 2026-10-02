import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import {
  captureViewsFromScene, captureCurrentFromScene, srgbEncodeInPlace,
  thumbnailBackground, THUMBNAIL_BG,
} from "../src/framework/viewer.js";
import { CANONICAL_VIEWS, cameraPoseForView } from "../src/framework/view-angles.js";

// captureViewsFromScene is the pure-ish core extracted so it can run without a
// live GL context: it takes an injected renderer with render()/readPixels()/
// encode() and asserts it never touches the passed live camera.
describe("captureViewsFromScene", () => {
  it("does not mutate the live camera position", () => {
    const liveCamera = new THREE.PerspectiveCamera();
    liveCamera.position.set(18, 12, 18);
    const before = liveCamera.position.toArray();

    const fakeRenderer = {
      renderOffscreen: vi.fn(() => "data:image/jpeg;base64,AAAA"),
    };
    const grid = { visible: true };
    const out = captureViewsFromScene(["front", "top"], {
      renderer: fakeRenderer,
      liveCamera,
      grid,
      bounds: { center: [0, 0, 0], radius: 10 },
    });

    expect(liveCamera.position.toArray()).toEqual(before); // untouched
    expect(grid.visible).toBe(true);                        // restored
    expect(out.map((o) => o.view)).toEqual(["front", "top"]);
    expect(out[0].dataUrl).toMatch(/^data:image\/jpeg/);
    expect(fakeRenderer.renderOffscreen).toHaveBeenCalledTimes(2);
  });

  it("renders the full canonical set (7 views), not just the first 6", () => {
    const liveCamera = new THREE.PerspectiveCamera();
    liveCamera.position.set(18, 12, 18);

    const fakeRenderer = {
      renderOffscreen: vi.fn(() => "data:image/jpeg;base64,AAAA"),
    };
    const grid = { visible: true };
    const out = captureViewsFromScene(CANONICAL_VIEWS, {
      renderer: fakeRenderer,
      liveCamera,
      grid,
      bounds: { center: [0, 0, 0], radius: 10 },
    });

    expect(out.map((o) => o.view)).toEqual(CANONICAL_VIEWS);
    expect(fakeRenderer.renderOffscreen).toHaveBeenCalledTimes(CANONICAL_VIEWS.length);
  });
});

describe("captureViewsFromScene poseFor", () => {
  it("frames each view with poseFor(view) when given, in place of cameraPoseForView(view, bounds)", () => {
    const liveCamera = new THREE.PerspectiveCamera();
    const fakeRenderer = { renderOffscreen: vi.fn(() => "data:image/jpeg;base64,AAAA") };
    const poseFor = vi.fn((view) => ({ position: [view.length, 2, 3], up: [0, 1, 0], target: [0, 0, 0] }));
    const sceneBounds = { center: [0, 0, 0], radius: 5 };
    captureViewsFromScene(["front", "iso"], {
      renderer: fakeRenderer, liveCamera, grid: null, bounds: { center: [0, 0, 0], radius: 10 }, sceneBounds, poseFor,
    });
    expect(poseFor.mock.calls.map((c) => c[0])).toEqual(["front", "iso"]);
    expect(fakeRenderer.renderOffscreen.mock.calls).toEqual([
      [{ position: [5, 2, 3], up: [0, 1, 0], target: [0, 0, 0] }, { sceneBounds }],
      [{ position: [3, 2, 3], up: [0, 1, 0], target: [0, 0, 0] }, { sceneBounds }],
    ]);
  });

  it("without poseFor, frames with cameraPoseForView(view, bounds)", () => {
    const fakeRenderer = { renderOffscreen: vi.fn(() => "data:image/jpeg;base64,AAAA") };
    const bounds = { center: [1, 2, 3], radius: 10 };
    captureViewsFromScene(["top"], { renderer: fakeRenderer, liveCamera: new THREE.PerspectiveCamera(), grid: null, bounds });
    expect(fakeRenderer.renderOffscreen.mock.calls[0][0]).toEqual(cameraPoseForView("top", bounds));
  });
});

// captureCurrentFromScene is the same injected-renderer core for the showcase
// capture: one offscreen render of the LIVE camera's pose at a caller-chosen
// resolution, matching the live viewport's aspect (long edge = `size`).
describe("captureCurrentFromScene", () => {
  function setup({ aspect = 2, fov = 45 } = {}) {
    const liveCamera = new THREE.PerspectiveCamera(fov, aspect);
    liveCamera.position.set(18, 12, 18);
    const fakeRenderer = { renderOffscreen: vi.fn(() => "data:image/jpeg;base64,AAAA") };
    const grid = { visible: true };
    return { liveCamera, fakeRenderer, grid };
  }

  it("renders once from the live camera pose at the requested long-edge size", () => {
    const { liveCamera, fakeRenderer, grid } = setup({ aspect: 2, fov: 30 });
    const out = captureCurrentFromScene({ size: 2048 }, {
      renderer: fakeRenderer, liveCamera, target: [1, 2, 3], grid, maxTextureSize: 8192,
    });
    expect(out).toMatch(/^data:image\/jpeg/);
    expect(fakeRenderer.renderOffscreen).toHaveBeenCalledTimes(1);
    const [pose, opts] = fakeRenderer.renderOffscreen.mock.calls[0];
    expect(pose.position).toEqual([18, 12, 18]);
    expect(pose.up).toEqual([0, 1, 0]); // camera default up
    expect(pose.target).toEqual([1, 2, 3]);
    expect(opts).toMatchObject({ width: 2048, height: 1024, fov: 30, quality: 0.9 });
  });

  it("puts the long edge on height for a portrait viewport", () => {
    const { liveCamera, fakeRenderer, grid } = setup({ aspect: 0.5 });
    captureCurrentFromScene({ size: 1000 }, {
      renderer: fakeRenderer, liveCamera, target: [0, 0, 0], grid, maxTextureSize: 8192,
    });
    const [, opts] = fakeRenderer.renderOffscreen.mock.calls[0];
    expect(opts).toMatchObject({ width: 500, height: 1000 });
  });

  it("clamps size into [256, maxTextureSize]", () => {
    const { liveCamera, fakeRenderer, grid } = setup({ aspect: 1 });
    captureCurrentFromScene({ size: 999999 }, {
      renderer: fakeRenderer, liveCamera, target: [0, 0, 0], grid, maxTextureSize: 4096,
    });
    captureCurrentFromScene({ size: 1 }, {
      renderer: fakeRenderer, liveCamera, target: [0, 0, 0], grid, maxTextureSize: 4096,
    });
    expect(fakeRenderer.renderOffscreen.mock.calls[0][1]).toMatchObject({ width: 4096, height: 4096 });
    expect(fakeRenderer.renderOffscreen.mock.calls[1][1]).toMatchObject({ width: 256, height: 256 });
  });

  it("hides the grid for the render and restores it after (default)", () => {
    const { liveCamera, grid } = setup();
    let visibleDuringRender = null;
    const fakeRenderer = {
      renderOffscreen: vi.fn(() => {
        visibleDuringRender = grid.visible;
        return "data:image/jpeg;base64,AAAA";
      }),
    };
    captureCurrentFromScene({}, {
      renderer: fakeRenderer, liveCamera, target: [0, 0, 0], grid, maxTextureSize: 8192,
    });
    expect(visibleDuringRender).toBe(false);
    expect(grid.visible).toBe(true); // restored
  });

  it("keeps the grid visible when hideGrid is false", () => {
    const { liveCamera, grid } = setup();
    let visibleDuringRender = null;
    const fakeRenderer = {
      renderOffscreen: vi.fn(() => {
        visibleDuringRender = grid.visible;
        return "data:image/jpeg;base64,AAAA";
      }),
    };
    captureCurrentFromScene({ hideGrid: false }, {
      renderer: fakeRenderer, liveCamera, target: [0, 0, 0], grid, maxTextureSize: 8192,
    });
    expect(visibleDuringRender).toBe(true);
    expect(grid.visible).toBe(true);
  });

  it("never mutates the live camera and forwards a custom quality", () => {
    const { liveCamera, fakeRenderer, grid } = setup();
    const before = liveCamera.position.toArray();
    captureCurrentFromScene({ quality: 0.7 }, {
      renderer: fakeRenderer, liveCamera, target: [0, 0, 0], grid, maxTextureSize: 8192,
    });
    expect(liveCamera.position.toArray()).toEqual(before);
    expect(fakeRenderer.renderOffscreen.mock.calls[0][1]).toMatchObject({ quality: 0.7 });
  });

  it("restores the grid even when the offscreen render throws", () => {
    const { liveCamera, grid } = setup();
    const fakeRenderer = { renderOffscreen: vi.fn(() => { throw new Error("GL lost"); }) };
    expect(() => captureCurrentFromScene({}, {
      renderer: fakeRenderer, liveCamera, target: [0, 0, 0], grid, maxTextureSize: 8192,
    })).toThrow("GL lost");
    expect(grid.visible).toBe(true);
  });
});

// Render-target readback is in the linear working space (three only applies
// outputColorSpace on the canvas path), so captures must be encoded before they go into
// a JPEG — skipping this is what made them look dark.
describe("srgbEncodeInPlace", () => {
  it("brightens midtones, pins the endpoints, and leaves alpha alone", () => {
    // one pixel per channel plus a grey, all at alpha 200
    const data = new Uint8ClampedArray([
      0, 0, 0, 200,
      255, 255, 255, 200,
      128, 64, 32, 200,
    ]);

    expect(srgbEncodeInPlace(data)).toBe(data); // in place

    expect([data[0], data[1], data[2]]).toEqual([0, 0, 0]);
    expect([data[4], data[5], data[6]]).toEqual([255, 255, 255]);
    // sRGB transfer of linear 128/255 ≈ 0.7366 → 188
    expect(data[8]).toBe(188);
    expect(data[9]).toBe(137);
    expect(data[10]).toBe(99);
    // every channel got brighter; alpha never touched
    expect(data[8]).toBeGreaterThan(128);
    expect([data[3], data[7], data[11]]).toEqual([200, 200, 200]);
  });

  it("is monotonic across the whole 8-bit range", () => {
    const data = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) data[i * 4] = i;
    srgbEncodeInPlace(data);
    for (let i = 1; i < 256; i++) expect(data[i * 4]).toBeGreaterThanOrEqual(data[(i - 1) * 4]);
  });
});

// renderMeshPayloads — the off-loop thumbnail render behind runtime.captureView —
// builds a THROWAWAY scene, so unlike the two captures above it inherits no
// background from the live scene's theme. It used to set none at all, and every
// thumbnail came back on the renderer's default opaque black. This is the whole
// of that decision, split out because renderMeshPayloads itself needs a GL context.
describe("thumbnailBackground", () => {
  it("defaults to the neutral thumbnail grey", () => {
    expect(thumbnailBackground()).toEqual(new THREE.Color(THUMBNAIL_BG));
  });

  it("is theme-independent: neither viewer background", () => {
    // A thumbnail is baked at capture time and shown later under host chrome
    // partforge cannot see, so following either theme would be wrong half the time.
    expect(THUMBNAIL_BG).not.toBe(0x15181d); // THEME.dark.bg
    expect(THUMBNAIL_BG).not.toBe(0xe9edf2); // THEME.light.bg
  });

  it("honours an explicit colour", () => {
    expect(thumbnailBackground(0x112233)).toEqual(new THREE.Color(0x112233));
  });

  it("passes null through as no background, rather than taking the default", () => {
    // The escape hatch back to the pre-0.52 behaviour. Only an ABSENT option
    // (undefined) means "unset" — Scene.background wants a literal null here.
    expect(thumbnailBackground(null)).toBe(null);
  });

  it("survives the render's colour-management round trip", () => {
    // THREE.Color converts an sRGB hex into the LINEAR working space; the render
    // target reads back linear 8-bit; srgbEncodeInPlace converts back. A missing
    // encode step would land this near 38, not 107 — the muddy-capture bug that
    // SRGB8 exists to fix. ±2 is the 8-bit LUT's own rounding.
    const c = new THREE.Color(THUMBNAIL_BG);
    const bytes = new Uint8ClampedArray([
      Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255), 255,
    ]);
    srgbEncodeInPlace(bytes);
    for (const [i, expected] of [(THUMBNAIL_BG >> 16) & 0xff, (THUMBNAIL_BG >> 8) & 0xff, THUMBNAIL_BG & 0xff].entries()) {
      expect(Math.abs(bytes[i] - expected)).toBeLessThanOrEqual(2);
    }
  });
});

describe("captureViewsFromScene hidden objects", () => {
  it("hides extras for the pass and restores them", () => {
    const calls = [];
    const renderer = { renderOffscreen: () => { calls.push({ grid: grid.visible, dim: dim.visible }); return "data:,"; } };
    const liveCamera = { position: new THREE.Vector3(1, 2, 3), aspect: 1 };
    const grid = { visible: true };
    const dim = { visible: true };
    captureViewsFromScene(["iso"], {
      renderer, liveCamera, grid, hidden: [dim],
      bounds: { center: [0, 0, 0], radius: 10 },
    });
    expect(calls[0]).toEqual({ grid: false, dim: false });
    expect(dim.visible).toBe(true);
    expect(grid.visible).toBe(true);
  });

  it("restores an already-hidden extra to hidden", () => {
    const renderer = { renderOffscreen: () => "data:," };
    const liveCamera = { position: new THREE.Vector3(0, 0, 5), aspect: 1 };
    const dim = { visible: false };
    captureViewsFromScene(["iso"], {
      renderer, liveCamera, grid: null, hidden: [dim],
      bounds: { center: [0, 0, 0], radius: 10 },
    });
    expect(dim.visible).toBe(false);
  });
});

// `recenter: true` asks captureCurrentFromScene to render the largest centred
// sub-window that keeps the whole visible geometry — through the SAME camera the
// render uses, so the extent is exact — and to leave the framing alone when the
// geometry runs off the frame. The renderer is faked; the frame math itself is
// covered in capture-frame.test.js.
describe("captureCurrentFromScene recenter", () => {
  function meshAt(x) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(
      [x - 2, -1, 0, x + 2, -1, 0, x + 2, 1, 0, x - 2, 1, 0], 3));
    return new THREE.Mesh(geo);
  }
  // Camera 10 down +Z, 90° fov, square frame: (x, y, 0) → NDC (x/10, y/10).
  function setup(meshes) {
    const liveCamera = new THREE.PerspectiveCamera(90, 1);
    liveCamera.position.set(0, 0, 10);
    const fakeRenderer = { renderOffscreen: vi.fn(() => "data:image/jpeg;base64,AAAA") };
    return {
      renderer: fakeRenderer, liveCamera, target: [0, 0, 0], grid: { visible: true },
      maxTextureSize: 8192, meshes,
    };
  }

  it("renders an offset sub-window when the whole part is in view but off-centre", () => {
    const deps = setup([meshAt(3)]);
    const out = captureCurrentFromScene({ size: 1000, recenter: true }, deps);
    expect(out).toMatch(/^data:image\/jpeg/);
    const [pose, opts] = deps.renderer.renderOffscreen.mock.calls[0];
    expect(pose.position).toEqual([0, 0, 10]);
    // Extent x 0.55..0.75 → centre 0.65 → crop x 0.3, width 0.7 → 700×1000.
    expect(opts).toMatchObject({ width: 700, height: 1000, fov: 90, quality: 0.9 });
    expect(opts.viewOffset.fullWidth).toBeCloseTo(1000, 5);
    expect(opts.viewOffset.fullHeight).toBeCloseTo(1000, 5);
    expect(opts.viewOffset.x).toBeCloseTo(300, 5);
    expect(opts.viewOffset.y).toBeCloseTo(0, 5);
  });

  it("keeps the user's framing when the part runs off the frame", () => {
    const deps = setup([meshAt(9)]);
    captureCurrentFromScene({ size: 1000, recenter: true }, deps);
    const [, opts] = deps.renderer.renderOffscreen.mock.calls[0];
    expect(opts).toMatchObject({ width: 1000, height: 1000 });
    expect(opts.viewOffset).toBeUndefined();
  });

  it("keeps the framing when already centred, and without recenter at all", () => {
    const centred = setup([meshAt(0)]);
    captureCurrentFromScene({ size: 1000, recenter: true }, centred);
    expect(centred.renderer.renderOffscreen.mock.calls[0][1].viewOffset).toBeUndefined();

    const off = setup([meshAt(3)]);
    captureCurrentFromScene({ size: 1000 }, off);
    expect(off.renderer.renderOffscreen.mock.calls[0][1]).toMatchObject({ width: 1000, height: 1000 });
    expect(off.renderer.renderOffscreen.mock.calls[0][1].viewOffset).toBeUndefined();
  });

  it("still never touches the live camera", () => {
    const deps = setup([meshAt(3)]);
    const before = deps.liveCamera.position.toArray();
    captureCurrentFromScene({ size: 1000, recenter: true }, deps);
    expect(deps.liveCamera.position.toArray()).toEqual(before);
    expect(deps.liveCamera.view).toBeNull(); // no view offset leaked onto the live camera
    expect(deps.grid.visible).toBe(true);
  });
});
