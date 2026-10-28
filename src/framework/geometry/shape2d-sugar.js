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
  // .extrude({ h, twist?, scaleTop?, bevel? }) / .revolve({ degrees? }) → Solid. Sugar for
  // k.extrude({ profile: shape, … }) / k.revolve({ profile: shape, … }). Every option is
  // forwarded as-is, so the kernel op's own key/required-arg validation fires: a missing
  // `h` throws "extrude: h is required", an unknown key throws, and an option the kernel
  // grows later (as `bevel` was) works here with no change. Never list the keys: a list
  // silently drops whatever it leaves out. `profile` is refused — this shape is the profile.
  const sugar = (op, fn) => (o = {}) => {
    if (o.profile !== undefined) throw new Error(`Shape2D.${op}: don't pass profile — the shape you call .${op}() on is the profile`);
    return fn({ ...o, profile: s });
  };
  s.extrude = sugar("extrude", extrude);
  s.revolve = sugar("revolve", revolve);
  return s;
}
