// Ties (subdiv/ties.js, the backend's toMesh({ ties: true }), the generate payload's
// `ties`): each delivered vertex of a k.subdiv body tied to its limit triangle, so a viewer
// can re-pose the mesh from moved cage points with no kernel. Sent only when the sub-part's
// solid is one k.subdiv with no creases, delivered in its canonical frame, with every
// vertex tied; never a tie that does not put its vertex back where it was delivered.
import { beforeAll, describe, expect, test, vi } from "vitest";
import { bootManifoldKernel, handle } from "../src/testing.js";
import { resolveParams } from "../src/framework/part-model.js";
import { levelFor, subdivide, subdivPlan, applySubdivPlan, topologyKey, SUBDIV_TOLERANCE, SUBDIV_MAX_TRIANGLES } from "../src/framework/geometry/subdiv/surface.js";
import { tiesFor, tiesHold, placeFromTies, tieError, TIE_WEIGHT_SLACK } from "../src/framework/geometry/subdiv/ties.js";
import hand, { cageHand } from "../src/parts/cage-hand.js";
import whale from "../src/parts/organic-whale.js";
import { probePoses } from "../src/framework/pose-probe.js";
import { makeCageBase, tiesAgree } from "../src/framework/skin/cage-deform.js";

let k, kPrint;
beforeAll(async () => {
  k = await bootManifoldKernel({ quality: "preview" });
  kPrint = await bootManifoldKernel({ quality: "print" });
}, 120_000);

const gen = async (part, view, params = part.defaults, subparts = Object.keys(part.parts)) => {
  const post = vi.fn();
  await handle(k, part, { type: "generate", subparts, view, params }, post);
  const msgs = post.mock.calls.map(([m]) => m);
  const err = msgs.find((m) => m.type === "error");
  if (err) throw new Error(err.message ?? JSON.stringify(err));
  return msgs.find((m) => m.type === "meshes").meshes;
};

const bendsOf = (d) => Object.fromEntries(Object.keys(d).map((n) => [n, d[n].values]));
const handSnapshot = (p) => cageHand(k.cage, p, bendsOf(resolveParams(hand, { ...hand.defaults, ...p }).d)).snapshot();
const previewLevel = (s) => levelFor(s, SUBDIV_TOLERANCE.preview, { maxTriangles: SUBDIV_MAX_TRIANGLES.preview }).level;

// The worst distance between a vertex placed from its tie on the rest limit mesh of
// `snapshot` and its delivered position.
const restError = (mesh, snapshot) => {
  const rest = subdivide(snapshot, mesh.ties.level);
  return tieError(mesh.ties, mesh.positions, rest.positions, rest.indices);
};

// The hand with its build swapped (same params, derive, views).
const handWith = (build, extra = {}) => ({ ...hand, parts: { hand: { ...hand.parts.hand, build, ...extra } } });
const handCage = (kk, p, d) => cageHand(kk.cage, p, bendsOf(d));
const flatCut = (kk, c) => kk.box({ min: [-200, -200, c.bounds().min[2] - 8], max: [200, 200, c.bounds().min[2] + 3] });

// A box cage, its +x side pulled out (a small k.subdiv body).
const boxCage = (kk, at = [0, 0, 0]) => {
  const c = kk.cage({ box: { size: [40, 20, 20], segs: [2, 1, 1], center: at } });
  c.extrude("+x:0,0", { by: 15, scale: 0.6 });
  return c;
};

describe("the cage hand with its cut", () => {
  let mesh, snapshot;
  beforeAll(async () => {
    [mesh] = await gen(hand, "assembly");
    snapshot = handSnapshot({});
  }, 120_000);

  test("carries ties: the snapshot's topology key, the level the build chose, one tie per vertex", () => {
    expect(mesh.frame).toBe("canonical");
    expect(mesh.ties).toBeTruthy();
    const n = mesh.positions.length / 3;
    expect(mesh.ties.key).toBe(topologyKey(snapshot));
    expect(mesh.ties.level).toBe(previewLevel(snapshot));
    expect(mesh.ties.tri).toBeInstanceOf(Uint32Array);
    expect(mesh.ties.w).toBeInstanceOf(Float32Array);
    expect(mesh.ties.tri.length).toBe(n);
    expect(mesh.ties.w.length).toBe(2 * n);
    const planTris = subdivPlan(snapshot, mesh.ties.level).indices.length / 3;
    expect(mesh.ties.tri.reduce((a, b) => Math.max(a, b), 0)).toBeLessThan(planTris);
  });

  test("every vertex placed from its tie on the rest limit mesh is where it was delivered (1e-3 mm)", () => {
    expect(restError(mesh, snapshot)).toBeLessThan(1e-3);
  });

  test("at a second pose, the placed vertices match a real build there", async () => {
    // Pose B curls three fingers further; the topology does not change.
    const pB = { ...hand.defaults, indexKnuckle: 45, indexCurl: 60, middleKnuckle: 40, middleCurl: 55, ringKnuckle: 35, ringCurl: 50 };
    const sB = handSnapshot(pB);
    expect(topologyKey(sB)).toBe(mesh.ties.key);
    const L = applySubdivPlan(subdivPlan(snapshot, mesh.ties.level), sB.points);
    const placed = placeFromTies(mesh.ties, L.positions, L.indices);
    const [real] = await gen(hand, "assembly", pB);
    const near = nearestIndex(real.positions);
    // The cut face is the plane z = lowest delivered z (the flat), seam included.
    let zMin = Infinity;
    for (let i = 2; i < mesh.positions.length; i += 3) zMin = Math.min(zMin, mesh.positions[i]);
    const skin = [], cap = [];
    for (let v = 0; v < placed.length / 3; v++) {
      const d = near([placed[3 * v], placed[3 * v + 1], placed[3 * v + 2]]);
      (Math.abs(mesh.positions[3 * v + 2] - zMin) < 1e-4 ? cap : skin).push(d);
    }
    const max = (a) => a.reduce((m, x) => Math.max(m, x), 0);
    expect(skin.length, "skin vertices").toBeGreaterThan(0);
    expect(cap.length, "cut-face vertices").toBeGreaterThan(0);
    expect(max(skin), `skin: ${skin.length} vertices, worst distance to the pose-B build (mm)`).toBeLessThan(1e-2);
    expect(max(cap), `cut face: ${cap.length} vertices, worst distance to the pose-B build (mm)`).toBeLessThan(1e-2);
  }, 120_000);
});

// The hand's tie coverage: every digit's curl across its whole range (the others at their
// defaults) delivers ties, and the viewer's check (tiesAgree) takes them. 89° and 90° on the
// index were refused once: a sliver limit triangle at the fingertip (a 0.06 mm edge), whose
// corner vertex float32 rounding put 7e-6 mm outside it, a weight 1.1e-4 past [0, 1].
describe("the cage hand's tie coverage", () => {
  const curls = [0, 20, 40, 60, 75, 85, 88, 89, 90];
  const poses = [
    ...Object.keys(hand.defaults).filter((key) => key.endsWith("Curl") && key !== "thumbCurl")
      .flatMap((key) => curls.map((a) => [key, a])),
    ...[0, 20, 40, 60].map((a) => ["thumbCurl", a]),
  ];
  test.each(poses)("%s %i° delivers ties the viewer takes", async (key, a) => {
    const p = { ...hand.defaults, [key]: a };
    const [m] = await gen(hand, "assembly", p);
    expect(m.ties, "ties").toBeTruthy();
    const snapshot = probePoses(hand, "assembly", p, { scope: "build" }).get("hand").cages[0];
    expect(tiesAgree(makeCageBase(snapshot, m.ties), m.positions)).toBe(true);
  }, 120_000);
});

describe("no ties", () => {
  test("Review Focus 4: the hand with a sphere unioned on", async () => {
    const part = handWith((kk, p, d) => {
      const c = handCage(kk, p, d);
      return kk.subdiv(c).cut(flatCut(kk, c)).union(kk.sphere(8).translate([0, -13, 70]));
    });
    const [m] = await gen(part, "assembly");
    expect(m.ties).toBeUndefined();
    expect("ties" in m).toBe(false);
  }, 60_000);

  test("a creased cage", async () => {
    const part = { meta: { backend: "manifold" }, defaults: {}, views: { v: { label: "V" } },
      parts: { body: { views: ["v"], build: (kk) => { const c = boxCage(kk); c.crease("+z:0,0"); return kk.subdiv(c); } } } };
    const [m] = await gen(part, "v");
    expect(m.ties).toBeUndefined();
  });

  test("two cages in one sub-part", async () => {
    const part = { meta: { backend: "manifold" }, defaults: {}, views: { v: { label: "V" } },
      parts: { body: { views: ["v"], build: (kk) => kk.subdiv(boxCage(kk)).union(kk.subdiv(boxCage(kk, [0, 60, 0]))) } } };
    const [m] = await gen(part, "v");
    expect(m.ties).toBeUndefined();
  });

  test("a print-tier mesh", () => {
    kPrint.beginSubPart("x");
    try {
      const m = kPrint.subdiv(boxCage(kPrint)).toMesh({ quality: "print", ties: true });
      expect(m.ties).toBeUndefined();
    } finally { kPrint.endSubPart(); kPrint.cleanup?.(); }
  });

  test("a preview toMesh that does not ask for them", () => {
    k.beginSubPart("x");
    try {
      expect(k.subdiv(boxCage(k)).toMesh({ quality: "preview" }).ties).toBeUndefined();
      expect(k.subdiv(boxCage(k)).toMesh({ quality: "preview", ties: true }).ties).toBeTruthy();
    } finally { k.endSubPart(); k.cleanup?.(); }
  });

  test("a posed (not canonical) delivery", async () => {
    // place() asks its solid a question, so the pose is baked into the mesh.
    const part = { meta: { backend: "manifold" }, defaults: {}, views: { v: { label: "V" } },
      parts: { body: { views: ["v"], build: (kk) => kk.subdiv(boxCage(kk)), place: (s) => s.translate([-s.boundingBox().min[0], 0, 0]) } } };
    const [m] = await gen(part, "v");
    expect(m.frame).toBe("posed");
    expect(m.ties).toBeUndefined();
  });
});

describe("Review Focus 5: a moved, labelled or re-stamped solid gives correct ties or none", () => {
  const check = (m, snapshot) => {
    if (!m.ties) return "none";
    expect(restError(m, snapshot)).toBeLessThan(1e-3);
    return "ties";
  };

  test("k.subdiv(cage).label(\"x\") before the cut", async () => {
    const [m] = await gen(handWith((kk, p, d) => { const c = handCage(kk, p, d); return kk.subdiv(c).label("x").cut(flatCut(kk, c)); }), "assembly");
    expect(check(m, handSnapshot({}))).toBe("ties");
  }, 60_000);

  test("a label after the cut", async () => {
    const [m] = await gen(handWith((kk, p, d) => { const c = handCage(kk, p, d); return kk.subdiv(c).cut(flatCut(kk, c)).label("x"); }), "assembly");
    expect(check(m, handSnapshot({}))).toBe("ties");
  }, 60_000);

  test("a place() that moves the solid rigidly", async () => {
    const [m] = await gen(handWith(hand.parts.hand.build, { place: (s) => s.translate([30, 0, 5]).rotateZ(40) }), "assembly");
    expect(m.frame).toBe("canonical");
    expect(check(m, handSnapshot({}))).toBe("ties");
  }, 60_000);

  test("a build that translates the body after k.subdiv", async () => {
    const [m] = await gen(handWith((kk, p, d) => { const c = handCage(kk, p, d); return kk.subdiv(c).translate([10, 0, 0]).cut(flatCut(kk, c)); }), "assembly");
    expect(check(m, handSnapshot({}))).toBe("none");
  }, 60_000);

  test("a label after a translate", async () => {
    const [m] = await gen(handWith((kk, p, d) => { const c = handCage(kk, p, d); return kk.subdiv(c).translate([10, 0, 0]).label("x"); }), "assembly");
    expect(check(m, handSnapshot({}))).toBe("none");
  }, 60_000);
});

test("the whale gets ties", async () => {
  const [m] = await gen(whale, "whale");
  expect(m.ties).toBeTruthy();
  expect(restError(m, (await import("../src/parts/organic-whale.js")).whaleCage(k, whale.defaults).snapshot())).toBeLessThan(1e-3);
}, 60_000);

test("a part with no cage: the payload's keys are unchanged", async () => {
  const part = { meta: { backend: "manifold" }, defaults: {}, views: { v: { label: "V" } },
    parts: { box: { views: ["v"], build: (kk) => kk.box({ min: [0, 0, 0], max: [10, 10, 10] }).cut(kk.cylinder({ d: 3, h: 30 })) } } };
  const [m] = await gen(part, "v");
  // The keys before ties existed (no params, so no origins).
  expect(Object.keys(m)).toEqual(["name", "positions", "normals", "indices", "triangles", "edges", "featureIds", "features",
    "reads", "pieceKeys", "frame", "bindings"]);
});

test("the preview encoder ignores ties", async () => {
  const { encodePreviewGlb } = await import("../src/framework/gltf/encode-preview.js");
  const [m] = await gen(whale, "whale");
  expect(m.ties).toBeTruthy();
  const { ties, ...plain } = m;
  const a = await encodePreviewGlb({ meshes: [m] }), b = await encodePreviewGlb({ meshes: [plain] });
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
}, 60_000);

describe("tiesFor", () => {
  // One limit triangle, and a delivered mesh of one skin triangle inside it plus one cap
  // triangle that shares two of its vertices (the seam) and has one of its own.
  const limitPositions = Float64Array.of(0, 0, 0, 10, 0, 0, 0, 10, 0);
  const limitIndices = Uint32Array.of(0, 1, 2);
  const positions = Float32Array.of(1, 1, 0, 5, 1, 0, 1, 5, 0, /* cap */ 5, 1, 0, 1, 1, 0, 3, 3, -4);
  test("ties a skin vertex to its triangle, a seam vertex through the skin, and counts the rest", () => {
    const t = tiesFor({ positions, faceTri: Int32Array.of(0, -1), limitPositions, limitIndices });
    expect(t.untied).toBe(1);
    expect(Array.from(t.tri.subarray(0, 5))).toEqual([0, 0, 0, 0, 0]);
    expect(t.w[0]).toBeCloseTo(0.8); expect(t.w[1]).toBeCloseTo(0.1);
    expect([t.w[6], t.w[7]]).toEqual([t.w[2], t.w[3]]);   // cap vertex 3 = skin vertex 1
    expect([t.w[8], t.w[9]]).toEqual([t.w[0], t.w[1]]);   // cap vertex 4 = skin vertex 0
  });
  test("placing on the rest mesh gives the delivered skin back", () => {
    const t = tiesFor({ positions: positions.subarray(0, 9), faceTri: Int32Array.of(0), limitPositions, limitIndices });
    expect(t.untied).toBe(0);
    expect(tieError(t, positions.subarray(0, 9), limitPositions, limitIndices)).toBeLessThan(1e-6);
    expect(tiesHold(t, positions.subarray(0, 9), limitPositions, limitIndices)).toBe(true);
  });
  test("a vertex outside its triangle (in its plane) reproduces at rest but does not hold", () => {
    // (12, 1, 0) is in the triangle's plane but past its B corner: w0 < 0.
    const out = Float32Array.of(1, 1, 0, 12, 1, 0, 1, 5, 0);
    const t = tiesFor({ positions: out, faceTri: Int32Array.of(0), limitPositions, limitIndices });
    expect(t.untied).toBe(0);
    expect(t.w[2]).toBeLessThan(0);
    expect(tieError(t, out, limitPositions, limitIndices)).toBeLessThan(1e-6);
    expect(tiesHold(t, out, limitPositions, limitIndices)).toBe(false);
  });
  // A sliver at the hand's scale (z = 136 mm, one float32 step there is 1.5e-5 mm): corner B
  // sits 0.015 mm off edge AC, so corner A moved 7e-6 mm off AC, away from B, is a weight
  // past the slack.
  const sliver = Float64Array.of(30, 0, 136, 30.06, 0, 136, 30.8, 0.2, 136);
  const offAC = (d) => Float32Array.of(30 - 0.2425 * d, 0.9701 * d, 136, 30.06, 0, 136, 30.8, 0.2, 136);
  const sliverWeights = (p) => tiesFor({ positions: p, faceTri: Int32Array.of(0), limitPositions: sliver, limitIndices });
  test("a corner vertex float32 rounding put just outside a sliver triangle holds", () => {
    const p = offAC(7e-6);
    const t = sliverWeights(p);
    const ws = [t.w[0], t.w[1], 1 - t.w[0] - t.w[1]];
    expect(Math.min(...ws)).toBeLessThan(-TIE_WEIGHT_SLACK);
    expect(tiesHold(t, p, sliver, limitIndices)).toBe(true);
  });
  test("the same sliver, its vertex more than rounding outside: does not hold", () => {
    const p = offAC(1e-4);
    const t = sliverWeights(p);
    expect(tieError(t, p, sliver, limitIndices)).toBeLessThan(1e-3);   // it reproduces at rest
    expect(tiesHold(t, p, sliver, limitIndices)).toBe(false);
  });
});

// Nearest delivered vertex distance, on a hash grid of 1 mm cells.
function nearestIndex(P) {
  const cell = 1, grid = new Map(), key = (i, j, l) => `${i},${j},${l}`;
  for (let v = 0; v < P.length / 3; v++) {
    const kk = key(Math.floor(P[3 * v] / cell), Math.floor(P[3 * v + 1] / cell), Math.floor(P[3 * v + 2] / cell));
    let l = grid.get(kk); if (!l) grid.set(kk, (l = [])); l.push(v);
  }
  return (p) => {
    const c = p.map((x) => Math.floor(x / cell));
    let best = Infinity;
    for (let r = 1; r < 50 && best > (r - 1) * cell; r++) {
      for (let i = c[0] - r; i <= c[0] + r; i++) for (let j = c[1] - r; j <= c[1] + r; j++) for (let l = c[2] - r; l <= c[2] + r; l++) {
        for (const v of grid.get(key(i, j, l)) ?? []) best = Math.min(best, Math.hypot(P[3 * v] - p[0], P[3 * v + 1] - p[1], P[3 * v + 2] - p[2]));
      }
    }
    return best;
  };
}
