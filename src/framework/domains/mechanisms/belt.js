// beltDrive: pulleys on one belt, each turned by the diameter ratio to the drive pulley,
// all the same way. A point source that also places each pulley's solid.
import { failer, vec3, unit, num, memberName, frameFor, onCircle, placeIn, json3 } from "./frame.js";

/**
 * `pulleys`: `[{ name, diameter, center, axis = [0, 0, 1] }]` (pitch diameters, mm), all on
 * one belt. `drive`: `{ pulley, angle }` (degrees, unreduced). A pulley's angle is
 * `angle * dDrive / d`: the belt moves the same distance over every pitch circle.
 */
export function beltDrive(def) {
  const fail = failer("beltDrive");
  if (!def || typeof def !== "object") fail("", "takes { pulleys, drive }");
  const { pulleys, drive } = def;
  if (!Array.isArray(pulleys) || !pulleys.length) fail("pulleys", "must be a non-empty array");
  const seen = new Set();
  const list = pulleys.map((q, i) => {
    const at = `pulleys[${i}]`;
    if (!q || typeof q !== "object") fail(at, "must be { name, diameter, center }");
    const axis = unit(fail, `${at}.axis`, q.axis ?? [0, 0, 1]);
    return {
      name: memberName(fail, `${at}.name`, q.name, seen),
      diameter: num(fail, `${at}.diameter`, q.diameter, { positive: true }),
      center: vec3(fail, `${at}.center`, q.center),
      axis, frame: frameFor(fail, `${at}.axis`, axis),
    };
  });
  const byName = new Map(list.map((q) => [q.name, q]));
  const driver = byName.get(drive?.pulley) ?? fail("drive.pulley", `must name a pulley, got ${JSON.stringify(drive?.pulley)}`);
  const driveAngle = num(fail, "drive.angle", drive.angle);
  const angles = new Map(list.map((q) => [q.name, (driveAngle * driver.diameter) / q.diameter]));
  const pulley = (op, name) => byName.get(name) ?? fail("", `${op}: unknown pulley ${JSON.stringify(name)}`);

  return {
    /** The pulley's angle, degrees, unreduced. */
    angleOf: (name) => angles.get(pulley("angleOf", name).name),
    /**
     * `<pulley>.center`, `<pulley>.rim` (on the pitch circle along the pulley's +X, turned
     * by its angle) and `belt`, the top of the first pulley's pitch circle (its +Y), where
     * the belt runs. An axis per pulley, a line between neighbours.
     */
    handleInfo() {
      const points = {}, axes = {};
      for (const q of list) {
        points[`${q.name}.center`] = json3(q.center);
        points[`${q.name}.rim`] = json3(onCircle(q.center, q.frame, q.diameter / 2, angles.get(q.name)));
        axes[q.name] = { origin: json3(q.center), direction: json3(q.axis) };
      }
      points.belt = json3(onCircle(list[0].center, list[0].frame, list[0].diameter / 2, 90));
      const lines = list.slice(1).map((q, i) => [`${list[i].name}.center`, `${q.name}.center`]);
      return { kind: "partforge.points", points, axes, lines };
    },
    /** A solid built about +Z through the origin, turned to the pulley's angle and set at its centre. */
    place: (name, solid) => {
      const q = pulley("place", name);
      return placeIn(solid, q.frame, angles.get(q.name), q.center);
    },
  };
}
