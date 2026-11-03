// The `handles` list of a measure() / inspect report (spec 2026-11-02 section 7). One
// entry per handle Pose mode would show in the view, in declaration order, so an agent
// (and partforge-cloud) can say where a handle sits and which params it drives. The
// shape is a contract with the cloud. Reads derived values only - never the kernel -
// and never fails the report: a handle whose point throws is listed with `point: null`.
// DOM-free, three-free and node:-free like the rest of the oracle.

import { resolveParams } from "../part-model.js";
import { handleKind, handleAxis, locateHandle } from "../pose/handle-source.js";
import { handlesShownInView } from "../pose/handle-views.js";
import { groupOf } from "../pose/handle-groups.js";

const round = (v) => Math.round(v * 1000) / 1000 + 0; // + 0 turns -0 into 0
const roundVec = (v) => v.map(round);

// The params a handle writes, in report order: a goal handle's position then aim (not
// its seed), an angles handle's list, a generic handle's `params`.
function reportParams(handle) {
  const p = handle.params;
  const listed = Array.isArray(p) ? p : [...(Array.isArray(p?.position) ? p.position : []), ...(Array.isArray(p?.aim) ? p.aim : [])];
  return listed.filter((k) => typeof k === "string");
}

const firstLine = (e) => String(e?.message ?? e).split("\n")[0].slice(0, 120);

/** `handles` for one view at `params`, or undefined when the part declares none. */
export function handlesReport(part, view, params = {}) {
  const handles = part?.handles;
  if (!handles || typeof handles !== "object" || Array.isArray(handles)) return undefined;
  const ids = Object.keys(handles).filter((id) => handles[id] && typeof handles[id] === "object");
  if (!ids.length) return undefined;
  const p = { ...part.defaults, ...params };
  // Pose mode's own rule (pose/handle-views.js): a declared `views` list, else relevance
  // and a drawn source. It never throws: an analysis that fails shows the handle.
  let shown = ids;
  try { shown = handlesShownInView(part, view, p); } catch { /* everything shows */ }
  let d = null;
  let derr = null;
  try { d = resolveParams(part, params).d; } catch (e) { derr = e; }
  return shown.map((id) => {
    const handle = handles[id];
    const entry = {
      id,
      label: handle.label ?? id,
      kind: handle.drag ?? "point",
      point: null,
      params: reportParams(handle),
      locked: typeof handle.lock === "string" && !!p[handle.lock],
    };
    const group = groupOf(handle);
    if (group != null) entry.group = group;
    try {
      if (derr) throw derr;
      entry.point = roundVec(locateHandle(part, p, d, handle));
    } catch (e) {
      entry.error = firstLine(e);
      return entry;
    }
    if (handleKind(handle, d) !== "limb") {
      let axis = null;
      try { axis = handleAxis(handle, p, d); } catch { axis = null; }
      if (axis) {
        entry.direction = roundVec(axis.direction);
        if (handle.drag === "rotary") entry.origin = roundVec(axis.origin);
      }
    }
    return entry;
  });
}
