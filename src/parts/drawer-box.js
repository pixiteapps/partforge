// A three-drawer cabinet: the reference part for shape and motion handles on one part.
// In Pose mode, hover the cabinet and drag its top corner across the top plane: the
// width and depth follow, with a readout, and the cabinet rebuilds to the snapped size
// on release. Hover a drawer and drag its pull: that drawer slides out along its rail,
// live, and the others stay.
//
// How it fits together:
// - The handles are `point` handles: pure functions of the params and derive(), in part
//   coordinates. No mechanism helper is needed: a drawer's travel IS its parameter.
// - The cabinet is centred on the origin in X and Y, its open front facing -Y, so the
//   top corner at [width / 2, depth / 2, height] moves by half of each change.
// - Each drawer is built closed, in place, and slid out by its view (a translate), so
//   opening a drawer is matrix-only. Width, depth and height rebuild the cabinet and the
//   drawers: that is the shape drag.
// - A drawer's opening is a percentage of its travel, depth - 10, so it never leaves its
//   cabinet and every value of the slider moves it: an opening in mm, clamped to a travel
//   that depends on the depth, left the slider (and the handle) dead past the travel, which
//   lint's handle-inert samples the range for.
const WALL = 4;          // cabinet walls, top, bottom and dividers
const FRONT = 6;         // drawer front thickness
const SIDE = 2;          // drawer tray walls
const GAP = 1;           // running clearance around each drawer
const PULL = { r: 5, len: 10 };
const DRAWERS = [1, 2, 3];

const mm = (key, label, min, max, description) => ({ key, label, unit: "mm", min, max, step: 1, description });

/** Drawer i's bay (1 = top): its bottom and top z inside the cabinet. */
function bay(p, i) {
  const h = (p.height - 2 * WALL - 2 * WALL) / 3;
  const top = p.height - WALL - (i - 1) * (h + WALL);
  return [top - h, top];
}

/** The cabinet: a box open at the front (-Y) with two dividers between the bays. */
function carcass(k, p) {
  const w = p.width / 2, d = p.depth / 2;
  const shell = k.box({ min: [-w, -d, 0], max: [w, d, p.height] })
    .cut(k.box({ min: [-w + WALL, -d - 1, WALL], max: [w - WALL, d - WALL, p.height - WALL] }));
  const dividers = [1, 2].map((i) => {
    const z = bay(p, i)[0];
    return k.box({ min: [-w + WALL, -d, z - WALL], max: [w - WALL, d - WALL, z] });
  });
  return k.union([shell, ...dividers]);
}

/** Drawer i, closed: a front flush with the cabinet, a tray behind it, a round pull. */
function drawer(k, p, i) {
  const [z0, z1] = bay(p, i);
  const x = p.width / 2 - WALL - GAP, y0 = -p.depth / 2, y1 = p.depth / 2 - WALL - GAP;
  const front = k.box({ min: [-x, y0, z0 + GAP], max: [x, y0 + FRONT, z1 - GAP] });
  const tray = k.box({ min: [-x + GAP, y0 + FRONT, z0 + GAP], max: [x - GAP, y1, z1 - 2 * GAP] })
    .cut(k.box({ min: [-x + GAP + SIDE, y0 + FRONT, z0 + GAP + SIDE], max: [x - GAP - SIDE, y1 - SIDE, z1] }));
  const pull = k.cylinder({ r: PULL.r, h: PULL.len }).along("-Y").at([0, y0, (z0 + z1) / 2]);
  return k.union([front, tray, pull]);
}

export default {
  meta: { title: "Drawer box", units: "mm" },
  parameters: [
    { id: "cabinet", title: "Cabinet", description: "Outer size. In Pose mode, drag the cabinet's top corner to set width and depth together.", controls: [
      mm("width", "Width", 80, 400, "Outer width (X)."),
      mm("depth", "Depth", 60, 300, "Outer depth (Y). The drawers open toward -Y."),
      mm("height", "Height", 60, 300, "Outer height. The three drawers share it equally."),
    ] },
    { id: "drawers", title: "Drawers", description: "How far each drawer is pulled out, as a percentage of its travel (depth - 10). In Pose mode, drag a drawer's pull instead.", controls:
      DRAWERS.map((i) => ({ key: `drawer${i}Open`, label: `Drawer ${i}`, unit: "%", min: 0, max: 100, step: 0.1,
        description: ["The top drawer.", "The middle drawer.", "The bottom drawer."][i - 1] })) },
  ],
  defaults: { width: 160, depth: 120, height: 150, drawer1Open: 0, drawer2Open: 40, drawer3Open: 0 },
  derive: (p) => {
    // each drawer's opening in mm: its percentage of the travel, depth - 10
    const open = DRAWERS.map((i) => (Math.min(Math.max(p[`drawer${i}Open`], 0), 100) / 100) * (p.depth - 10));
    // Each pull's tip, where its handle sits, with the drawer slid out.
    const pulls = DRAWERS.map((i, n) => {
      const [z0, z1] = bay(p, i);
      return [0, -p.depth / 2 - PULL.len - open[n], (z0 + z1) / 2];
    });
    return { open, pulls };
  },
  parts: {
    carcass: { label: "Cabinet", build: (k, p) => carcass(k, p), views: { cabinet: (s) => s } },
    ...Object.fromEntries(DRAWERS.map((i) => [`drawer${i}`, {
      label: `Drawer ${i}`,
      build: (k, p) => drawer(k, p, i),
      views: { cabinet: (s, p, d) => s.translate([0, -d.open[i - 1], 0]) },
    }])),
  },
  views: { cabinet: { label: "Cabinet" } },
  handles: {
    corner: {
      point: (p) => [p.width / 2, p.depth / 2, p.height], params: ["width", "depth"],
      drag: "plane", normal: [0, 0, 1], label: "Size", showOn: "carcass",
    },
    ...Object.fromEntries(DRAWERS.map((i) => [`drawer${i}`, {
      point: (p, d) => d.pulls[i - 1], params: [`drawer${i}Open`],
      drag: "axis", direction: [0, -1, 0], label: `Drawer ${i}`, showOn: `drawer${i}`,
    }])),
  },
  // Closed or open, every drawer runs on its clearance: nothing interpenetrates.
  verify: { expect: { _view: { overlaps: 0 } } },
};
