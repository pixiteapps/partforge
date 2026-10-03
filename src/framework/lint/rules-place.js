// Group 6 — the two place() invariants (docs/AUTHORING-PARTS.md "Display vs
// export placement"), promoted from doc-only conventions to lint because the
// animation system leans on place() for every pose-only track:
//   1. Display placement must not depend on the active view (display meshes
//      are cached across views; a view-dependent pose serves stale geometry).
//   2. Display vs export may differ only by a rigid motion (translate/rotate).
// Both checks run the place-scope pose probe: place() alone, on a canonical token,
// so build() may query freely without hiding a finding. A READABLE result carries
// `baseHash` (CANONICAL for translate/rotate only, another hash when place()
// reshapes) and `pose`; a place() the probe cannot read (it queries the solid or
// passes a function) returns `{ trusted: false }` with no baseHash, proves nothing,
// and stays silent. Readability, not `trusted`, gates the rules: the same reshape
// on both purposes is allowed, so a reshaping place() must still be compared.
import { err } from "./finding.js";
import { probeSubPartPose } from "../pose-probe-core.js";

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

// The sub-part names visible in a view at params p — restated locally (like
// rules-schema.js restates controls.js's visibility predicates) rather than
// imported from jobs.js, which would break the lint purity closure.
function viewNames(part, view, p) {
  return Object.entries(isPlainObject(part?.parts) ? part.parts : {})
    .filter(([, sp]) => Array.isArray(sp?.views) && sp.views.includes(view))
    .filter(([, sp]) => { try { return sp.enabled ? !!sp.enabled(p) : true; } catch { return false; } })
    .map(([name]) => name);
}

const poseKey = (pose) => JSON.stringify(pose);
const readable = (probe) => probe.baseHash !== undefined;
const probePlace = (sp, ctx) => probeSubPartPose(sp, ctx, { scope: "place" });

export const PLACE_RULES = [
  {
    id: "view-dependent-display-place",
    run: ({ part, p, d }) => {
      const out = [];
      const views = Object.keys(isPlainObject(part?.views) ? part.views : {});
      if (views.length < 2) return out;
      for (const [name, sp] of Object.entries(isPlainObject(part?.parts) ? part.parts : {})) {
        const inViews = views.filter((v) => viewNames(part, v, p).includes(name));
        if (inViews.length < 2) continue;
        const probes = inViews.map((view) => probePlace(sp, { view, purpose: "display", p, d }));
        if (!probes.every(readable)) continue;
        const first = probes[0];
        const differs = probes.some((x) => x.baseHash !== first.baseHash || poseKey(x.pose) !== poseKey(first.pose));
        if (differs) {
          out.push(err("view-dependent-display-place",
            `sub-part "${name}" display placement differs between views (${inViews.join(", ")})`,
            "Display meshes are built once per sub-part and cached across views, so a view-dependent display pose shows stale geometry after a tab switch. Only `place(..., { purpose: \"export\" })` may vary; keep the display branch view-independent.",
            `parts.${name}.place`,
            "view-dependent-display-place"));
        }
      }
      return out;
    },
  },
  {
    id: "place-not-rigid",
    run: ({ part, p, d }) => {
      const out = [];
      for (const [name, sp] of Object.entries(isPlainObject(part?.parts) ? part.parts : {})) {
        if (!sp?.place) continue;
        for (const view of Object.keys(isPlainObject(part?.views) ? part.views : {})) {
          if (!viewNames(part, view, p).includes(name)) continue;
          const display = probePlace(sp, { view, purpose: "display", p, d });
          const exportP = probePlace(sp, { view, purpose: "export", p, d });
          if (!readable(display) || !readable(exportP)) continue;
          if (display.baseHash !== exportP.baseHash) {
            out.push(err("place-not-rigid",
              `sub-part "${name}" display and export placements differ by more than a rigid motion (view "${view}")`,
              "place() may move a solid between purposes (translate/rotate) but never reshape it — a geometry op on one branch means the exported part is not the previewed part. Move the op into build().",
              `parts.${name}.place`,
              "place-not-rigid"));
            break; // one finding per sub-part — further views add nothing
          }
        }
      }
      return out;
    },
  },
];
