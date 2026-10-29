// Pure snap index: corners, edge chains, and snap ranking on hand-built payloads.
import { describe, expect, test } from "vitest";
import {
  buildSnapIndex, findSnap, SNAP_PX, CURVE_TURN_DEG, COLLINEAR_TURN_DEG,
} from "../../../src/framework/measure/snaps.js";
import { classifyFeature } from "../../../src/framework/measure/feature-dims.js";

// --- fixtures --------------------------------------------------------------

const W = 20, D = 10, H = 2;
const BOX_CORNERS = [
  [0, 0, 0], [W, 0, 0], [W, D, 0], [0, D, 0],
  [0, 0, H], [W, 0, H], [W, D, H], [0, D, H],
];

function boxEdges() {
  const e = [];
  const pairs = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (const [a, b] of pairs) e.push(...BOX_CORNERS[a], ...BOX_CORNERS[b]);
  return e;
}

// 20×10×2 box as a triangle soup; the top face (z = H) is feature 1, the rest unnamed.
function boxPayload() {
  const c = BOX_CORNERS;
  const quads = [
    [[0, 3, 2, 1], 0], [[4, 5, 6, 7], 1], // bottom, top
    [[0, 1, 5, 4], 0], [[1, 2, 6, 5], 0], [[2, 3, 7, 6], 0], [[3, 0, 4, 7], 0],
  ];
  const pos = [], ids = [];
  for (const [[a, b, cc, d], id] of quads) {
    pos.push(...c[a], ...c[b], ...c[cc], ...c[a], ...c[cc], ...c[d]);
    ids.push(id, id);
  }
  return {
    positions: new Float32Array(pos), indices: null,
    featureIds: new Uint16Array(ids), features: ["top"],
    edgePositions: new Float32Array(boxEdges()),
  };
}

const HOLE = { cx: 10, cy: 5, r: 3 };
const rimPoint = (i, segments, z) => {
  const a = (2 * Math.PI * i) / segments;
  return [HOLE.cx + HOLE.r * Math.cos(a), HOLE.cy + HOLE.r * Math.sin(a), z];
};

// The box with a vertical hole through it, feature 2 = the hole wall. Only the
// top rim is a drawn edge (the fixture's choice), so an 8-segment rim adds 8
// corners to the box's 8. Indexed geometry, to cover that path too.
function holedBoxPayload({ segments }) {
  const verts = [], tris = [], ids = [];
  const v = (p) => { verts.push(...p); return verts.length / 3 - 1; };
  const box = boxPayload();
  // box faces minus nothing (the top face keeps feature 1; its plate triangles
  // are a stand-in — ownership only needs vertex keys)
  for (let t = 0; t < box.featureIds.length; t++) {
    const p = box.positions;
    tris.push(v([p[t * 9], p[t * 9 + 1], p[t * 9 + 2]]), v([p[t * 9 + 3], p[t * 9 + 4], p[t * 9 + 5]]), v([p[t * 9 + 6], p[t * 9 + 7], p[t * 9 + 8]]));
    ids.push(box.featureIds[t]);
  }
  const bot = [], top = [];
  for (let i = 0; i < segments; i++) { bot.push(v(rimPoint(i, segments, 0))); top.push(v(rimPoint(i, segments, H))); }
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    tris.push(bot[i], top[j], bot[j], bot[i], top[i], top[j]);
    ids.push(2, 2);
  }
  const edges = boxEdges();
  for (let i = 0; i < segments; i++) edges.push(...rimPoint(i, segments, H), ...rimPoint(i + 1, segments, H));
  return {
    positions: new Float32Array(verts), indices: new Uint32Array(tris),
    featureIds: new Uint16Array(ids), features: ["top", "hole"],
    edgePositions: new Float32Array(edges),
  };
}

// Looking straight down -Z at 10 px per mm: a geometry point (x, y, z) lands at (10x, 10y).
const PX_PER_MM = 10;
const project = (p) => [p[0] * PX_PER_MM, p[1] * PX_PER_MM];

// A query whose pointer sits at `px` and hits the surface at depth `z`.
function q(px, { featureId = 1, spec = null, z = H } = {}) {
  return {
    hitPoint: [px[0] / PX_PER_MM, px[1] / PX_PER_MM, z],
    hitFeatureId: featureId,
    featureSpec: spec,
    project,
    pointerPx: px,
    radiusWorld: SNAP_PX / PX_PER_MM,
    snapPx: SNAP_PX,
  };
}

// --- tests -----------------------------------------------------------------

test("constants", () => {
  expect(SNAP_PX).toBe(12);
  expect(CURVE_TURN_DEG).toBe(20);
  expect(COLLINEAR_TURN_DEG).toBe(0.5);
});

test("box corners are corners and a long edge is one straight chain", () => {
  const idx = buildSnapIndex(boxPayload());
  expect(idx.corners.length / 3).toBe(8);
  const top = idx.chains.filter((c) => c.owners.includes(1));
  expect(top).toHaveLength(4);
  expect(top.every((c) => c.straight)).toBe(true);
  expect(top.map((c) => c.length).sort((a, b) => a - b)).toEqual([10, 10, 20, 20]);
  expect(idx.chains).toHaveLength(12);
  expect(idx.cellSize).toBeCloseTo(Math.hypot(W, D, H) / 128);
  const long = top.find((c) => c.length === 20 && c.points.every((p) => p[1] === D));
  expect(long.mid).toEqual([10, D, H]);
});

test("a straight edge drawn as several collinear segments is still one chain", () => {
  const p = boxPayload();
  // replace the top front edge (y = 0, z = H) with four collinear pieces
  const e = Array.from(p.edgePositions);
  const out = [];
  for (let s = 0; s < e.length; s += 6) {
    const a = e.slice(s, s + 3), b = e.slice(s + 3, s + 6);
    if (a[1] === 0 && b[1] === 0 && a[2] === H && b[2] === H) {
      for (let k = 0; k < 4; k++) out.push(k * 5, 0, H, (k + 1) * 5, 0, H);
    } else out.push(...a, ...b);
  }
  p.edgePositions = new Float32Array(out);
  const idx = buildSnapIndex(p);
  expect(idx.corners.length / 3).toBe(8);
  const front = idx.chains.find((c) => c.owners.includes(1) && c.points.every((pt) => pt[1] === 0 && pt[2] === H));
  expect(front.straight).toBe(true);
  expect(front.points).toHaveLength(5);
  expect(front.length).toBe(20);
  expect(front.mid).toEqual([10, 0, H]);
});

test("hole rim vertices are never corners", () => {
  const idx = buildSnapIndex(holedBoxPayload({ segments: 64 }));
  expect(idx.corners.length / 3).toBe(8); // box corners only
  const rim = idx.chains.filter((c) => c.owners.includes(2));
  expect(rim).toHaveLength(1);
  expect(rim[0].straight).toBe(false);
  expect(rim[0].mid).toBeNull();
});

test("an 8-segment polygon's vertices are corners (accepted)", () => {
  expect(buildSnapIndex(holedBoxPayload({ segments: 8 })).corners.length / 3).toBe(16);
});

describe("ranking", () => {
  const idx = buildSnapIndex(boxPayload());

  test("corner beats midpoint beats edge within the snap radius", () => {
    // 5 px from the (20,10,2) corner, 3 px from the long top edge
    const t = findSnap(idx, q([196, 97]));
    expect(t.kind).toBe("corner");
    expect(t.point).toEqual([W, D, H]);
    expect(t.featureId).toBe(1);
  });

  test("midpoint beats edge", () => {
    // ~3.6 px from the long edge's midpoint (100,100), 3 px from the edge itself
    const t = findSnap(idx, q([102, 97]));
    expect(t.kind).toBe("midpoint");
    expect(t.point).toEqual([10, D, H]);
    expect(t.chain.straight).toBe(true);
    expect(t.chain.length).toBe(20);
  });

  test("away from corners and midpoints the edge wins, at the nearest point on it", () => {
    const t = findSnap(idx, q([60, 97]));
    expect(t.kind).toBe("edge");
    expect(t.point[0]).toBeCloseTo(6);
    expect(t.point[1]).toBeCloseTo(D);
    expect(t.point[2]).toBeCloseTo(H);
    expect(t.chain.owners).toContain(1);
  });

  test("ties within a kind go to the smaller pixel distance", () => {
    // the short edge's corners (0,10) and (0,0) are 100 px apart; the nearer one wins
    const t = findSnap(idx, q([4, 94]));
    expect(t.kind).toBe("corner");
    expect(t.point).toEqual([0, D, H]);
  });

  test("nothing in range gives face on a named feature", () => {
    const hit = q([100, 50]);
    const t = findSnap(idx, hit);
    expect(t.kind).toBe("face");
    expect(t.point).toEqual(hit.hitPoint);
    expect(t.featureId).toBe(1);
  });

  test("unnamed geometry only offers corner or point", () => {
    // bottom face (unnamed) seen from below would be odd; reuse the top's px with feature 0
    const nearMid = findSnap(idx, q([102, 97], { featureId: 0 }));
    expect(nearMid.kind).toBe("point");
    expect(nearMid.featureId).toBe(0);
    const nearEdge = findSnap(idx, q([60, 97], { featureId: 0 }));
    expect(nearEdge.kind).toBe("point");
    const nearCorner = findSnap(idx, q([196, 97], { featureId: 0 }));
    expect(nearCorner.kind).toBe("corner");
    expect(nearCorner.featureId).toBe(0);
  });

  test("a corner outside radiusWorld is not a candidate", () => {
    const query = { ...q([196, 97]), radiusWorld: 0.1 };
    expect(findSnap(idx, query).kind).not.toBe("corner");
  });
});

describe("circles", () => {
  const payload = holedBoxPayload({ segments: 64 });
  const idx = buildSnapIndex(payload);
  const holeSpec = classifyFeature(payload, 2);

  test("the hole wall classifies as a cylinder (fixture check)", () => {
    expect(holeSpec.kind).toBe("cylinder");
  });

  test("near the hole rim the target is the circle, at the rim centre", () => {
    // pointer right on the rim at (13, 5); the wall is hit just below the top
    const t = findSnap(idx, q([130, 50], { featureId: 2, spec: holeSpec, z: 1.9 }));
    expect(t.kind).toBe("circle");
    const nearer = Math.abs(holeSpec.anchors.top[2] - 1.9) < Math.abs(holeSpec.anchors.bottom[2] - 1.9)
      ? holeSpec.anchors.top : holeSpec.anchors.bottom;
    expect(nearer[2]).toBeCloseTo(H);
    expect(t.point).toEqual(nearer);
    expect(t.featureId).toBe(2);
    expect(t.chain.owners).toContain(2);
  });

  test("near the bottom of the wall the bottom rim centre is chosen", () => {
    const t = findSnap(idx, q([130, 50], { featureId: 2, spec: holeSpec, z: 0.1 }));
    expect(t.kind).toBe("circle");
    expect(t.point[2]).toBeCloseTo(0);
  });

  test("an undrawn rim attaches no chain (never the other rim)", () => {
    // only the top rim is a drawn edge in this fixture
    const t = findSnap(idx, q([130, 50], { featureId: 2, spec: holeSpec, z: 0.1 }));
    expect(t.kind).toBe("circle");
    expect(t.chain).toBeUndefined();
  });

  test("a circle target carries its rim geometry for the marker", () => {
    const t = findSnap(idx, q([130, 50], { featureId: 2, spec: holeSpec, z: 0.1 }));
    expect(t.circle.centre).toEqual(t.point);
    expect(t.circle.radius).toBeCloseTo(HOLE.r, 1);
    expect(Math.abs(t.circle.axis[2])).toBeCloseTo(1);
    expect(Math.hypot(...t.circle.axis)).toBeCloseTo(1);
  });

  test("chains are precomputed per feature with centroids", () => {
    const owned = idx.chains.filter((c) => c.owners.includes(2));
    expect(idx.chainsByFeature.get(2)).toEqual(owned);
    for (const c of idx.chains) expect(c.centroid).toHaveLength(3);
  });

  test("a non-cylinder spec offers no circle", () => {
    const t = findSnap(idx, q([130, 50], { featureId: 2, spec: { kind: "bbox" }, z: 1.9 }));
    expect(t.kind).toBe("edge");
  });

  test("unnamed hit near the rim never returns circle or edge", () => {
    const t = findSnap(idx, q([130, 50], { featureId: 0, spec: holeSpec, z: 1.9 }));
    expect(t.kind).toBe("point");
  });
});
