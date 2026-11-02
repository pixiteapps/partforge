// crankSlider: an in-line slider-crank, from the closed form. The crank turns about its
// centre; the rod joins the crank pin to a slider on the line through the centre along
// `slideDirection`. A point source that also places the crank, the rod and the slider.
import { failer, vec3, unit, num, frameFor, placeIn, json3, rad, deg } from "./frame.js";

/**
 * `crank`: `{ center, axis = [0, 0, 1], length, angle }` (angle 0 points the crank along
 * `slideDirection`, positive turns it counter-clockwise about `axis`); `rod`: the rod's
 * length, at least the crank's. The slider sits at
 * `center + (L cos a + √(rod² − L² sin² a)) · slideDirection`.
 */
export function crankSlider(def) {
  const fail = failer("crankSlider");
  if (!def || typeof def !== "object") fail("", "takes { crank, rod, slideDirection }");
  const c = def.crank;
  if (!c || typeof c !== "object") fail("crank", "must be { center, length, angle }");
  const center = vec3(fail, "crank.center", c.center);
  const axis = unit(fail, "crank.axis", c.axis ?? [0, 0, 1]);
  const L = num(fail, "crank.length", c.length, { positive: true });
  const angle = num(fail, "crank.angle", c.angle);
  const rod = num(fail, "rod", def.rod, { positive: true });
  if (rod < L) fail("rod", `must be at least the crank's length (${L}), got ${rod}`);
  const frame = frameFor(fail, "slideDirection", axis, unit(fail, "slideDirection", def.slideDirection));
  const a = rad(angle), ca = Math.cos(a), sa = Math.sin(a);
  const along = (s, t) => [0, 1, 2].map((i) => center[i] + s * frame.x[i] + t * frame.y[i]);
  const x = L * ca + Math.sqrt(Math.max(0, rod * rod - L * L * sa * sa));
  const crankPin = along(L * ca, L * sa);
  const slider = along(x, 0);
  const rodAngle = deg(Math.atan2(-L * sa, x - L * ca));

  return {
    /** The crank pin, part coordinates. */
    crankPin: json3(crankPin),
    /** The slider's pin, on the slide line, part coordinates. */
    slider: json3(slider),
    /** `crank.center`, `crank.pin`, `slider`; the crank's axis; the crank and the rod as lines. */
    handleInfo() {
      return {
        kind: "partforge.points",
        points: { "crank.center": json3(center), "crank.pin": json3(crankPin), slider: json3(slider) },
        axes: { crank: { origin: json3(center), direction: json3(axis) } },
        lines: [["crank.center", "crank.pin"], ["crank.pin", "slider"]],
      };
    },
    /**
     * Each member is built in its own frame, its axis along +Z and the slide direction
     * (at angle 0) along +X: "crank" from its pivot at the origin, "rod" from the crank pin
     * at the origin toward +X, "slider" centred on its pin. Each is turned and moved to
     * where the linkage puts it.
     */
    place: (name, solid) => {
      if (name === "crank") return placeIn(solid, frame, angle, center);
      if (name === "rod") return placeIn(solid, frame, rodAngle, crankPin);
      if (name === "slider") return placeIn(solid, frame, 0, slider);
      return fail("", `place: unknown member ${JSON.stringify(name)} (one of "crank", "rod", "slider")`);
    },
  };
}
