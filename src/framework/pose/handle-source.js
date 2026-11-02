// Where a handle sits (spec 2026-11-02 sections 1-2). A handle is a point on a posed
// limb, on any value `derive` returned that answers `handleInfo()`, or one a part
// function computes. This module reads that point and the axis a rotary or axis drag
// turns about, and turns it into the pseudo-limb record Pose mode draws. Pure: no DOM,
// no three.js, no node:, and no domain folder - a source is recognised by plain data
// (`typeof v?.handleInfo === "function"`), never instanceof, since the cloud's worker
// holds two copies of this code.

const isFn = (v) => typeof v === "function";

/** "limb" | "on" | "point" | null: `limb` wins; otherwise exactly one of `on` / `point`. */
export function handleKind(h) {
  if (!h || typeof h !== "object") return null;
  if (h.limb != null) return "limb";
  const hasOn = h.on != null;
  const hasPoint = h.point != null;
  if (hasOn === hasPoint) return null;
  return hasOn ? "on" : "point";
}

// Every schema parameter a pose handle writes: an angles handle's list, a goal
// handle's position and aim, and its seed. What decides the views it shows in.
// The other kinds list `params`, plus the lock parameter that gates them.
export function handleParamKeys(handle) {
  if (handleKind(handle) === "on" || handleKind(handle) === "point") {
    const listed = Array.isArray(handle.params) ? handle.params : [];
    return [...listed, ...(typeof handle.lock === "string" ? [handle.lock] : [])].filter((k) => typeof k === "string");
  }
  const p = handle?.params;
  const listed = Array.isArray(p) ? p : [...(Array.isArray(p?.position) ? p.position : []), ...(Array.isArray(p?.aim) ? p.aim : [])];
  return [...listed, ...(Array.isArray(handle?.seed) ? handle.seed : [])].filter((k) => typeof k === "string");
}

/** The point name a pin id and record use: `at` for `on`, "point" for `point`, `at ?? "tip"` for a limb. */
export function handleAt(h) {
  const kind = handleKind(h);
  if (kind === "point") return "point";
  if (kind === "limb") return h.at ?? "tip";
  return h?.at;
}

/** A source's `handleInfo()` JSON, or null when `d[key]` is not a point source. */
export function sourceInfo(d, key) {
  const v = d?.[key];
  if (!isFn(v?.handleInfo)) return null;
  const info = v.handleInfo();
  return info && typeof info === "object" ? info : null;
}

/** A geometric field is a value or a `(p, d) => value`. */
export function resolveGeom(value, p, d) {
  return isFn(value) ? value(p, d) : value;
}

const isPoint = (v) => Array.isArray(v) && v.length === 3 && v.every((c) => Number.isFinite(c));

/** The handle's point in part coordinates. THROWS when it cannot be read (a solve scores that FAILED). */
export function locateHandle(part, p, d, handle) {
  const kind = handleKind(handle);
  let out;
  if (kind === "limb") {
    out = d?.[handle.limb]?.world(handleAt(handle)).origin;
  } else if (kind === "on") {
    const info = sourceInfo(d, handle.on);
    if (!info) throw new Error(`handle: derive().${handle.on} is not a point source`);
    out = info.points?.[handle.at];
  } else if (kind === "point") {
    if (!isFn(handle.point)) throw new Error("handle: point must be a function");
    out = handle.point(p, d);
  } else {
    throw new Error("handle: needs exactly one of limb, on, point");
  }
  if (!isPoint(out)) throw new Error(`handle: no readable point (${kind})`);
  return [out[0], out[1], out[2]];
}

/** The axis a drag turns or slides along: `{ origin, direction }` or null. */
export function handleAxis(handle, p, d) {
  const drag = handle?.drag;
  const point = () => locateHandle(null, p, d, handle);
  const vec = (v) => (Array.isArray(v) && v.length === 3 && v.every((c) => Number.isFinite(c)) ? v : null);
  if (drag === "axis") {
    const direction = vec(resolveGeom(handle.direction, p, d));
    return direction ? { origin: point(), direction } : null;
  }
  if (drag === "plane") {
    const direction = vec(resolveGeom(handle.normal, p, d));
    return direction ? { origin: point(), direction } : null;
  }
  if (drag === "rotary") {
    const given = resolveGeom(handle.axis, p, d);
    if (given && vec(given.origin) && vec(given.direction)) return { origin: given.origin, direction: given.direction };
    if (handleKind(handle) !== "on") return null;
    const ax = sourceInfo(d, handle.on)?.axes?.[String(handle.at).split(".")[0]];
    return ax && vec(ax.origin) && vec(ax.direction) ? { origin: ax.origin, direction: ax.direction } : null;
  }
  return null;
}

/**
 * The pseudo-limb record Pose mode draws for an `on` / `point` handle, or null (a limb
 * handle, an invalid one, or an unreadable point). `d` is already resolved.
 */
export function handleRecord(part, params, d, handleId) {
  const handle = part?.handles?.[handleId];
  const kind = handleKind(handle);
  if (kind !== "on" && kind !== "point") return null;
  const p = { ...part.defaults, ...params };
  let tip;
  try { tip = locateHandle(part, p, d, handle); } catch { return null; }
  const rec = {
    kind: "partforge.handle", name: `handle:${handleId}`, handleId,
    joints: [], points: { tip }, tip: "tip", values: [], axes: {},
    drag: handle.drag ?? "point", axis: null,
  };
  try { rec.axis = handleAxis(handle, p, d); } catch { rec.axis = null; }
  if (kind === "on") {
    const pts = sourceInfo(d, handle.on)?.points ?? {};
    const lines = (sourceInfo(d, handle.on)?.lines ?? [])
      .map(([a, b]) => [pts[a], pts[b]])
      .filter(([a, b]) => isPoint(a) && isPoint(b));
    if (lines.length) rec.lines = lines;
  }
  return rec;
}
