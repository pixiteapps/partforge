export default {
  id: "kinematics",
  title: "Kinematics",
  when: "jointed limbs, fingers, arms, robot hands; posing links about joints; reach and grip",
  subpath: "partforge/kinematics",
  guide: "docs/domains/kinematics.md",
  referenceParts: ["src/parts/robot-finger.js"],
  kernelOps: [],
  lintRules: [],
  oracle: { facts: null, metrics: {}, checks: [] },
  processes: [],
  workerSafe: true,
};
