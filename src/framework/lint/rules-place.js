// Lint ids here: place-not-rigid (legacy views-array + place() form), and for the views-map
// form view-entry-invalid (an entry that is not true or a pose), views-and-place (an author
// place beside a map) and view-pose-not-rigid (an entry that reshapes instead of moving).
// Group 6 — the place() invariant (docs/AUTHORING-PARTS.md "Display vs export
// placement"), promoted from a doc-only convention to lint because the animation
// system leans on place() for every pose-only track: display vs export may differ
// only by a rigid motion (translate/rotate). A second rule, view-dependent-display-
// place, forbade a display pose that varies by view; it was retired in 0.142 — since
// 0.141 the viewer meshes the canonical build once (the mesh cache stamps the view)
// and re-poses it on every tab switch, so the stale-geometry hazard it named is gone,
// and as a lint ERROR it refused to load the one-piece-per-sub-part shape a per-view
// layout needs (partforge-cloud feedback #161/#162).
// The check runs the place-scope pose probe: place() alone, on a canonical token,
// so build() may query freely without hiding a finding. A READABLE result carries
// `baseHash` (CANONICAL for translate/rotate only, another hash when place()
// reshapes) and `pose`; a place() the probe cannot read (it queries the solid or
// passes a function) returns `{ trusted: false }` with no baseHash, proves nothing,
// and stays silent. Readability, not `trusted`, gates the rules: the same reshape
// on both purposes is allowed, so a reshaping place() must still be compared.
import { err } from "./finding.js";
import { probeSubPartPose, CANONICAL } from "../pose-probe-core.js";
import { isViewsMap, inView, formOf } from "../sub-part-views.js";
import { isSheetPart } from "../sheet/constants.js";

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

// The sub-part names visible in a view at params p — restated locally (like
// rules-schema.js restates controls.js's visibility predicates) rather than
// imported from jobs.js, which would break the lint purity closure.
function viewNames(part, view, p) {
  return Object.entries(isPlainObject(part?.parts) ? part.parts : {})
    .filter(([, sp]) => inView(sp, view))
    .filter(([, sp]) => { try { return sp.enabled ? !!sp.enabled(p) : true; } catch { return false; } })
    .map(([name]) => name);
}

const readable = (probe) => probe.baseHash !== undefined;
const probePlace = (sp, ctx) => probeSubPartPose(sp, ctx, { scope: "place" });

export const PLACE_RULES = [
  {
    id: "place-not-rigid",
    run: ({ part, p, d }) => {
      const out = [];
      for (const [name, sp] of Object.entries(isPlainObject(part?.parts) ? part.parts : {})) {
        if (!sp?.place || formOf(sp) === "map") continue;
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
  {
    id: "view-entry-invalid",
    run: ({ part }) => {
      const out = [];
      for (const [name, sp] of Object.entries(isPlainObject(part?.parts) ? part.parts : {})) {
        if (!isViewsMap(sp?.views)) continue;
        for (const [view, entry] of Object.entries(sp.views)) {
          if (entry === true || typeof entry === "function") continue;
          out.push(err("view-entry-invalid",
            `sub-part "${name}" has ${JSON.stringify(entry) ?? String(entry)} for view "${view}"`,
            `Each entry in a sub-part's \`views\` map is \`true\` (shown as built) or a pose \`(s, p, d) => s.translate(…)\`. To leave the piece out of "${view}", delete the key.`,
            `parts.${name}.views.${view}`,
            "view-entry-invalid"));
        }
      }
      return out;
    },
  },
  {
    id: "views-and-place",
    run: ({ part }) => {
      const out = [];
      for (const [name, sp] of Object.entries(isPlainObject(part?.parts) ? part.parts : {})) {
        if (!isViewsMap(sp?.views) || typeof sp.place !== "function") continue;
        const generated = isSheetPart(sp) && sp.place === sp.sheet.generatedPlace && sp.sheet.place == null;
        if (generated) continue;
        out.push(err("views-and-place",
          `sub-part "${name}" has both a \`views\` map and \`place\``,
          "Put each view's pose in its `views` entry and delete `place`. `build()` makes the piece as it prints — that is what exports.",
          `parts.${name}.place`,
          "views-and-place"));
      }
      return out;
    },
  },
  {
    id: "view-pose-not-rigid",
    run: ({ part, p, d }) => {
      const out = [];
      for (const [name, sp] of Object.entries(isPlainObject(part?.parts) ? part.parts : {})) {
        if (!isViewsMap(sp?.views)) continue;
        for (const [view, entry] of Object.entries(sp.views)) {
          if (typeof entry !== "function") continue;
          const probe = probePlace(sp, { view, purpose: "display", p, d });
          if (!readable(probe) || probe.baseHash === CANONICAL) continue;
          out.push(err("view-pose-not-rigid",
            `sub-part "${name}"'s pose for view "${view}" reshapes the piece`,
            "A view's pose may only translate or rotate its argument — no `scale`, `mirror` or boolean. Bake a resized or reflected form into `build()` so every view shows the same physical piece.",
            `parts.${name}.views.${view}`,
            "view-pose-not-rigid"));
          break; // one finding per sub-part
        }
      }
      return out;
    },
  },
];
