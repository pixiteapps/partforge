// A rope drive for the lines tests: a drum and a pulley placed by one `capstan` in derive,
// the rope declared as a line on it.
import { capstan } from "../../src/framework/domains/mechanisms/index.js";

export const make = (angle) => capstan({
  rope: { d: 1.2 },
  input: { name: "drum", radius: 6, center: [0, 0, 0], turns: 3 },
  output: { name: "pulley", radius: 30, center: [40, 0, 0] },
  drive: { member: "drum", angle },
});

export const concentricCapstan = {
  meta: { title: "Capstan", units: "mm" },
  parameters: [{ id: "m", title: "Motor", description: "The drive.", controls: [
    { key: "motorAngle", label: "Motor", unit: "°", min: -200, max: 200, step: 1, description: "Drum angle." },
  ] }],
  defaults: { motorAngle: 0 },
  derive: (p) => ({ drive: make(p.motorAngle) }),
  parts: {
    drum: { label: "Drum", build: (k) => k.box({ min: [-6, -6, 0], max: [6, 6, 10] }),
      views: { assembly: (s, p, d) => d.drive.place("drum", s) } },
    pulley: { label: "Pulley", build: (k) => k.box({ min: [-30, -30, 0], max: [30, 30, 10] }),
      views: { assembly: (s, p, d) => d.drive.place("pulley", s) } },
  },
  views: { assembly: { label: "Assembly" } },
  lines: { rope: { on: "drive" } },
};
export default concentricCapstan;
