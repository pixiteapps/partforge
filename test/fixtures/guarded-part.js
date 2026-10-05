// The shape of feedback #158: a param read only past a geometry guard. The
// probe answers volume() with a stand-in of 1, so it takes the other branch and
// never sees cellR; the real build does. (The original guard was isEmpty(),
// which the probe now answers realistically — any query whose dummy disagrees
// with the real geometry shows the same thing.) Its own module so several test files can share it.
export const guarded = {
  defaults: { size: 20, cellR: 2, unused: 1 },
  views: { v: { label: "V" } },
  parts: {
    insert: { views: ["v"], build: (k, p) => {
      const body = k.box({ min: [0, 0, 0], max: [p.size, p.size, 4] });
      const region = k.box({ min: [2, 2, -1], max: [p.size - 2, p.size - 2, 5] });
      return region.volume() < 10 ? body : body.cut(k.cylinder({ r: p.cellR, h: 10 }).translate([p.size / 2, p.size / 2, -2]));
    } },
  },
};
