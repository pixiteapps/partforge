// A whale from one subdivision cage: the organic domain's k.subdiv reference part, and the
// worked example of the cage section in docs/domains/organic.md (the guide shows
// whaleCage verbatim; test/organic-docs.test.js holds the two equal).
//
// Authoring frame: nose toward -X, tail toward +X, back toward +Z. One box, mirrored
// through Y = 0, so every change on the +Y half is made on the -Y half too. The body is
// box-modelled by extrudes: the head forward, the tail stock back in three steps, the
// flukes out of the last tail step's +Y sides, a dorsal fin out of the back, a pectoral
// fin out of each lower side. k.subdiv smooths the cage into one solid, and an ordinary
// boolean then cuts a flat under the belly to print on.

// Nose to fluke tips (mm) of the smooth surface when every cage size is used as written:
// measured, since the surface lies inside its cage.
const CAGE_LENGTH = 124;

/** The whale's cage at params { length, tailLift }. */
export function whaleCage(k, p) {
  const s = p.length / CAGE_LENGTH;
  const v = (x, y, z) => [x * s, y * s, z * s];
  const c = k.cage({ box: { size: v(60, 30, 26), center: [0, 0, 0], segs: [4, 2, 2] }, mirror: "xz" });
  const positive = (prefix) => c.faces(prefix).filter((id) => !id.endsWith("~"));
  // Round the cross-section: pull each side's outer rows in toward its middle row.
  c.scale(positive("+y:"), [1, 1, 0.75]);
  c.scale(positive("+z:"), [1, 0.75, 1]);
  c.scale(positive("-z:"), [1, 0.75, 1]);
  // Head: two short extrudes forward, each narrower.
  const head = c.extrude(["-x:1,0", "-x:1,1"], { by: 8 * s, scale: [1, 0.8, 0.85], id: "head" });
  c.extrude(head, { by: 5 * s, scale: [1, 0.7, 0.7], id: "nose" });
  // Tail stock: three extrudes back, each narrower. tailLift raises only the last two, so
  // the body ahead of the tail keeps its shape.
  const t1 = c.extrude(["+x:1,0", "+x:1,1"], { by: v(18, 0, 1), scale: [1, 0.6, 0.6], id: "tail1" });
  const t2 = c.extrude(t1, { by: [16 * s, 0, p.tailLift / 2], scale: [1, 0.6, 0.6], id: "tail2" });
  c.extrude(t2, { by: [8 * s, 0, p.tailLift / 2], scale: [1, 0.8, 0.8], id: "tail3" });
  // Flukes: the last tail step's two +Y sides, pushed out and back and flattened.
  const fluke = c.extrude(["tail3.s1", "tail3.s2"], { by: v(4, 12, 0), scale: [1.2, 1, 0.3], id: "fluke" });
  c.extrude(fluke, { by: v(8, 12, 0), scale: [0.6, 1, 0.7], id: "flukeTip" });
  // Dorsal fin: the back face over the tail root, which has an edge on the mirror plane,
  // so it grows across it as one fin; swept back and thinned.
  const fin = c.extrude("+z:3,1", { by: v(2, 0, 5), scale: [0.6, 0.7, 1], id: "fin" });
  c.extrude(fin, { by: v(5, 0, 4), scale: [0.5, 0.35, 0.6], id: "finTip" });
  // Pectoral fins: a low side face near the front, swept out, back and a little down.
  const pec = c.extrude("+y:1,0", { by: v(3, 6, -2), scale: [0.7, 1, 0.35], id: "pec" });
  c.extrude(pec, { by: v(8, 12, -2), scale: [0.6, 1, 0.6], id: "pecTip" });
  return c;
}

export default {
  meta: { title: "Organic whale", units: "mm", backend: "manifold" },
  parameters: [
    { id: "shape", title: "Whale", controls: [
      { key: "length", label: "Length", unit: "mm", min: 80, max: 200, step: 1, description: "Nose to fluke tips. Everything but the tail lift scales with it." },
      { key: "tailLift", label: "Tail lift", unit: "mm", min: -8, max: 14, step: 0.5, description: "How far the end of the tail cage rises; the flukes ride on it." },
    ] },
  ],
  defaults: { length: 120, tailLift: 6 },
  parts: {
    whale: {
      label: "Whale",
      views: ["whale"],
      // The smooth body, then an ordinary boolean: a flat under the belly to print on.
      build: (k, p) => {
        const body = k.subdiv(whaleCage(k, p));
        const { min, max } = body.boundingBox();
        const flat = 1.5 * (p.length / CAGE_LENGTH);
        return body.cut(k.box({ min: [min[0] - 1, min[1] - 1, min[2] - 1], max: [max[0] + 1, max[1] + 1, min[2] + flat] }));
      },
    },
  },
  views: { whale: { label: "Whale" } },
  verify: {
    expect: {
      whale: { watertight: true, holes: 0, bbox: "[117.6..122.4, *, *]" },
    },
  },
};
