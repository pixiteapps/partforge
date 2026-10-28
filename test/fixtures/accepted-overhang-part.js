// A T printed upright: the slab's underside is an overhang (a cost under the FDM
// profile), and `accept: ["supports"]` records that the author chose supports.
export default {
  meta: { title: "Accepted tee", units: "mm" },
  defaults: { w: 20 },
  parts: { tee: { views: ["v"], build: (k, p) => k.box({ size: [p.w, 10, 4] }).translate([-p.w / 2, 0, 6])
    .union(k.box({ size: [4, 10, 6] }).translate([-2, 0, 0])) } },
  views: { v: { label: "V" } },
  verify: { process: "fdm-pla", accept: ["supports"] },
};
