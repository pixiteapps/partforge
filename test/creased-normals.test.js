import { expect, test } from "vitest";
import { creasedNormals } from "../src/framework/geometry/creased-normals.js";
import { FACETED, BLEND } from "../src/framework/geometry/shading-policy.js";

// Two triangles sharing the edge v0-v1 (the x axis). Tri A lies in the XY
// plane (face normal +Z); tri B is the same quad half rotated `bend` degrees
// up about the x axis. scale shrinks the whole fixture (for MIN_EDGE tests).
function hinge(bendDeg, { oids = [7, 7], scale = 1 } = {}) {
  const t = (bendDeg * Math.PI) / 180;
  const s = scale;
  return {
    numProp: 3,
    vertProperties: Float32Array.from([
      0, 0, 0,                      // v0
      1 * s, 0, 0,                  // v1
      0, 1 * s, 0,                  // v2  (tri A apex)
      0.5 * s, -Math.cos(t) * s, Math.sin(t) * s, // v3 (tri B apex)
    ]),
    triVerts: Uint32Array.from([0, 1, 2, 1, 0, 3]),
    mergeFromVert: new Uint32Array(0),
    mergeToVert: new Uint32Array(0),
    runIndex: Uint32Array.from([0, 3, 6]),
    runOriginalID: Uint32Array.from(oids),
  };
}

const cornerNormal = (r, tri, corner) => [
  r.normals[(tri * 3 + corner) * 3],
  r.normals[(tri * 3 + corner) * 3 + 1],
  r.normals[(tri * 3 + corner) * 3 + 2],
];

test("same surface, 30° bend, default SMOOTH: shared-edge normals are averaged, no edge line", () => {
  const r = creasedNormals(hinge(30));
  const [nx, ny, nz] = cornerNormal(r, 0, 0); // tri A's copy of v0 (shared vertex)
  expect(nz).toBeLessThan(0.9999);            // not the pure +Z face normal — it blends with tri B
  expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 5);
  expect(r.edges.length).toBe(0);             // 30° < 35° — no line
});

test("same surface, 45° bend, default SMOOTH: hard normals and one edge segment", () => {
  const r = creasedNormals(hinge(45));
  expect(cornerNormal(r, 0, 0)[2]).toBeCloseTo(1, 5); // tri A shades with its own +Z face normal
  expect(r.edges.length).toBe(6);                     // one segment = 2 points × xyz
});

test("FACETED policy: a 30° same-surface bend shades hard and draws NO line", () => {
  const r = creasedNormals(hinge(30), { policies: new Map([[7, FACETED]]) });
  expect(cornerNormal(r, 0, 0)[2]).toBeCloseTo(1, 5); // hard: 30° > 10°
  expect(r.edges.length).toBe(0);                     // sameSurfaceLines: false
});

test("FACETED policy: bends under creaseAngle still smooth (ring-to-ring case)", () => {
  const r = creasedNormals(hinge(4), { policies: new Map([[7, FACETED]]) });
  expect(cornerNormal(r, 0, 0)[2]).toBeLessThan(0.9999); // 4° < 10° — averaged
});

test("different surfaces: always hard, line only past the 5° coplanar threshold", () => {
  const seam = creasedNormals(hinge(30, { oids: [7, 8] }));
  expect(cornerNormal(seam, 0, 0)[2]).toBeCloseTo(1, 5); // cut seams shade hard at any angle
  expect(seam.edges.length).toBe(6);
  const coplanar = creasedNormals(hinge(2, { oids: [7, 8] }));
  expect(cornerNormal(coplanar, 0, 0)[2]).toBeCloseTo(1, 5);
  expect(coplanar.edges.length).toBe(0);                 // 2° < 5° — coplanar seam, no line
});

test("a blend boundary (one side BLEND) draws even when tangent", () => {
  // the start/end of a fillet band: the blend surface meets the flank at ~0°
  // dihedral, under the coplanar threshold — but the seam must still draw so
  // the band's extent is visible.
  const r = creasedNormals(hinge(2, { oids: [7, 8] }), { policies: new Map([[8, BLEND]]) });
  expect(r.edges.length).toBe(6);
});

test("a tangent blend boundary shades SMOOTH while its line still draws", () => {
  // The band meets the flank tangentially by construction, so the boundary
  // must not shade hard — that painted a permanent lighting ridge along every
  // fillet's boundary ring. The line (above) and the shading are independent.
  const r = creasedNormals(hinge(6, { oids: [7, 8] }), { policies: new Map([[8, BLEND]]) });
  expect(r.edges.length).toBe(6);                      // 6° > 5° coplanar bar: line draws
  expect(cornerNormal(r, 0, 0)[2]).toBeLessThan(0.9999); // averaged across the seam, not tri A's own +Z
});

test("a steep blend↔base crossing still shades hard", () => {
  // a chamfer's 45° shoulder, or a band end-cap against a wall: past the
  // crease angle the boundary is a real crease and keeps hard normals.
  const r = creasedNormals(hinge(45, { oids: [7, 8] }), { policies: new Map([[8, BLEND]]) });
  expect(cornerNormal(r, 0, 0)[2]).toBeCloseTo(1, 5);
});

test("a blend-blend handover (both sides BLEND) keeps the bend rule — no tangent line", () => {
  // two blend tools continuing each other along one band: their handover seam
  // is the one this module spent a branch making invisible.
  const r = creasedNormals(hinge(2, { oids: [7, 8] }), { policies: new Map([[7, BLEND], [8, BLEND]]) });
  expect(r.edges.length).toBe(0);
  // a REAL crease between two blends (a reflex mitre crossing) still draws
  const mitre = creasedNormals(hinge(60, { oids: [7, 8] }), { policies: new Map([[7, BLEND], [8, BLEND]]) });
  expect(mitre.edges.length).toBe(6);
});

test("BLEND on a same-surface edge changes nothing", () => {
  const r = creasedNormals(hinge(2, { oids: [8, 8] }), { policies: new Map([[8, BLEND]]) });
  expect(r.edges.length).toBe(0);
});

test("opposite-wound coplanar cap triangles do not become a feature line", () => {
  // Manifold can use an opposite-wound bridge while triangulating a flat cap
  // with several holes. Its normals are +Z/-Z, but the supporting plane is the
  // same and the shared edge is only a triangulation seam, not a visible crease.
  const r = creasedNormals(hinge(180));
  expect(r.edges.length).toBe(0);
});

test("sub-MIN_EDGE segments are dropped as degenerate slivers", () => {
  const r = creasedNormals(hinge(90, { scale: 0.005 })); // shared edge is 0.005mm long
  expect(r.edges.length).toBe(0);
});

test("a sub-visible fan sliver draws no line despite a sharp bend", () => {
  // A boolean face-split near a tool crossing (mitre corner, pivot overshoot)
  // re-triangulates the split band quad against seam vertices that sit microns
  // off its plane — long fan slivers ~14-34µm wide whose normals tilt 40-56°
  // over sub-15µm of actual relief. The crease is real to the mesh but
  // invisible to any viewer, and it drew a full-weight line down an otherwise
  // perfect band (the label part's "line along the fillet" report). MIN_FACE
  // gates it: both incident faces must be wide enough to carry a visible
  // crease. The shared edge is LONG (1mm), so the segment-length filter is
  // not what saves this — the face gate is.
  const t = (40 * Math.PI) / 180, w = 0.02; // 20µm-wide sliver, 40° bend
  const g = {
    numProp: 3,
    vertProperties: Float32Array.from([
      0, 0, 0,                                  // v0
      1, 0, 0,                                  // v1
      0, 1, 0,                                  // v2 (fat triangle's apex)
      0.5, -w * Math.cos(t), w * Math.sin(t),   // v3 (sliver's apex, 20µm out)
    ]),
    triVerts: Uint32Array.from([0, 1, 2, 1, 0, 3]),
    mergeFromVert: new Uint32Array(0),
    mergeToVert: new Uint32Array(0),
    runIndex: Uint32Array.from([0, 3, 6]),
    runOriginalID: Uint32Array.from([7, 7]),
  };
  expect(creasedNormals(g).edges.length).toBe(0);
});

test("a zero-area triangle draws no line on its long edges", () => {
  // A boolean seam whose two sides land sub-micron apart collapses, at render
  // (float32) precision, into a triangle with two coincident vertices — zero
  // area, so its face "normal" is the divide-guard's garbage and reads as a
  // 90° crease against every neighbor. Its min-height must be computed from
  // the RAW cross magnitude (0), not the guarded one (1), so the thin gate
  // drops it — this drew a full-weight vertical line down an otherwise smooth
  // extruded wall at every collapsed tool seam of a filleted glyph outline.
  const g = {
    numProp: 3,
    vertProperties: Float32Array.from([
      0, 0, 0, // v0
      1, 0, 0, // v1
      0, 1, 0, // v2 (healthy apex)
      1, 0, 0, // v3 — float32-coincident with v1: tri B is zero-area
    ]),
    triVerts: Uint32Array.from([0, 1, 2, 1, 0, 3]),
    mergeFromVert: new Uint32Array(0),
    mergeToVert: new Uint32Array(0),
    runIndex: Uint32Array.from([0, 3, 6]),
    runOriginalID: Uint32Array.from([7, 7]),
  };
  const r = creasedNormals(g);
  expect(r.edges.length).toBe(0);
});

test("feature labels map through runOriginalID unchanged", () => {
  const r = creasedNormals(hinge(45, { oids: [7, 8] }), { featureLabels: new Map([[7, "wall"]]) });
  expect(r.features).toEqual(["wall"]);
  expect(Array.from(r.featureIds)).toEqual([1, 0]); // tri A → feature 1, tri B unlabeled
});

// The sliver rule: triangles under SHADE_SLIVER (1e-3 mm) tall stay out of a vertex's
// normal sum while a real face contributes, and are used only when nothing else does.
// A sliver at v0: v0, (−1, ε·cos t, ε·sin t), (−1, 0, 0) — ε tall, its facet normal
// tilted t about the x axis (inside the 35° crease, so it passes every other filter).
function sliverFan(tilts, { withFace = true, eps = 1e-5 } = {}) {
  const verts = [0, 0, 0], tris = [];
  if (withFace) { verts.push(1, 0, 0, 0, 1, 0); tris.push(0, 1, 2); } // a real +Z face
  for (const deg of tilts) {
    const t = (deg * Math.PI) / 180, b = verts.length / 3;
    verts.push(-1, eps * Math.cos(t), eps * Math.sin(t), -1, 0, 0);
    tris.push(0, b, b + 1);
  }
  return {
    numProp: 3,
    vertProperties: Float32Array.from(verts),
    triVerts: Uint32Array.from(tris),
    mergeFromVert: new Uint32Array(0),
    mergeToVert: new Uint32Array(0),
    runIndex: Uint32Array.from([0, tris.length]),
    runOriginalID: Uint32Array.from([7]),
  };
}
const tiltOf = (n) => (Math.atan2(-n[1], n[2]) * 180) / Math.PI;

test("a sub-SHADE_SLIVER sliver with a tilted normal does not tilt the real face's vertex", () => {
  // control: the same triangle at 0.01 mm tall is a real face and does vote
  const voted = creasedNormals(sliverFan([20], { eps: 1e-2 }));
  expect(tiltOf(cornerNormal(voted, 0, 0))).toBeGreaterThan(5);
  const r = creasedNormals(sliverFan([20]));
  const n = cornerNormal(r, 0, 0); // the real face's copy of v0
  expect(n[2]).toBeCloseTo(1, 6);
  expect(Math.hypot(n[0], n[1])).toBeLessThan(1e-6);
});

test("a vertex whose incident triangles are ALL slivers falls back to their sum", () => {
  const r = creasedNormals(sliverFan([10, 20], { withFace: false }));
  const n = cornerNormal(r, 0, 0);
  expect(n.every(Number.isFinite)).toBe(true);
  expect(Math.hypot(...n)).toBeCloseTo(1, 5);
  expect(tiltOf(n)).toBeCloseTo(15, 0); // the two slivers' bisector, not zero or NaN
});
