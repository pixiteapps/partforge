// A minimal reproduction of a public forge that failed lint since v0.82.0: its
// helper scans Shape2D.contains() across the inset contour's bounding box to find
// where ribs can land, and throws its own guard when none can. Against the
// geometry-free probe — contains() always false, boundingBox() a unit box — the
// scan finds nothing and the guard fires; on a real kernel it finds plenty.
const ribStations = (shape, box, pitch) => {
  const width = box.max[0] - box.min[0];
  const intervals = Math.max(2, Math.round(width / pitch));
  const step = Math.max(0.2, (box.max[1] - box.min[1]) / 60);
  const stations = [];
  for (let i = 1; i < intervals; i++) {
    const x = box.min[0] + (i * width) / intervals;
    let low = null;
    let high = null;
    for (let y = box.min[1]; y <= box.max[1]; y += step) {
      if (shape.contains([x, y])) {
        if (low === null) low = y;
        high = y;
      }
    }
    if (low !== null) stations.push([x, low, high]);
  }
  if (stations.length < 2) throw new Error("Truss pitch is too large for this contour");
  return stations;
};

export default {
  meta: { title: "Stub-query truss", units: "mm" },
  defaults: { width: 60, depth: 24, wall: 3, rib: 2, pitch: 8, height: 4 },
  parts: {
    truss: {
      views: ["main"],
      build: (k, p) => {
        const outline = k.shape2d([[-p.width / 2, -p.depth / 2], [p.width / 2, -p.depth / 2],
          [p.width / 2, p.depth / 2], [-p.width / 2, p.depth / 2]]);
        const inner = outline.offset(-p.wall);
        const box = inner.boundingBox();
        let ribs = null;
        for (const [x, low, high] of ribStations(inner, box, p.pitch)) {
          const bar = k.shape2d([[x - p.rib / 2, low], [x + p.rib / 2, low], [x + p.rib / 2, high], [x - p.rib / 2, high]]);
          ribs = ribs ? ribs.union(bar) : bar;
        }
        return outline.cut(inner).union(ribs).extrude({ h: p.height });
      },
    },
  },
  views: { main: { label: "Main" } },
};
