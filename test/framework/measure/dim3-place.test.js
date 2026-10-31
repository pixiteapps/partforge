import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  evaluateChoices, choicesEqual, placeDims, extremeVertex, specSig, laneCounts,
  HYSTERESIS, FLIP_DEADBAND_DEG, standoffNominal,
} from "../../../src/framework/measure/dim3-place.js";
import { bboxSpec } from "../../../src/framework/measure/feature-dims.js";
import { spanSpec } from "../../../src/framework/measure/readings.js";
import { expectSquareDim, cross, dot, norm } from "./drawing-rules.js";

// a 10×20×30 box as a soup of its 8 corners (enough for extreme scans)
function boxMeshData(min = [0, 0, 0], max = [10, 20, 30]) {
  const pts = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]])
    pts.push(x, y, z);
  return [{ positions: new Float32Array(pts), matrix: new THREE.Matrix4() }];
}
const CENTER = [5, 10, 15];

function overallItem() {
  return { id: "overall", tier: "static", spec: bboxSpec([0, 0, 0], [10, 20, 30]), meshes: [0] };
}

describe("evaluateChoices", () => {
  it("puts a dim in the plane FACING the camera (readability over nearness)", () => {
    // camera straight out along -Y: the X dim must lie in a plane whose
    // normal is Y (seen face-on), NOT extend toward the camera in a plane
    // seen edge-on — the original ext-dominant scoring got this backwards.
    const c = evaluateChoices([overallItem()], { camPos: [5, -100, 15], center: CENTER, prev: {} });
    expect(c["overall|ax0"].key).toBe("e2s1"); // ext +Z, plane normal Y
  });

  it("holds the previous plane within hysteresis, flips when clearly beaten", () => {
    const prev = evaluateChoices([overallItem()], { camPos: [5, -100, 15], center: CENTER, prev: {} });
    expect(prev["overall|ax0"].key).toBe("e2s1");
    // swing past the front/top diagonal, but not by 15%: held
    const near = evaluateChoices([overallItem()], { camPos: [5, -70, 110], center: CENTER, prev });
    expect(near["overall|ax0"].key).toBe("e2s1");
    // camera straight above: the Z-normal plane is now face-on — MUST flip
    const far = evaluateChoices([overallItem()], { camPos: [5, 10, 150], center: CENTER, prev });
    expect(far["overall|ax0"].key).toBe("e1s1");
  });

  it("choicesEqual detects change and sameness", () => {
    const a = evaluateChoices([overallItem()], { camPos: [5, -100, 15], center: CENTER, prev: {} });
    const b = evaluateChoices([overallItem()], { camPos: [5, -100, 15], center: CENTER, prev: a });
    expect(choicesEqual(a, b)).toBe(true);
    const c = evaluateChoices([overallItem()], { camPos: [5, 10, 150], center: CENTER, prev: {} });
    expect(choicesEqual(a, c)).toBe(false);
  });

  it("cylinder du holds within the deadband and re-aims past it", () => {
    const spec = {
      kind: "cylinder",
      values: { diameter: 8, depth: 10, partial: false },
      anchors: { center: [0, 0, 5], axis: [0, 0, 1], top: [0, 0, 10], bottom: [0, 0, 0], rimDir: [1, 0, 0] },
    };
    const item = { id: "h", tier: "hover", spec };
    const a = evaluateChoices([item], { camPos: [100, 0, 5], center: [0, 0, 5], prev: {} });
    expect(a["h|du"].du[0]).toBeCloseTo(1, 5);
    // 10° away: held
    const b = evaluateChoices([item], { camPos: [100, 18, 5], center: [0, 0, 5], prev: a });
    expect(b["h|du"].du[0]).toBeCloseTo(1, 5);
    // 90° away: re-aimed
    const c = evaluateChoices([item], { camPos: [0, 100, 5], center: [0, 0, 5], prev: a });
    expect(c["h|du"].du[1]).toBeCloseTo(1, 5);
  });

  it("cylinder du boundary: holds just under FLIP_DEADBAND_DEG, re-aims just past it", () => {
    const spec = {
      kind: "cylinder",
      values: { diameter: 8, depth: 10, partial: false },
      anchors: { center: [0, 0, 5], axis: [0, 0, 1], top: [0, 0, 10], bottom: [0, 0, 0], rimDir: [1, 0, 0] },
    };
    const item = { id: "h", tier: "hover", spec };
    const a = evaluateChoices([item], { camPos: [100, 0, 5], center: [0, 0, 5], prev: {} });
    expect(a["h|du"].du[0]).toBeCloseTo(1, 5);

    // Camera positions derived from tan(angle): with the camera's radial X held
    // at 100 and Y = 100·tan(angle), the resulting du sits exactly `angle` off
    // the previous du = (1,0,0) (the Z offset cancels out of the radial
    // projection). Stay 1° clear of the exact 25° boundary either way so
    // floating-point noise can't flip the outcome.
    const R = 100;
    const angleTo = (deg) => R * Math.tan((deg * Math.PI) / 180);

    const under = evaluateChoices([item], { camPos: [R, angleTo(24), 5], center: [0, 0, 5], prev: a });
    expect(under["h|du"].du[0]).toBeCloseTo(1, 5); // held at the previous du
    expect(under["h|du"].du[1]).toBeCloseTo(0, 5);

    const over = evaluateChoices([item], { camPos: [R, angleTo(26), 5], center: [0, 0, 5], prev: a });
    expect(over["h|du"].du[0]).toBeCloseTo(Math.cos((26 * Math.PI) / 180), 5); // re-aimed
    expect(over["h|du"].du[1]).toBeCloseTo(Math.sin((26 * Math.PI) / 180), 5);
  });
});

describe("extremeVertex", () => {
  it("finds the posed extreme and tie-breaks toward `near`", () => {
    const md = boxMeshData();
    const nearFront = new THREE.Vector3(10, 0, 0);
    const p = extremeVertex(md, 0, +1, nearFront); // max X, tied across 4 corners
    expect(p.x).toBe(10);
    expect(p.y).toBe(0); // tie broken toward y=0, z=0
    expect(p.z).toBe(0);
  });

  it("applies the pose matrix", () => {
    const md = boxMeshData();
    md[0].matrix = new THREE.Matrix4().makeTranslation(100, 0, 0);
    const p = extremeVertex(md, 0, +1, new THREE.Vector3(110, 0, 0));
    expect(p.x).toBe(110);
  });
});

describe("placeDims — bbox", () => {
  function place(camPos = [5, -100, 15]) {
    const items = [overallItem()];
    const choices = evaluateChoices(items, { camPos, center: CENTER, prev: {} });
    return placeDims(items, {
      meshData: boxMeshData(), surfaceHit: null,
      bounds: { min: [0, 0, 0], max: [10, 20, 30] },
    }, choices)[0];
  }

  it("emits three parametric linear dims", () => {
    const d = place();
    expect(d.dims.length).toBe(3);
    expect(d.dims.map((x) => x.label.text).sort()).toEqual(["10.00 mm", "20.00 mm", "30.00 mm"]);
    for (const dim of d.dims) {
      expect(dim.pA.length).toBe(3);
      expect(dim.baseA.length).toBe(3);
      expect(Math.hypot(...dim.ext)).toBeCloseTo(1, 6);
      expect(Math.hypot(...dim.dir)).toBeCloseTo(1, 6);
    }
  });

  it("staggers dims sharing an outward direction into lanes", () => {
    const d = place();
    // camera at -Y: the D dim (second) and H dim (third) both extend +X —
    // the later one stacks into the next lane; the X dim has its own direction
    expect(d.dims[0].ext[2]).toBe(1);
    expect(d.dims[1].ext[0]).toBe(1);
    expect(d.dims[2].ext[0]).toBe(1);
    expect(d.dims[0].lane).toBe(0);
    expect(d.dims[1].lane).toBe(0);
    expect(d.dims[2].lane).toBe(1);
  });

  it("suppresses duplicate values within an item (round/square parts)", () => {
    const items = [{ id: "overall", tier: "static", spec: bboxSpec([0, 0, 0], [8, 8, 10]), meshes: [0] }];
    const choices = evaluateChoices(items, { camPos: [4, -100, 5], center: [4, 4, 5], prev: {} });
    const d = placeDims(items, {
      meshData: boxMeshData([0, 0, 0], [8, 8, 10]), surfaceHit: null,
      bounds: { min: [0, 0, 0], max: [8, 8, 10] },
    }, choices)[0];
    expect(d.dims.map((x) => x.label.text).sort()).toEqual(["10.00 mm", "8.00 mm"]);
  });

  it("later item wins when two items measure the same thing", () => {
    const spec = bboxSpec([0, 0, 0], [10, 20, 30]);
    const items = [
      { id: "overall", tier: "static", spec, meshes: [0] },
      { id: "pin:body:bbox:0", tier: "pinned", pinned: true, spec, meshes: [0], paramName: "height" },
    ];
    const choices = evaluateChoices(items, { camPos: [5, -100, 15], center: CENTER, prev: {} });
    const drawings = placeDims(items, {
      meshData: boxMeshData(), surfaceHit: null,
      bounds: { min: [0, 0, 0], max: [10, 20, 30] },
    }, choices);
    expect(drawings.length).toBe(1);
    expect(drawings[0].itemId).toBe("pin:body:bbox:0");
  });

  it("continues stagger lanes from seeded lane counts (laneCounts round trip)", () => {
    const items = [overallItem()];
    const choices = evaluateChoices(items, { camPos: [5, -100, 15], center: CENTER, prev: {} });
    const env = { meshData: boxMeshData(), surfaceHit: null, bounds: { min: [0, 0, 0], max: [10, 20, 30] } };
    const base = placeDims(items, env, choices);
    // base: the X dim extends +Z (lane 0); D and H both extend +X (lanes 0, 1)
    const seed = laneCounts(base);
    const hoverItem = { id: "hover", tier: "hover", spec: bboxSpec([1, 1, 1], [9, 19, 29]), meshes: [0] };
    const hoverChoices = evaluateChoices([hoverItem], { camPos: [5, -100, 15], center: CENTER, prev: {} });
    const hover = placeDims([hoverItem], { ...env, lanes: seed }, hoverChoices)[0];
    // its X dim extends +Z too and must continue at lane 1, not restart at 0
    const xDim = hover.dims.find((d) => d.label.text === "8.00 mm");
    expect(xDim.ext[2]).toBe(1);
    expect(xDim.lane).toBe(1);
  });

  it("suppresses items whose sig was already drawn by another pass", () => {
    const items = [overallItem()];
    const choices = evaluateChoices(items, { camPos: [5, -100, 15], center: CENTER, prev: {} });
    const drawings = placeDims(items, {
      meshData: boxMeshData(), surfaceHit: null,
      bounds: { min: [0, 0, 0], max: [10, 20, 30] },
      suppress: new Set([specSig(items[0].spec)]),
    }, choices);
    expect(drawings).toEqual([]);
  });

  it("keeps every discovered point of the X dim on a single plane (coplanarity)", () => {
    // camPos [5,-100,15] picks e2s1 for axis0, i.e. extAxis=2, nAxis=1 — the
    // dim plane is a fixed y. With ext and dir flat in the plane, the scene's
    // per-frame assembly can never leave it.
    const d = place();
    const dim = d.dims[0];
    expect(dim.label.text).toBe("10.00 mm"); // sanity: this really is the X dim
    const ys = [dim.pA[1], dim.pB[1], dim.baseA[1], dim.baseB[1]];
    for (const y of ys) expect(y).toBeCloseTo(ys[0], 6);
    expect(dim.ext[1]).toBeCloseTo(0, 6);
    expect(dim.dir[1]).toBeCloseTo(0, 6);
  });

  it("anchors extension lines at the surfaceHit point's level along ext, square to the dim", () => {
    const items = [overallItem()];
    const choices = evaluateChoices(items, { camPos: [5, -100, 15], center: CENTER, prev: {} });
    // deliberately off the X dim's plane (y=99, nowhere near the box)
    const offPlaneHit = new THREE.Vector3(2, 99, 0);
    const d = placeDims(items, {
      meshData: boxMeshData(),
      surfaceHit: () => offPlaneHit,
      bounds: { min: [0, 0, 0], max: [10, 20, 30] },
    }, choices)[0];
    const dim = d.dims[0];
    // ext is +Z (e2s1), base A sits at the top face (z = 30). The anchor takes
    // the hit's level along ext (z = 0), not the bbox corner's (z = 30), but
    // stays on base A's ext line: x is the dim's own x (0, not the hit's 2)
    // and y is the dim plane's (not the hit's 99) — the hit can only slide an
    // anchor along its extension line, never tilt it.
    expect(dim.ext).toEqual([0, 0, 1]);
    expect(dim.pA[2]).toBeCloseTo(0, 6);
    expect(dim.pA[0]).toBeCloseTo(dim.baseA[0], 6);
    expect(dim.pA[1]).toBeCloseTo(dim.baseA[1], 6);
    expect(dim.pA[1]).not.toBeCloseTo(99, 3);
    expectSquareDim(dim);
  });

  it("formats labels in inches on request; values stay mm for matching", () => {
    const items = [overallItem()];
    const choices = evaluateChoices(items, { camPos: [5, -100, 15], center: CENTER, prev: {} });
    const d = placeDims(items, {
      meshData: boxMeshData(), surfaceHit: null,
      bounds: { min: [0, 0, 0], max: [10, 20, 30] }, units: "in",
    }, choices)[0];
    expect(d.dims.map((x) => x.label.text).sort()).toEqual(["0.394 in", "0.787 in", "1.181 in"]);
    expect(d.dims.map((x) => x.label.value).sort((a, b) => a - b)).toEqual([10, 20, 30]);
  });

  it("respects locked constants", () => {
    expect(standoffNominal(100)).toBe(10);
    expect(standoffNominal(10)).toBe(6);
    expect(HYSTERESIS).toBe(1.15);
    expect(FLIP_DEADBAND_DEG).toBe(25);
    // display distances (standoff, gap, arrows, overshoot, stagger, leader,
    // text) are screen-constant px in dim3-scene (spec amendments 2026-08-13)
  });
});

describe("placeDims — plane and cylinder", () => {
  it("plane emits width+height dims lying in the face plane", () => {
    const spec = {
      kind: "plane",
      values: { width: 10, height: 5 },
      anchors: {
        width: { a: [0, 0, 0], b: [10, 0, 0] },
        height: { a: [10, 0, 0], b: [10, 0, 5] },
        normal: [0, -1, 0],
      },
    };
    const item = { id: "h", tier: "hover", spec };
    const choices = evaluateChoices([item], { camPos: [5, -50, 2], center: [5, 0, 2], prev: {} });
    const d = placeDims([item], { bounds: { min: [0, 0, 0], max: [10, 0, 5] } }, choices)[0];
    expect(d.dims.map((x) => x.label.text).sort()).toEqual(["10.00 mm", "5.00 mm"]);
    for (const dim of d.dims) {
      // anchors on the face, ext in the face plane (normal -Y → all y = 0),
      // and feature dims hug their feature (reduced standoff)
      for (const p of [dim.pA, dim.pB, dim.baseA, dim.baseB]) expect(p[1]).toBeCloseTo(0, 6);
      expect(dim.ext[1]).toBeCloseTo(0, 6);
      expect(dim.standoffScale).toBeCloseTo(0.55, 6);
    }
  });

  it("full cylinder emits a ⌀ record + a depth dim; partial emits an R leader", () => {
    const full = {
      kind: "cylinder",
      values: { diameter: 8, depth: 10, partial: false },
      anchors: { center: [0, 0, 5], axis: [0, 0, 1], top: [0, 0, 10], bottom: [0, 0, 0], rimDir: [1, 0, 0] },
    };
    const item = { id: "h", tier: "hover", spec: full };
    const choices = evaluateChoices([item], { camPos: [100, 0, 5], center: [0, 0, 5], prev: {} });
    const d = placeDims([item], { bounds: { min: [-4, -4, 0], max: [4, 4, 10] } }, choices)[0];
    expect(d.diams.length).toBe(1);
    expect(d.diams[0].label.text).toBe("⌀8.00 mm");
    // camera at +X → du = +X (the projected ellipse's foreshortened axis);
    // the diameter line runs along dv = +Y, the WIDE axis, at radius 4
    expect(d.diams[0].rimA[1]).toBeCloseTo(4, 5);
    expect(d.diams[0].rimB[1]).toBeCloseTo(-4, 5);
    expect(d.dims.length).toBe(1);
    expect(d.dims[0].label.text).toBe("10.00 mm");
    // depth hangs off the tangential silhouette (±dv): its plane faces the
    // camera instead of chasing edge-on alignment with it
    expect(Math.abs(d.dims[0].ext[1])).toBeCloseTo(1, 5);

    const part = { ...full, values: { ...full.values, partial: true } };
    const d2 = placeDims([{ id: "h", tier: "hover", spec: part }], { bounds: { min: [-4, -4, 0], max: [4, 4, 10] } }, choices)[0];
    expect(d2.leaders.length).toBe(1);
    expect(d2.leaders[0].label.text).toBe("R4.00 mm");
    expect(d2.leaders[0].rim[0]).toBeCloseTo(4, 5); // on the arc, along rimDir
  });

  it("a clicked cylinder draws its ⌀ across the hole from the clicked side, at the clicked depth", () => {
    const spec = {
      kind: "cylinder",
      values: { diameter: 8, partial: false },
      anchors: {
        center: [0, 0, 5], axis: [0, 0, 1], top: [0, 0, 10], bottom: [0, 0, 0], rimDir: [1, 0, 0],
        at: [0, 0, 7], clickDir: [0, -1, 0],
      },
    };
    const item = { id: "first", tier: "pinned", spec };
    // the camera sits on +X: without the click, the line would run along Y anyway,
    // so put it on -Y to prove the click wins over the camera
    const choices = evaluateChoices([item], { camPos: [0, -100, 30], center: [0, 0, 5], prev: {} });
    const d = placeDims([item], { bounds: { min: [-4, -4, 0], max: [4, 4, 10] } }, choices)[0];
    expect(d.diams.length).toBe(1);
    const diam = d.diams[0];
    // rimA is the clicked side, rimB straight across through the centre
    expect(diam.rimA.map((v) => +v.toFixed(5) + 0)).toEqual([0, -4, 7]);
    expect(diam.rimB.map((v) => +v.toFixed(5) + 0)).toEqual([0, 4, 7]);
    // the label runs off the clicked end, outward
    expect(diam.du.map((v) => +v.toFixed(5) + 0)).toEqual([0, -1, 0]);
    expect(d.dims.length).toBe(0); // no depth value, no depth dim

    // the wall's reading adds the depth, spanning the whole wall, not up to the click
    const wall = { ...spec, values: { diameter: 8, depth: 10, partial: false } };
    const dw = placeDims([{ id: "first", tier: "pinned", spec: wall }], { bounds: { min: [-4, -4, 0], max: [4, 4, 10] } }, choices)[0];
    expect(dw.dims.length).toBe(1);
    expect(dw.dims[0].label.text).toBe("10.00 mm");
    expect([dw.dims[0].pA[2], dw.dims[0].pB[2]].sort((a, b) => a - b)).toEqual([0, 10]);

    const part = { ...spec, values: { ...spec.values, partial: true } };
    const d2 = placeDims([{ id: "first", tier: "pinned", spec: part }], { bounds: { min: [-4, -4, 0], max: [4, 4, 10] } }, choices)[0];
    expect(d2.leaders[0].rim.map((v) => +v.toFixed(5) + 0)).toEqual([0, -4, 7]);
  });
});

// The extreme scan is the single most expensive thing placement does — two
// linear passes over every vertex, per axis, per sign, i.e. twelve full passes
// over a soup that carries three points per triangle. placeBox asks for all six
// directions, so the soup is walked ONCE per (geometry, pose) and later calls
// read only the handful of vertices tied with an extreme. Read straight off the
// positions array: a counting proxy makes "did we walk the soup again?"
// observable.
describe("extremeVertex — scan reuse", () => {
  // A scatter with no two vertices sharing a coordinate, so each extreme has a
  // tie set of exactly one and a cached call's reads are countable.
  function countingScatter(n = 200) {
    const pts = [];
    for (let i = 0; i < n; i++) pts.push(i * 0.7, i * 1.1 + 0.3, i * 1.9 + 0.11);
    let reads = 0;
    const positions = new Proxy(pts, {
      get(target, key) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads++;
        return target[key];
      },
    });
    return { md: [{ positions, matrix: new THREE.Matrix4() }], reads: () => reads, size: pts.length };
  }

  it("walks the soup once for a geometry, then reads only the tied vertices", () => {
    const { md, reads, size } = countingScatter();
    extremeVertex(md, 0, +1, new THREE.Vector3(0, 0, 0));
    expect(reads()).toBeGreaterThan(size); // the cold build is two passes

    const before = reads();
    for (const axis of [0, 1, 2]) {
      extremeVertex(md, axis, +1, new THREE.Vector3(200, 200, 400));
      extremeVertex(md, axis, -1, new THREE.Vector3(0, 0, 0));
    }
    // six more directions, and between them they cost a small fraction of even
    // ONE pass over the soup — the tie sets, not the vertices
    expect(reads() - before).toBeLessThan(size / 4);
  });

  it("re-scans when the same geometry is re-posed", () => {
    const { md } = countingScatter();
    const top = extremeVertex(md, 0, +1, new THREE.Vector3(0, 0, 0)).x;
    md[0].matrix = new THREE.Matrix4().makeTranslation(100, 0, 0);
    expect(extremeVertex(md, 0, +1, new THREE.Vector3(0, 0, 0)).x).toBeCloseTo(top + 100, 6);
  });

  it("still tie-breaks toward `near` when answering from the cache", () => {
    const md = boxMeshData(); // 8 corners: every extreme is a 4-way tie
    expect(extremeVertex(md, 0, +1, new THREE.Vector3(10, 0, 0)).toArray()).toEqual([10, 0, 0]);
    expect(extremeVertex(md, 0, +1, new THREE.Vector3(10, 20, 30)).toArray()).toEqual([10, 20, 30]);
  });
});

describe("placeDims — edge and span", () => {
  const BOUNDS = { min: [0, 0, 0], max: [40, 40, 40] };
  const placeOne = (spec, camPos, center = [15, 2, 0.5]) => {
    const item = { id: "r", tier: "pinned", pinned: true, spec };
    const choices = evaluateChoices([item], { camPos, center, prev: {} });
    return { drawings: placeDims([item], { bounds: BOUNDS }, choices), choices };
  };

  it("span: axis-aligned dim lies on a parts axis", () => {
    const spec = spanSpec([0, 0, 0], [30, 4, 1]);
    for (const cam of [[15, -100, 0], [15, 2, 100], [-80, 60, 40]]) {
      const { drawings, choices } = placeOne(spec, cam);
      expect(choices["r|span"]).toBeDefined();
      const dims = drawings[0].dims;
      expect(dims.length).toBe(1);
      expectSquareDim(dims[0]);
      expect(dims[0].label.value).toBe(30);
      expect(dims[0].label.text).toBe("30.00 mm");
      expect(Math.abs(dims[0].dir[0])).toBeCloseTo(1, 9); // measured along X
      expect(dims[0].standoffScale).toBeCloseTo(0.55, 9);
      // the dim line runs between the two points' X coordinates
      expect(dims[0].baseA[0]).toBeCloseTo(0, 9);
      expect(dims[0].baseB[0]).toBeCloseTo(30, 9);
    }
  });

  it("span: the measured axis may point away from b (signed component)", () => {
    // a parallel-face gap whose first normal faces away from the second point
    const spec = spanSpec([0, 0, 10], [3, 2, 0], { faceNormals: [[0, 0, 1], [0, 0, -1]] });
    expect(spec.anchors.axis).toEqual([0, 0, 1]);
    const { drawings } = placeOne(spec, [100, -50, 5]);
    const dim = drawings[0].dims[0];
    expectSquareDim(dim);
    expect(dim.label.value).toBe(10);
    expect(dim.baseB[2] - dim.baseA[2]).toBeCloseTo(-10, 9);
  });

  const PARTS = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const CAMS = [[15, 20, 100], [100, 20, 0], [15, -100, 0], [-60, 80, 30], [-65, 80, 20]];
  // the weaker rule for general position: the dim plane holds a frame axis
  const expectPlaneHoldsAxis = (dim, d) => {
    expect(Math.abs(dot(norm(dim.dir), d))).toBeCloseTo(1, 9);
    expect(Math.abs(dot(norm(dim.ext), d))).toBeLessThan(1e-9);
    const n = norm(cross(dim.dir, dim.ext));
    expect(PARTS.some((k) => Math.abs(dot(k, n)) < 1e-9)).toBe(true);
  };

  it("span: straight dim reads the true distance and stays square to a frame axis", () => {
    const spec = spanSpec([0, 0, 0], [30, 40, 0], { straight: true });
    for (const cam of CAMS) {
      const { drawings, choices } = placeOne(spec, cam, [15, 20, 0]);
      expect(choices["r|span"].key).toMatch(/^k2/); // Z is the only axis ⊥ the line
      const dim = drawings[0].dims[0];
      expect(dim.label.value).toBe(50);
      expectSquareDim(dim);
    }
  });

  it("span: a straight dim in general position keeps a frame axis in its plane", () => {
    const spec = spanSpec([0, 0, 0], [20, 30, 40], { straight: true });
    const d = norm([20, 30, 40]);
    for (const cam of CAMS) {
      const dim = placeOne(spec, cam, [10, 15, 20]).drawings[0].dims[0];
      expect(dim.label.value).toBeCloseTo(Math.hypot(20, 30, 40), 2);
      expectPlaneHoldsAxis(dim, d);
    }
  });

  it("span: a gap between tilted parallel faces", () => {
    // normal tilted 30° about X: X is square to it, so ext is exactly ±X
    const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
    const n = [0, -s, c];
    const a = [0, 0, 0], b = [4, -s * 10 + 3 * c, c * 10 + 3 * s]; // 10 along n, 3 in-plane
    const spec = spanSpec(a, b, { faceNormals: [n, n] });
    expect(spec.values.distance).toBe(10);
    for (const cam of CAMS) {
      const dim = placeOne(spec, cam, [2, 0, 5]).drawings[0].dims[0];
      expect(dim.label.value).toBe(10);
      expectSquareDim(dim);
      expect(Math.abs(dim.ext[0])).toBe(1);
    }
    // general position: a normal square to no frame axis
    const g = norm([1, 2, 3]);
    const gspec = spanSpec([0, 0, 0], g.map((v) => v * 10), { faceNormals: [g, g] });
    for (const cam of CAMS) {
      const dim = placeOne(gspec, cam, [2, 3, 5]).drawings[0].dims[0];
      expect(dim.label.value).toBe(10);
      expectPlaneHoldsAxis(dim, g);
    }
  });

  it("edge: a nearly perpendicular axis gives ext exactly on that axis", () => {
    const spec = { kind: "edge", values: { length: 30 }, anchors: { a: [0, 0, 0], b: [30, 0.01, 0.02] } };
    for (const cam of [[15, -100, 0], [15, 0, 100]]) {
      const dim = placeOne(spec, cam, [15, 0, 0]).drawings[0].dims[0];
      expect(dim.ext.filter((v) => Math.abs(v) === 1).length).toBe(1);
      expectSquareDim(dim);
    }
  });

  it("edge: one dim, its length", () => {
    const spec = { kind: "edge", values: { length: 25 }, anchors: { a: [5, 0, 2], b: [30, 0, 2] } };
    for (const cam of [[15, -100, 2], [15, 0, 100]]) {
      const { drawings } = placeOne(spec, cam, [17, 0, 2]);
      expect(drawings.length).toBe(1);
      const dims = drawings[0].dims;
      expect(dims.length).toBe(1);
      expect(dims[0].label.value).toBe(25);
      expect(dims[0].pA).toEqual([5, 0, 2]);
      expect(dims[0].pB).toEqual([30, 0, 2]);
      expectSquareDim(dims[0]);
    }
  });

  it("edge: a sloped edge in a coordinate plane hangs its dim along the square axis", () => {
    const spec = { kind: "edge", values: { length: 50 }, anchors: { a: [0, 0, 0], b: [30, 0, 40] } };
    const { drawings } = placeOne(spec, [15, -100, 20], [15, 0, 20]);
    const dim = drawings[0].dims[0];
    expectSquareDim(dim);
    expect(Math.abs(dim.ext[1])).toBeCloseTo(1, 9);
  });
});
