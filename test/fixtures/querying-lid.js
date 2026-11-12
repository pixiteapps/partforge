// A 40 mm bar on a vertical pin, swung 0 → 180° by `open`, whose build QUERIES its own solid
// (so the geometry-free probe cannot trust its hash), and a 1 mm post at radius 35, 11.25°
// round: the bar meets the post only inside roughly 9.3°–13.2°, between two of the 24
// fixed steps a rebuild sweep takes (7.5° and 15°). A build that never reads `open` cannot
// rebuild as it moves, so the sweep moves it by matrix and finds the contact; with
// `readsOpen` the build reads `open` and the sweep rebuilds it at the fixed steps.
const POST = { r: 35, deg: 11.25, half: 0.5 };

export function queryingLid({ readsOpen = false } = {}) {
  const a = (POST.deg * Math.PI) / 180;
  const c = [POST.r * Math.cos(a), POST.r * Math.sin(a)];
  return {
    meta: { title: "Querying lid", units: "mm" },
    parameters: [{ id: "g", title: "Motion", description: "The swing.", controls: [
      { key: "open", label: "Open", unit: "°", min: 0, max: 180, step: 1, description: "Swings the bar round the pin." },
    ] }],
    defaults: { open: 0 },
    parts: {
      post: {
        label: "Post",
        build: (k) => k.box({ min: [c[0] - POST.half, c[1] - POST.half, 0], max: [c[0] + POST.half, c[1] + POST.half, 5] }),
        views: { assembly: (s) => s },
      },
      bar: {
        label: "Bar",
        build: (k, p) => {
          if (readsOpen) void p.open;
          const b = k.box({ min: [0, -0.5, 0], max: [40, 0.5, 5] });
          b.boundingBox(); // a query: the probe answers with a stand-in
          return b;
        },
        views: { assembly: (s, p) => s.rotate(p.open, [0, 0, 0], [0, 0, 1]) },
      },
    },
    views: { assembly: { label: "Assembly" } },
    collisions: {},
    verify: { sweeps: { open: { param: "open", clearance: 0 } } },
  };
}
