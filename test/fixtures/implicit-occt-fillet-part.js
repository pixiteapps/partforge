// An organic sub-part beside a CAD sub-part whose fillet needs OCCT (a function selector):
// no single backend builds the part, which the CLI must say plainly (test/cli-occt.test.js).
export default {
  meta: { title: "Mixed" },
  defaults: {},
  parts: {
    grip: { label: "Grip", views: { main: true }, build: (k) => k.implicit({ root: { kind: "sphere", r: 6 }, resolution: 1, preview: 1 }) },
    plate: { label: "Plate", views: { main: true },
      build: (k) => k.box({ min: [10, -5, 0], max: [30, 5, 4] }).fillet({ r: 1, edges: (e) => e.inDirection("Z") }) },
  },
  views: { main: { label: "Main" } },
};
