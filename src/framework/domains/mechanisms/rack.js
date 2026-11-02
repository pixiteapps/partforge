// rack: a pinion turning a straight rack. The rack's travel is the pitch arc the pinion
// has rolled: rad(angle) * pitch radius. A point source that also places the pinion
// (turned) and the rack (slid).
import { failer, vec3, unit, num, memberName, frameFor, onCircle, placeIn, json3, rad, cross, dot, add } from "./frame.js";

/**
 * `pinion`: `{ name, teeth, module, center, axis = [0, 0, 1], angle }`; `direction`: the
 * way the rack moves for a positive pinion angle (at right angles to the axis); `name`:
 * the rack's name (default "rack"). The rack meshes on the side `direction × axis` of
 * the pinion, which is where a counter-clockwise pinion pushes its rack along
 * `direction`.
 */
export function rack(def) {
  const fail = failer("rack");
  if (!def || typeof def !== "object") fail("", "takes { pinion, direction }");
  const pin = def.pinion;
  if (!pin || typeof pin !== "object") fail("pinion", "must be { name, teeth, module, center, angle }");
  const seen = new Set();
  const pinionName = memberName(fail, "pinion.name", pin.name, seen);
  const rackName = memberName(fail, "name", def.name ?? "rack", seen);
  const axis = unit(fail, "pinion.axis", pin.axis ?? [0, 0, 1]);
  const center = vec3(fail, "pinion.center", pin.center);
  const radius = (num(fail, "pinion.module", pin.module, { positive: true }) * num(fail, "pinion.teeth", pin.teeth, { positive: true })) / 2;
  const angle = num(fail, "pinion.angle", pin.angle);
  const raw = unit(fail, "direction", def.direction);
  const w = add(raw, axis, -dot(raw, axis));
  const wl = Math.hypot(w[0], w[1], w[2]);
  if (!(wl > 1e-9)) fail("direction", "must not be parallel to the pinion's axis");
  const direction = [w[0] / wl, w[1] / wl, w[2] / wl];
  const frame = frameFor(fail, "pinion.axis", axis);
  const travel = rad(angle) * radius;
  const contact = add(center, cross(direction, axis), radius);

  return {
    /** How far the rack has moved along `direction`, mm (negative for a negative angle). */
    travel,
    /** `<pinion>.center`, `<pinion>.rim`, and `<rack>.pitch` (the rack's pitch-line mark that met the pinion at travel 0). */
    handleInfo() {
      return {
        kind: "partforge.points",
        points: {
          [`${pinionName}.center`]: json3(center),
          [`${pinionName}.rim`]: json3(onCircle(center, frame, radius, angle)),
          [`${rackName}.pitch`]: json3(add(contact, direction, travel)),
        },
        axes: {
          [pinionName]: { origin: json3(center), direction: json3(axis) },
          [rackName]: { origin: json3(contact), direction: json3(direction) },
        },
        lines: [[`${pinionName}.center`, `${rackName}.pitch`]],
      };
    },
    /**
     * The pinion: a solid built about +Z through the origin, turned and set at its centre.
     * The rack: a solid built where it sits at travel 0, slid by `travel`.
     */
    place: (name, solid) => {
      if (name === pinionName) return placeIn(solid, frame, angle, center);
      if (name === rackName) return solid.translate(json3(direction.map((c) => c * travel)));
      return fail("", `place: unknown member ${JSON.stringify(name)} (the pinion is "${pinionName}", the rack "${rackName}")`);
    },
  };
}
