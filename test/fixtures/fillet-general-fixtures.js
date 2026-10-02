// Edges people want rounded that lie between two CURVED faces — the mesh fillet's
// general-chain acceptance set (spec 2026-10-02). Backend-neutral: each builder takes
// a kernel, so the OCCT reference script and the Manifold tests build the same parts.
export const FIXTURES = {
  // boss on a tube: concave saddle junction
  tee: (k) => k.cylinder({ r: 10, h: 60, center: true }).rotateAbout({ axis: "Y", deg: 90 })
    .union(k.cylinder({ r: 5, h: 20 })),
  // through hole across a solid tube: two convex saddle rims
  crossHole: (k) => k.cylinder({ r: 10, h: 60, center: true }).rotateAbout({ axis: "Y", deg: 90 })
    .cut(k.cylinder({ r: 3, h: 40, center: true })),
  // off-axis boss on a dome: concave junction, not coaxial with the sphere
  domeBoss: (k) => k.sphere({ r: 20 }).intersect(k.box({ size: [60, 60, 30] }))
    .union(k.cylinder({ r: 3, h: 30 }).at([8, 0, 0])),
  // tube cut by a 30° plane wholly inside its height: one elliptical rim
  slantCut: (k) => k.cylinder({ r: 10, h: 40 })
    .cut(k.box({ size: [80, 80, 40] }).rotateAbout({ axis: "X", deg: 30 }).at([0, 0, 25])),
};
export const GENUS = { tee: 0, crossHole: 1, domeBoss: 0, slantCut: 0 };
export const CASES = [["fillet", 1], ["fillet", 2], ["chamfer", 1], ["chamfer", 2]];
// small-radius fillets, referenced but outside the full matrix: on a coarse mesh they
// put the most facets under one section (the contact-margin cap's worst case)
export const SMALL_CASES = [["fillet", 0.5]];
// thin rod on a plate, top cut on a slant: its convex elliptical rim bends tighter
// (radius ~1.5) than a 2 mm fillet section reaches — must reroute, not fold
export const tightBend = (k) => k.box({ size: [20, 20, 2] })
  .union(k.cylinder({ r: 1.5, h: 10 }))
  .cut(k.box({ size: [40, 40, 20] }).rotateAbout({ axis: "X", deg: 30 }).at([0, 0, 7]));
// D-profile rod cut on a slant: the top rim mixes a curved (general) run with a
// straight run meeting it at two corners
export const dRodSlant = (k) => k.cylinder({ r: 6, h: 30 })
  .cut(k.box({ min: [4, -10, -1], max: [10, 10, 40] }))
  .cut(k.box({ size: [80, 80, 40] }).rotateAbout({ axis: "X", deg: 30 }).at([0, 0, 20]));
// The same fixtures at a COARSE tessellation (spec Risk 1: a facet tilts the mesh
// normal at the edge by up to half its angle, and the section can graze). Every
// cylinder becomes an n-gon prism and the sphere an n-gon loft over n latitude rings
// — 11.25° facets at n = 32 against preview's 3.1° — built from explicit point lists,
// so no quality tier can refine them. The latitude rings stop 0.05 rad short of the
// poles; the dome's box clips those caps away anyway. Pass this in place of `k`.
const ngon = (r, n) => Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)]);
export const coarseKernel = (k, n) => Object.assign(Object.create(k), {
  cylinder: ({ r, h, center = false }) => {
    const s = k.prism({ points: ngon(r, n), h });
    return center ? s.at([0, 0, -h / 2]) : s;
  },
  sphere: ({ r }) => k.loft({
    rings: Array.from({ length: n + 1 }, (_, j) => {
      const phi = -Math.PI / 2 + 0.05 + (j / n) * (Math.PI - 0.1);
      return { polygon: ngon(r * Math.cos(phi), n), z: r * Math.sin(phi) };
    }),
  }),
});
