// The Lattice Box (partforge-cloud feedback #161), reduced. The insert's build
// queries the region it patterns — boundingBox() to size the grid, intersect()
// + isEmpty()/area()/toRegions() to keep or drop the clipped border cells — which
// is exactly what the old full-scope probe refused to trust. Its pose lives in
// place() and reads openAngle/lift only. Used by the probe, jobs, print-frame
// and lint suites: the notes must be 0 and the print frame non-identity.
function latticeHoles(k, region, cellR, web) {
  const bb = region.boundingBox();
  const pitch = cellR * 2 + web;
  const cells = [];
  for (let y = bb.min[1]; y <= bb.max[1]; y += pitch) {
    for (let x = bb.min[0]; x <= bb.max[0]; x += pitch) {
      const pts = Array.from({ length: 12 }, (_, i) => {
        const a = (i * 2 * Math.PI) / 12;
        return [x + cellR * Math.cos(a), y + cellR * Math.sin(a)];
      });
      if (pts.every((pt) => region.contains(pt))) { cells.push({ outer: pts }); continue; }
      const clipped = k.shape2d(pts).intersect(region);
      if (!clipped.isEmpty() && clipped.area() >= 0.5) cells.push(...clipped.toRegions());
    }
  }
  return cells.length ? k.shape2d(cells) : null;
}

function windowShape(k, p) {
  return k.shape2d([[p.frame, p.frame], [p.w - p.frame, p.frame], [p.w - p.frame, p.d - p.frame], [p.frame, p.d - p.frame]]);
}

function makeLid(k, p) {
  const outer = k.box({ min: [0, 0, 0], max: [p.w, p.d, p.lidH] });
  const inner = k.box({ min: [p.wall, p.wall, p.wall], max: [p.w - p.wall, p.d - p.wall, p.lidH + 1] });
  return outer.cut(inner).cut(windowShape(k, p).extrude({ h: p.wall + 2 }).translate([0, 0, -1]));
}

function makeInsert(k, p) {
  const plate = windowShape(k, p).offset(-p.fit, { corners: "round" });
  const region = plate.offset(-p.web, { corners: "round" });
  const holes = region.isEmpty() ? null : latticeHoles(k, region, p.cellR, p.web);
  return (holes ? plate.cut(holes) : plate).extrude({ h: p.wall });
}

// Rigid articulation about the back edge, then the assembly lift. Reads only pose params.
const articulate = (s, { p }) => s.rotateAbout({ axis: "X", deg: p.openAngle, through: [0, 0, p.h] }).translate([0, 0, p.lift]);

export default {
  meta: { title: "Lattice Lid", units: "mm" },
  parameters: [
    { id: "box", title: "Box", controls: [
      { key: "w", type: "slider", label: "Width", unit: "mm", min: 30, max: 120, step: 1, description: "Outer width." },
      { key: "d", type: "slider", label: "Depth", unit: "mm", min: 30, max: 120, step: 1, description: "Outer depth." },
      { key: "h", type: "slider", label: "Body height", unit: "mm", min: 10, max: 60, step: 1, description: "Body height." },
      { key: "lidH", type: "slider", label: "Lid height", unit: "mm", min: 5, max: 40, step: 1, description: "Lid height." },
      { key: "wall", type: "slider", label: "Wall", unit: "mm", min: 1.2, max: 4, step: 0.2, description: "Wall thickness." },
    ] },
    { id: "lattice", title: "Lattice", controls: [
      { key: "frame", type: "slider", label: "Frame", unit: "mm", min: 3, max: 20, step: 0.5, description: "Lid border around the window." },
      { key: "cellR", type: "slider", label: "Cell radius", unit: "mm", min: 1, max: 8, step: 0.25, description: "Hole radius." },
      { key: "web", type: "slider", label: "Web", unit: "mm", min: 0.6, max: 4, step: 0.1, description: "Material between holes." },
      { key: "fit", type: "slider", label: "Fit", unit: "mm", min: 0, max: 0.5, step: 0.05, description: "Insert clearance." },
    ] },
    { id: "pose", title: "Pose", controls: [
      { key: "openAngle", type: "slider", label: "Open angle", unit: "°", min: 0, max: 180, step: 1, description: "Lid angle about the back edge." },
      { key: "lift", type: "number", label: "Lift", unit: "mm", min: 0, max: 60, step: 1, hidden: true, description: "Assembly lift, animation-driven." },
    ] },
  ],
  defaults: { w: 60, d: 40, h: 20, lidH: 10, wall: 2, frame: 5, cellR: 2.5, web: 1, fit: 0.15, openAngle: 0, lift: 0 },
  parts: {
    body: { label: "Body", views: ["assembly"], build: (k, p) =>
      k.box({ min: [0, 0, 0], max: [p.w, p.d, p.h] }).cut(k.box({ min: [p.wall, p.wall, p.wall], max: [p.w - p.wall, p.d - p.wall, p.h + 1] })) },
    lid: { label: "Lid", views: ["assembly"], display: { color: 0xf5f5f5 },
      build: (k, p) => makeLid(k, p).rotateAbout({ axis: "Y", deg: 180, through: [p.w / 2, 0, 0] }).translate([0, 0, p.h + p.lidH]),
      place: articulate },
    insert: { label: "Lattice insert", views: ["assembly"], display: { color: 0x222222 },
      build: (k, p) => makeInsert(k, p).rotateAbout({ axis: "Y", deg: 180, through: [p.w / 2, 0, 0] }).translate([0, 0, p.h + p.lidH]),
      place: articulate },
  },
  views: {
    assembly: { label: "Assembly", animations: {
      cycleLid: { label: "Open / close lid", camera: "iso", duration: 2, loop: true,
        tracks: { openAngle: [[0, 0], [0.5, 120], [1, 0]], lift: [[0, 0], [0.5, 10], [1, 0]] } },
    } },
  },
};
