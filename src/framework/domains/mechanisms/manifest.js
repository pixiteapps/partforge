export default {
  id: "mechanisms",
  title: "Mechanisms",
  when: "gears, gear trains, pulleys and belts, racks, cranks and sliders; parts that move together",
  subpath: "partforge/mechanisms",
  guide: "docs/domains/mechanisms.md",
  referenceParts: ["src/parts/gearbox.js", "src/parts/drawer-box.js"],
  kernelOps: [],
  lintRules: [],
  oracle: { facts: null, metrics: {}, checks: [] },
  processes: [],
  workerSafe: true,
};
