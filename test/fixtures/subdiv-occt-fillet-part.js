// A subdivision sub-part beside a CAD sub-part whose fillet needs OCCT (a function
// selector): no single backend builds the part, which the CLI must say plainly, naming
// k.subdiv (test/cli-occt.test.js).
export default {
  meta: { title: "Mixed" },
  defaults: {},
  parts: {
    body: { label: "Body", views: { main: true }, build: (k) => k.subdiv(k.cage({ box: { size: [12, 12, 12] } })) },
    plate: { label: "Plate", views: { main: true },
      build: (k) => k.box({ min: [10, -5, 0], max: [30, 5, 4] }).fillet({ r: 1, edges: (e) => e.inDirection("Z") }) },
  },
  views: { main: { label: "Main" } },
};
