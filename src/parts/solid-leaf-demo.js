// Dev-only demo of the k.implicit `solid` leaf and the signed `offset` node: five things
// an implicit tree can now do to a solid it did not build. Not a reference part; no
// verify block. Each case builds ordinary solids (or a cage body) first, then puts them
// in a tree as `solid` leaves.
const leaf = (solid, extra = {}) => ({ kind: "solid", solid, ...extra });

// cos(16θ ± 1.3 z): a diamond knurl around z. z = normalize(p.xy) squared four times.
const KNURL = "vec2 z = normalize(p.xy); for (int i = 0; i < 4; i++) { z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y); } float c = cos(p.z * 1.3); float s = sin(p.z * 1.3); return max(z.x * c - z.y * s, z.x * c + z.y * s);";
const GYROID = "float s = 6.2831853 / cell; vec3 q = p * s; float g = sin(q.x) * cos(q.y) + sin(q.y) * cos(q.z) + sin(q.z) * cos(q.x); return (abs(g) - w) / s / 1.5;";

const plate = (k) => k.box({ min: [-30, -20, 0], max: [30, 20, 6] });
const boss = (k) => k.cylinder({ r: 8, h: 26 }).at([0, 0, 4]);
const blob = (k) => k.sphere(16)
  .union(k.box({ min: [-8, -8, -22], max: [8, 8, 0] }))
  .union(k.cylinder({ r: 6, h: 44 }).rotateY(90).at([-22, 0, 4]));
const creature = (k) => {
  const c = k.cage({ box: { size: [44, 24, 22], segs: [2, 1, 1] } });
  c.extrude("+x:0,0", { by: 14, scale: 0.55 });
  return k.subdiv(c).at([0, 0, 26]);
};
const quarter = (k) => k.box({ min: [0, -60, -30], max: [60, 0, 60] });

const CASES = [
  // 0: a rounded join between two ordinary solids. k = 0 shows the plain union.
  (k, p) => (p.blend > 0
    ? k.implicit({ resolution: 0.4, root: { kind: "union", k: p.blend, children: [leaf(plate(k)), leaf(boss(k))] } })
    : plate(k).union(boss(k))),
  // 1: a cage body grown out of an ordinary post and base.
  (k, p) => {
    const parts = [creature(k), k.cylinder({ r: 5, h: 24 }).at([-6, 0, 0]), k.cylinder({ r: 20, h: 4 })];
    return p.blend > 0
      ? k.implicit({ resolution: 0.4, root: { kind: "union", k: p.blend, children: parts.map((s) => leaf(s)) } })
      : parts[0].union(parts[1]).union(parts[2]);
  },
  // 2: a skin of constant thickness, by an inward or an outward offset.
  (k, p) => {
    const body = blob(k);
    if (p.offset === 0) return body;
    const moved = k.implicit({ resolution: 0.4, root: { kind: "offset", d: p.offset, child: leaf(body) } });
    const skin = p.offset < 0 ? body.cut(moved) : moved.cut(body);
    return skin.cut(quarter(k));
  },
  // 3: a knurl on a plain cylinder.
  (k, p) => {
    const grip = k.cylinder({ r: 12, h: 34 });
    if (p.knurl === 0) return grip;
    return k.implicit({ resolution: 0.3, preview: 0.45, root: { kind: "displace", amount: p.knurl, child: leaf(grip), by: { expr: KNURL } } });
  },
  // 4: a gyroid fill inside a skin, clipped to the body's own shape.
  (k, p) => {
    const body = k.sphere(18).union(k.cylinder({ r: 9, h: 16 }).at([0, 0, -26]));
    const fill = k.implicit({ resolution: 0.4, preview: 0.7, root: { kind: "union", children: [
      { kind: "subtract", children: [leaf(body), { kind: "offset", d: -1.6, child: leaf(body) }] },
      { kind: "intersect", children: [leaf(body), { kind: "expr", sdf: GYROID, uniforms: { cell: p.cell, w: 0.35 }, box: [[-20, -20, -28], [20, 20, 20]] }] },
    ] } });
    return fill.cut(quarter(k));
  },
];

export default {
  meta: { title: "Solids in an implicit tree", units: "mm", backend: "manifold" },
  parameters: [
    {
      id: "demo",
      title: "Demo",
      controls: [
        { key: "demo", type: "radio", label: "Show",
          options: [
            { value: 0, label: "Rounded join" }, { value: 1, label: "Cage on a post" },
            { value: 2, label: "Offset skin" }, { value: 3, label: "Knurl" }, { value: 4, label: "Lattice fill" },
          ],
          description: "Each demo builds ordinary solids first and then uses them as `solid` leaves of a `k.implicit` tree." },
      ],
    },
    {
      id: "settings",
      title: "Settings",
      controls: [
        { key: "blend", type: "slider", label: "Blend width", unit: "mm", min: 0, max: 12, step: 1,
          description: "**Rounded join** and **Cage on a post**. The `k` of the `union`. 0 shows the plain union, with its sharp seam." },
        { key: "offset", type: "slider", label: "Offset", unit: "mm", min: -4, max: 4, step: 0.5,
          description: "**Offset skin**. The `d` of the `offset` node. Negative makes a skin inside the body, positive a shell outside it. 0 shows the body." },
        { key: "knurl", type: "slider", label: "Knurl depth", unit: "mm", min: 0, max: 1.2, step: 0.1,
          description: "**Knurl**. The `amount` of the `displace` node. 0 shows the plain cylinder." },
        { key: "cell", type: "slider", label: "Lattice cell", unit: "mm", min: 6, max: 16, step: 1,
          description: "**Lattice fill**. The size of one gyroid cell." },
      ],
    },
  ],
  defaults: { demo: 0, blend: 8, offset: -2, knurl: 0.7, cell: 10 },
  parts: {
    body: {
      label: "Body",
      views: ["main"],
      export: { name: "solid-leaf-demo" },
      build: (k, p) => CASES[p.demo](k, p),
    },
  },
  views: { main: { label: "Solid leaves" } },
};
