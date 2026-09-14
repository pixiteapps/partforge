// Backend-shared Shape2D front. Like solid-sugar for Solids: backends attach the geometry
// ops (booleans, area, boundingBox, toRegions); this layers on the backend-agnostic sugar.
// `deps` are the backend's own functions the sugar defers to: `shape2d` (lift a region back
// into a Shape2D) and `extrude`/`revolve` (build a Solid from this shape).
export function addShape2dSugar(s, { shape2d, extrude, revolve }) {
  // .simple() → the single {outer,holes} region, or throw (a raw region, not a Shape2D).
  s.simple = () => {
    const regions = s.toRegions();
    if (regions.length !== 1) throw new Error(`Shape2D.simple: result has ${regions.length} regions, not 1 (use toRegions())`);
    return regions[0];
  };
  // .regions() → scission: each disjoint region as its own live Shape2D (booleanable further).
  // `trusted`: these regions are this shape's own, already validated when it was
  // lifted and resolved by every boolean since — re-lifting them untrusted would
  // re-run profile validation on machine-produced geometry on every call.
  s.regions = () => s.toRegions().map((r) => shape2d.trusted(r));
  // .extrude({ h, twist?, scaleTop? }) / .revolve({ degrees? }) → Solid. Sugar for
  // k.extrude({ profile: shape, … }) / k.revolve({ profile: shape, … }). Passed as an
  // options object (not positional) so the kernel op's key/required-arg validation still
  // fires — e.g. a missing `h` throws "extrude: h is required" rather than silently
  // producing empty geometry.
  s.extrude = ({ h, twist, scaleTop } = {}) => extrude({ profile: s, h, twist, scaleTop });
  s.revolve = ({ degrees } = {}) => revolve({ profile: s, degrees });
  return s;
}
