// gearTrain: every gear's angle from one drive angle and the tooth ratios, as a point
// source (handleInfo) that also places each gear's solid (place). Motion only: the
// helper builds no tooth; a part draws its own gears.
import { failer, vec3, unit, num, memberName, frameFor, onCircle, placeIn, json3 } from "./frame.js";

/**
 * `gears`: `[{ name, teeth, module, center, axis = [0, 0, 1], meshesWith?, internal? }]`,
 * `meshesWith` one gear name or a list. `drive`: `{ gear, angle }` (degrees, unreduced).
 * Across a mesh the angle scales by `-teethA / teethB`, or `+teethA / teethB` when either
 * gear is `internal` (a ring gear turns the same way as its pinion). Every gear must be
 * connected to the drive; a loop of meshes must agree with itself.
 */
export function gearTrain(def) {
  const fail = failer("gearTrain");
  if (!def || typeof def !== "object") fail("", "takes { gears, drive }");
  const { gears, drive } = def;
  if (!Array.isArray(gears) || !gears.length) fail("gears", "must be a non-empty array");
  const seen = new Set();
  const byName = new Map();
  const list = gears.map((g, i) => {
    const at = `gears[${i}]`;
    if (!g || typeof g !== "object") fail(at, "must be { name, teeth, module, center }");
    const name = memberName(fail, `${at}.name`, g.name, seen);
    const axis = unit(fail, `${at}.axis`, g.axis ?? [0, 0, 1]);
    const out = {
      name,
      teeth: num(fail, `${at}.teeth`, g.teeth, { positive: true }),
      module: num(fail, `${at}.module`, g.module, { positive: true }),
      center: vec3(fail, `${at}.center`, g.center),
      axis,
      frame: frameFor(fail, `${at}.axis`, axis),
      internal: g.internal === true,
      meshesWith: g.meshesWith == null ? [] : Array.isArray(g.meshesWith) ? g.meshesWith : [g.meshesWith],
    };
    byName.set(name, out);
    return out;
  });
  // Meshes, undirected, in declaration order; each pair once.
  const pairs = [];
  const neighbours = new Map(list.map((g) => [g.name, []]));
  const paired = new Set();
  for (const g of list) {
    for (const other of g.meshesWith) {
      if (!byName.has(other)) fail(`${g.name}.meshesWith`, `unknown gear ${JSON.stringify(other)}`);
      if (other === g.name) fail(`${g.name}.meshesWith`, "a gear cannot mesh with itself");
      const key = [g.name, other].sort().join("\u0000");
      if (paired.has(key)) continue;
      paired.add(key);
      pairs.push([g.name, other]);
      neighbours.get(g.name).push(other);
      neighbours.get(other).push(g.name);
    }
  }
  if (!drive || typeof drive !== "object" || !byName.has(drive.gear)) fail("drive.gear", `must name a gear, got ${JSON.stringify(drive?.gear)}`);
  const driveAngle = num(fail, "drive.angle", drive.angle);

  // Each gear's ratio to the drive, breadth-first.
  const ratio = new Map([[drive.gear, 1]]);
  const queue = [drive.gear];
  while (queue.length) {
    const a = byName.get(queue.shift());
    for (const name of neighbours.get(a.name)) {
      const b = byName.get(name);
      const r = ratio.get(a.name) * ((a.internal || b.internal) ? 1 : -1) * (a.teeth / b.teeth);
      if (!ratio.has(name)) { ratio.set(name, r); queue.push(name); }
      else if (Math.abs(ratio.get(name) - r) > 1e-9 * Math.max(1, Math.abs(r))) fail(`${name}.meshesWith`, "a loop of meshes locks the train (its ratios disagree)");
    }
  }
  for (const g of list) if (!ratio.has(g.name)) fail(`${g.name}`, `"${g.name}" is not connected to the drive gear "${drive.gear}"`);

  const angles = new Map(list.map((g) => [g.name, ratio.get(g.name) * driveAngle]));
  const gear = (op, name) => byName.get(name) ?? fail("", `${op}: unknown gear ${JSON.stringify(name)}`);

  return {
    /** The gear's angle, degrees, unreduced. */
    angleOf: (name) => angles.get(gear("angleOf", name).name),
    /** `<gear>.center` and `<gear>.rim` (the pitch radius along the gear's +X, turned by its angle), an axis per gear, a line per mesh. */
    handleInfo() {
      const points = {}, axes = {};
      for (const g of list) {
        points[`${g.name}.center`] = json3(g.center);
        points[`${g.name}.rim`] = json3(onCircle(g.center, g.frame, (g.module * g.teeth) / 2, angles.get(g.name)));
        axes[g.name] = { origin: json3(g.center), direction: json3(g.axis) };
      }
      return { kind: "partforge.points", points, axes, lines: pairs.map(([a, b]) => [`${a}.center`, `${b}.center`]) };
    },
    /** A solid built about +Z through the origin, turned to the gear's angle and set on its axis at its centre. */
    place: (name, solid) => {
      const g = gear("place", name);
      return placeIn(solid, g.frame, angles.get(g.name), g.center);
    },
  };
}
