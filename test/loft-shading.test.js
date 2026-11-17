import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const RINGS = [{ sides: 12, radius: 20, z: 0 }, { sides: 12, radius: 20, z: 10 }];

// Classify wall triangles (face normal horizontal; caps are ±Z and skipped) as
// flat (all 3 corner normals ≈ the face normal) or smoothed. Non-indexed mesh:
// tri t occupies positions/normals [t*9, t*9+9).
function wallTris(m) {
  let flat = 0, total = 0;
  const P = m.positions, N = m.normals;
  for (let t = 0; t * 9 < P.length; t++) {
    const o = t * 9;
    const ux = P[o + 3] - P[o], uy = P[o + 4] - P[o + 1], uz = P[o + 5] - P[o + 2];
    const vx = P[o + 6] - P[o], vy = P[o + 7] - P[o + 1], vz = P[o + 8] - P[o + 2];
    let fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const L = Math.hypot(fx, fy, fz) || 1;
    fx /= L; fy /= L; fz /= L;
    if (Math.abs(fz) > 1e-3) continue; // cap or cap-fan triangle — not a wall
    total++;
    let allFlat = true;
    for (let c = 0; c < 3; c++) {
      const n = o + c * 3;
      if (N[n] * fx + N[n + 1] * fy + N[n + 2] * fz < 0.9999) allFlat = false;
    }
    if (allFlat) flat++;
  }
  return { flat, total };
}

test("12-sided loft defaults to faceted: every wall triangle flat, zero edge lines", () => {
  const m = k.loft({ rings: RINGS }).toMesh();
  const w = wallTris(m);
  expect(w.total).toBeGreaterThan(0);
  expect(w.flat).toBe(w.total);
  expect(m.edges.length).toBe(0); // no same-surface lines — not even the 90° cap rims
});

test("shading:\"smooth\" overrides inference: corners averaged, cap-rim lines return", () => {
  const m = k.loft({ rings: RINGS, shading: "smooth" }).toMesh();
  const w = wallTris(m);
  expect(w.total).toBeGreaterThan(0);
  expect(w.flat).toBe(0); // every wall vertex is a facet corner — all averaged at 30° < 35°
  expect(m.edges.length).toBeGreaterThan(0); // 90° cap rims draw under SMOOTH
});

test("high-side-count lofts infer smooth (cap-rim lines present without any hint)", () => {
  const many = [{ sides: 64, radius: 20, z: 0 }, { sides: 64, radius: 20, z: 10 }];
  expect(k.loft({ rings: many }).toMesh().edges.length).toBeGreaterThan(0);
});

test("label() preserves the loft's shading policy (the vase labels its walls)", () => {
  const m = k.loft({ rings: RINGS }).label("Faceted wall").toMesh();
  const w = wallTris(m);
  expect(w.total).toBeGreaterThan(0);
  expect(w.flat).toBe(w.total);
  expect(m.edges.length).toBe(0);
  expect(m.features).toEqual(["Faceted wall"]);
});

test("booleans keep per-surface policy: faceted loft cut by a box stays flat, seam draws", () => {
  const tool = k.box({ min: [0, -30, 5], max: [30, 30, 15] });
  const m = k.loft({ rings: RINGS }).cut(tool).toMesh();
  // Surviving loft walls stay flat; the tool's cut faces are planes (flat too);
  // seams between the two OIDs shade hard — so every wall-class triangle is flat.
  const w = wallTris(m);
  expect(w.total).toBeGreaterThan(0);
  expect(w.flat).toBe(w.total);
  expect(m.edges.length).toBeGreaterThan(0); // the cut seam draws lines
});

test("shading is rejected on other ops (option list is per-op)", () => {
  expect(() => k.sphere({ r: 5, shading: "smooth" })).toThrow(/unknown option/);
});

test("the old smooth option name is gone: loft rejects it as unknown", () => {
  // The did-you-mean suggester doesn't fire here ("smooth" isn't a prefix of
  // "shading" and their edit distance exceeds the cap), so this only pins the
  // baseline unknown-option error, not a "did you mean shading?" hint.
  expect(() => k.loft({ rings: RINGS, smooth: true })).toThrow(/unknown option "smooth"/);
});

test("an invalid shading enum value throws the loud enum error", () => {
  expect(() => k.loft({ rings: RINGS, shading: "flat" })).toThrow('loft: shading must be "smooth" | "faceted"');
});

// The faceted-vase hollows itself with loft().intersect(box).label(...) — label()
// runs on the INTERSECT's result, which spans the loft's surface plus the box's.
// label() re-stamps every original id 1:1, so each surface keeps its own policy:
// the loft's walls stay FACETED (flat, no same-surface lines) and the box's face
// carries none (SMOOTH by default). The only lines are the loft/box seam, exactly
// what the unlabeled intersect draws.
test("label() after an intermediate boolean keeps each surface's own policy (vase hollowing)", () => {
  const tool = k.box({ min: [-30, -30, 2], max: [30, 30, 15] }); // no policy of its own
  const plain = k.loft({ rings: RINGS }).intersect(tool).toMesh();
  const m = k.loft({ rings: RINGS }).intersect(tool).label("Faceted wall").toMesh();
  const w = wallTris(m);
  expect(w.total).toBeGreaterThan(0);
  expect(w.flat).toBe(w.total); // the loft's walls keep FACETED
  expect(m.edges.length).toBeGreaterThan(0); // the loft/box seam at z=2 draws...
  for (let i = 2; i < m.edges.length; i += 3) expect(m.edges[i]).toBeCloseTo(2, 6); // ...and nothing else
  expect(Array.from(m.edges)).toEqual(Array.from(plain.edges)); // label() changed no line
  expect(Array.from(m.normals)).toEqual(Array.from(plain.normals)); // nor any normal
  expect(m.features).toEqual(["Faceted wall"]);
});

// union() of two lofts with DIFFERENT inferred policies: label() keeps each one's
// own, so the FACETED loft draws no same-surface lines while the SMOOTH loft keeps
// its 90° cap-rim lines — the same picture as the unlabeled union.
test("label() on a union of differently-shaded lofts keeps each loft's own policy", () => {
  const manyRingsFaceted = [];
  for (let i = 0; i < 16; i++) manyRingsFaceted.push({ sides: 12, radius: 20, z: i * 2 });
  const make = () => k.loft({ rings: manyRingsFaceted }) // FACETED (< 32 sides)
    .union(k.loft({ rings: [{ sides: 64, radius: 20, z: 0 }, { sides: 64, radius: 20, z: 10 }] }) // SMOOTH (>= 32 sides)
      .translate([100, 0, 0])); // disjoint, so union() reshapes neither
  const plain = make().toMesh();
  const m = make().label("Body").toMesh();
  let faceted = 0, smooth = 0;
  for (let i = 0; i < m.edges.length; i += 6) (m.edges[i] < 50 ? faceted++ : smooth++);
  expect(faceted).toBe(0); // the faceted loft keeps FACETED: no lines
  expect(smooth).toBeGreaterThan(0); // the smooth loft keeps SMOOTH: cap rims draw
  expect(Array.from(m.edges)).toEqual(Array.from(plain.edges));
  expect(m.features).toEqual(["Body"]);
});

// wallTris' cap test (face normal ~vertical) assumes an UNTAPERED loft, where the
// walls really are exactly vertical (fz≈0). This ring's top is scaled 0.6, so the
// walls are genuinely slanted and fz is nowhere near 0 there — the face-normal test
// would misclassify every wall triangle as a cap. Classify by z instead: a cap's
// three corners all sit on the SAME ring (identical z); a wall triangle always
// spans two adjacent rings (mixed z), regardless of taper.
function wallTrisByZ(m) {
  let flat = 0, total = 0;
  const P = m.positions, N = m.normals;
  for (let t = 0; t * 9 < P.length; t++) {
    const o = t * 9;
    const z0 = P[o + 2], z1 = P[o + 5], z2 = P[o + 8];
    if (z0 === z1 && z1 === z2) continue; // cap: all three corners on one ring
    const ux = P[o + 3] - P[o], uy = P[o + 4] - P[o + 1], uz = P[o + 5] - P[o + 2];
    const vx = P[o + 6] - P[o], vy = P[o + 7] - P[o + 1], vz = P[o + 8] - P[o + 2];
    let fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const L = Math.hypot(fx, fy, fz) || 1;
    fx /= L; fy /= L; fz /= L;
    total++;
    let allFlat = true;
    for (let c = 0; c < 3; c++) {
      const n = o + c * 3;
      if (N[n] * fx + N[n + 1] * fy + N[n + 2] * fz < 0.9999) allFlat = false;
    }
    if (allFlat) flat++;
  }
  return { flat, total };
}

test("a Shape2D rounded-square loft previews with smoothed arc walls", () => {
  const rsq = k.shape2d([[-10, -10], [10, -10], [10, 10], [-10, 10]]).fillet(4);
  const m = k.loft({ rings: [{ polygon: rsq, z: 0 }, { polygon: rsq, z: 12, scale: 0.6 }] }).toMesh();
  const { flat, total } = wallTrisByZ(m);
  expect(total).toBeGreaterThan(0);
  expect(flat).toBeLessThan(total); // some walls smoothed — FACETED would flat-shade all
});

test("Shape2D rings cache-key by content: same shape twice hits, different fillet misses", () => {
  const mk = (r) => k.loft({ rings: [
    { polygon: k.shape2d([[-10, -10], [10, -10], [10, 10], [-10, 10]]).fillet(r), z: 0 },
    { polygon: k.shape2d([[-10, -10], [10, -10], [10, 10], [-10, 10]]).fillet(r), z: 12 },
  ] });
  expect(mk(4)._hash).toBe(mk(4)._hash);
  expect(mk(4)._hash).not.toBe(mk(3)._hash);
});

// ── Provenance-sectored lofts through the kernel ────────────────────────────
// The belly-kink body (lofted-bottle's shape): ~10° silhouette kink at z=31.5,
// far under SMOOTH's 35° crease — only the sector/band-group runs can draw its
// dividing ring line. The kernel must register the run policies (so the crease
// pass sees them) and label() must preserve the runs rather than folding them
// into one surface.
test("a belly-kink Shape2D loft draws its dividing ring line through the kernel", () => {
  const rsq = k.shape2d([[-10, -10], [10, -10], [10, 10], [-10, 10]]).fillet(3);
  const solid = k.loft({ rings: [
    { polygon: rsq, z: 0 }, { polygon: rsq, z: 31.5, scale: 1.15 }, { polygon: rsq, z: 70 },
  ] });
  const m = solid.toMesh();
  let atKink = 0;
  for (let i = 0; i < m.edges.length; i += 6)
    if (Math.abs(m.edges[i + 2] - 31.5) < 1e-3 && Math.abs(m.edges[i + 5] - 31.5) < 1e-3) atKink++;
  expect(atKink).toBeGreaterThan(0);
});

test("label() preserves a sectored loft's dividing line (no fold into one surface)", () => {
  const rsq = k.shape2d([[-10, -10], [10, -10], [10, 10], [-10, 10]]).fillet(3);
  const solid = k.loft({ rings: [
    { polygon: rsq, z: 0 }, { polygon: rsq, z: 31.5, scale: 1.15 }, { polygon: rsq, z: 70 },
  ] }).label("Body");
  const m = solid.toMesh();
  let atKink = 0;
  for (let i = 0; i < m.edges.length; i += 6)
    if (Math.abs(m.edges[i + 2] - 31.5) < 1e-3 && Math.abs(m.edges[i + 5] - 31.5) < 1e-3) atKink++;
  expect(atKink).toBeGreaterThan(0);
  expect(m.features).toEqual(["Body"]);              // all runs collapse to ONE feature entry
});
