// Group 1 — definition shape and view wiring. This group is the shared replacement
// for partforge-cloud's hand-rolled sandbox validate(), which checks meta.title,
// defaults and build but not `views`, and had already drifted from the eval runner's
// separate views check. One source of truth ends that split.
import { err, warn } from "./finding.js";

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const partEntries = (part) => (isPlainObject(part?.parts) ? Object.entries(part.parts) : []);

export const SHAPE_RULES = [
  {
    id: "missing-meta-title",
    run: ({ part }) => (typeof part?.meta?.title === "string" && part.meta.title.length > 0 ? [] : [
      err("missing-meta-title", "the part has no `meta.title`",
        "Add a `meta` object with a `title` string — it names the part in the viewer and in export filenames.",
        "meta.title"),
    ]),
  },
  {
    id: "missing-defaults",
    run: ({ part }) => (isPlainObject(part?.defaults) ? [] : [
      err("missing-defaults", "the part has no `defaults` object",
        "Add a `defaults` object giving every parameter its starting value; the control panel and every build read from it.",
        "defaults"),
    ]),
  },
  {
    id: "no-buildable-parts",
    run: ({ part }) => {
      const entries = partEntries(part);
      if (entries.length === 0) {
        return [err("no-buildable-parts", "the part declares no sub-parts in `parts`",
          "Add at least one entry to `parts`, each with a `build(k, p, d)` function returning a solid.",
          "parts")];
      }
      return entries
        .filter(([, sp]) => typeof sp?.build !== "function")
        .map(([name]) => err("no-buildable-parts", `sub-part "${name}" has no \`build\` function`,
          "Every entry in `parts` needs a `build(k, p, d)` function that returns a solid.",
          `parts.${name}.build`));
    },
  },
  {
    // `probes` is optional; when present it must be an object of (k, p, d)
    // functions — same contract as build, but the result lands in the measure
    // report instead of the scene (see AUTHORING-PARTS.md "Probes").
    id: "invalid-probes",
    run: ({ part }) => {
      if (part?.probes === undefined) return [];
      if (!isPlainObject(part.probes)) {
        return [err("invalid-probes", "`probes` must be an object mapping names to functions",
          "Declare probes as `probes: { name: (k, p, d) => Solid | Shape2D | plain JSON }` — each is measured into the report by `partforge measure` and the inspect job.",
          "probes")];
      }
      return Object.entries(part.probes)
        .filter(([, fn]) => typeof fn !== "function")
        .map(([name]) => err("invalid-probes", `probe "${name}" is not a function`,
          "Every entry in `probes` must be a `(k, p, d)` function returning a Solid (measured into facts), a Shape2D (summarised into its arcs and corners), or plain JSON (reported verbatim).",
          `probes.${name}`));
    },
  },
  {
    id: "missing-views",
    run: ({ part }) => (isPlainObject(part?.views) && Object.keys(part.views).length > 0 ? [] : [
      err("missing-views", "the part has no `views` map",
        "Add a top-level `views` object — e.g. `views: { main: { label: \"Main\" } }` — and list each view name in the owning sub-part's `views` array.",
        "views"),
    ]),
  },
  {
    id: "part-view-unknown",
    run: ({ part }) => {
      const known = isPlainObject(part?.views) ? new Set(Object.keys(part.views)) : new Set();
      if (known.size === 0) return []; // missing-views already reported it; don't pile on
      const out = [];
      for (const [name, sp] of partEntries(part)) {
        if (!Array.isArray(sp?.views)) continue;
        sp.views.forEach((v, i) => {
          if (!known.has(v)) {
            out.push(err("part-view-unknown",
              `sub-part "${name}" lists view "${v}", which is not in the \`views\` map`,
              `Add "${v}" to the top-level \`views\` map, or correct the name to one of: ${[...known].join(", ")}.`,
              `parts.${name}.views[${i}]`));
          }
        });
      }
      return out;
    },
  },
  {
    id: "view-unused",
    run: ({ part }) => {
      if (!isPlainObject(part?.views)) return [];
      const used = new Set();
      for (const [, sp] of partEntries(part)) {
        if (Array.isArray(sp?.views)) for (const v of sp.views) used.add(v);
      }
      return Object.keys(part.views)
        .filter((v) => !used.has(v))
        .map((v) => warn("view-unused", `view "${v}" is not listed by any sub-part`,
          `Either add "${v}" to a sub-part's \`views\` array or remove it from the \`views\` map — as it stands the view renders empty.`,
          `views.${v}`));
    },
  },
  {
    id: "default-view-ambiguous",
    run: ({ part }) => {
      if (!isPlainObject(part?.views)) return [];
      const flagged = Object.keys(part.views).filter((v) => part.views[v]?.default === true);
      if (flagged.length < 2) return [];
      return [warn("default-view-ambiguous",
        `${flagged.length} views set \`default: true\`: ${flagged.map((v) => `"${v}"`).join(", ")}`,
        `Only one view can open by default. The viewer takes the first one declared — "${flagged[0]}" — and ignores the rest; remove \`default: true\` from the others.`,
        `views.${flagged[1]}.default`)];
    },
  },
];
