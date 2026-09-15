// Group 2 — the parameter schema that src/framework/controls.js turns into the panel.
// Two failure modes drive this group: a shape controls.js reads without guarding
// (features[].sliders at controls.js:313, an unguarded .filter), and keys that don't
// resolve against `defaults`, which produce a control that silently does nothing.
import { err, warn } from "./finding.js";
import { suggest } from "../geometry/op-options.js";
import { jsonValueProblem } from "../panel/json-value.js";
import { fieldsFor, authorFieldsFor, WIDGET_TYPES, GROUP_FIELDS, PRESET_FIELDS, SECTION_FIELDS, normalizeOptions } from "../panel/widget-specs.js";
import { sectionRenders, desugar } from "../panel/legacy.js";
import { buildTree, WHEN_OPS } from "../panel/model.js";
import { resolveDerived } from "../derive.js";

export const SECTION_CONTROL_BUDGET = 12;

// Legacy container descriptors aren't widget types, so they keep explicit lists.
const FEATURE_FIELDS = ["key", "label", "on", "sliders", "hidden", "description"];

const sections = (part) => (Array.isArray(part?.parameters) ? part.parameters : []);
const arr = (x) => (Array.isArray(x) ? x : []);
const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

// Every (descriptor, path, allowed-fields) triple that owns a parameter key, across
// all four section kinds. A feature's own `sliders` are collected too, since each
// slider is a full control descriptor in its own right.
// Each record also carries `inHidden`: whether a STATICALLY hidden container
// (a section, group or feature written `hidden: true`) encloses the descriptor.
// It is read only by controlBoundKeys({ excludeHidden }); every other rule
// ignores it, so their populations are unchanged. `when` is deliberately not
// hiddenness — a `when`-conditioned node can still appear.
function collectDescriptors(part) {
  const out = [];
  sections(part).forEach((sec, si) => {
    const secHidden = sec?.hidden === true;
    // The authored shape: children in `controls`, recursively. Field lists are
    // the authored ones (authorFieldsFor) — the legacy lists stay untouched so
    // `when` on a legacy descriptor still warns. A section routes to one shape
    // or the other (desugar's winner-takes-all), so `return` before the legacy
    // loops below rather than falling through to them.
    function walkAuthored(list, base, inHidden) {
      arr(list).forEach((entry, i) => {
        if (!entry) return;
        const path = `${base}[${i}]`;
        if (entry.type === "group") {
          out.push({ d: entry, path, fields: GROUP_FIELDS, container: true, authored: true, inHidden });
          walkAuthored(entry.controls, `${path}.controls`, inHidden || entry.hidden === true);
        } else if (entry.type === "preset") {
          out.push({ d: entry, path, fields: PRESET_FIELDS, container: true, authored: true, inHidden });
        } else {
          // A typo'd type (e.g. "grup") fails both branches above and lands
          // here — authorFieldsFor falls back to AUTHOR_COMMON, and
          // unknown-control-type (below) is what actually diagnoses it.
          out.push({ d: entry, path, fields: authorFieldsFor(entry.type ?? "slider"), authored: true, inHidden });
        }
      });
    }
    if (Array.isArray(sec?.controls)) {
      // The section itself is a descriptor too, but only worth collecting when
      // it carries a `when` — a section becomes a descriptor at all only in
      // that case (a deliberate scope choice), and pushing every section
      // unconditionally would produce findings with nothing to say. `when`-only
      // rules just need it present when relevant.
      if (sec?.when !== undefined) out.push({ d: sec, path: `parameters[${si}]`, fields: SECTION_FIELDS, container: true, inHidden: secHidden });
      walkAuthored(sec.controls, `parameters[${si}].controls`, secHidden);
      return;
    }

    arr(sec?.advanced).forEach((d, i) => {
      if (d) out.push({ d, path: `parameters[${si}].advanced[${i}]`, fields: fieldsFor("slider"), inHidden: secHidden });
    });
    arr(sec?.features).forEach((f, i) => {
      if (!f) return;
      out.push({ d: f, path: `parameters[${si}].features[${i}]`, fields: FEATURE_FIELDS, inHidden: secHidden });
      arr(f.sliders).forEach((s, j) => {
        // Tag with the owning feature's key so slider-range-excludes-default can
        // recognise the demo.js flange_d pattern below: a slider sharing its key
        // with the feature is not an independent parameter, it's the feature's own
        // magnitude, and `defaults[key] === 0` there means "off", not "out of range".
        if (s) out.push({ d: s, path: `parameters[${si}].features[${i}].sliders[${j}]`, fields: fieldsFor("slider"), featureKey: f.key, inHidden: secHidden || f.hidden === true });
      });
    });
    arr(sec?.toggles).forEach((t, i) => {
      if (t) out.push({ d: t, path: `parameters[${si}].toggles[${i}]`, fields: fieldsFor("checkbox"), inHidden: secHidden });
    });
  });
  return out;
}

// Every preset bundle with its source path — the legacy `presets:` field and
// authored `{ type: "preset" }` nodes both count.
function collectPresetBundles(part) {
  const out = [];
  sections(part).forEach((sec, si) => {
    if (isPlainObject(sec?.presets) && !Array.isArray(sec?.controls)) {
      for (const [name, bundle] of Object.entries(sec.presets)) {
        out.push({ name, bundle, path: `parameters[${si}].presets` });
      }
    }
    const walk = (list, base) => arr(list).forEach((entry, i) => {
      if (!entry) return;
      if (entry.type === "group") walk(entry.controls, `${base}[${i}].controls`);
      else if (entry.type === "preset" && isPlainObject(entry.presets)) {
        for (const [name, bundle] of Object.entries(entry.presets)) {
          out.push({ name, bundle, path: `${base}[${i}].presets` });
        }
      }
    });
    walk(sec?.controls, `parameters[${si}].controls`);
  });
  return out;
}

const defaultKeys = (part) => new Set(Object.keys(part?.defaults ?? {}));

// The keys a real control is bound to — the population whose defaults must be
// panel-writable. Shared with rules-source.js's control-default-not-literal,
// which needs the SAME key set control-default-not-primitive uses (unbound
// non-primitive defaults are legal: they seed `p` for build()).
//
// `excludeHidden` drops descriptors a STATICALLY hidden container encloses, and
// those written `hidden: true` themselves. Only the source rule wants it: a
// hidden control renders no widget, so no panel edit of it can ever be lost,
// and `hidden: true` is the documented idiom for an internal constant — exactly
// where an author legitimately writes an expression. `control-default-not-primitive`
// leaves it off, because a hidden control's key still seeds `p` and so still
// has to be a scalar.
export function controlBoundKeys(part, { excludeHidden = false } = {}) {
  return new Set(
    collectDescriptors(part)
      .filter(({ container }) => !container)
      .filter(({ d, inHidden }) => !excludeHidden || !(inHidden === true || d.hidden === true))
      .map(({ d }) => d.key)
      .filter((k) => typeof k === "string"),
  );
}

// What a control can actually edit: one finite scalar. Non-finite numbers are out
// with the rest — a slider cannot show NaN, and neither NaN nor Infinity survives
// a round trip through JSON or a source rewrite.
const isEditableValue = (v) =>
  typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));

// Name a value for a finding's message: the reader needs to know WHICH default is
// wrong and what it is, and `typeof []` ("object") tells them neither.
const describeValue = (v) => {
  if (Array.isArray(v)) return "an array";
  if (v === null) return "a null";
  if (typeof v === "number") return `a ${Number.isNaN(v) ? "NaN" : String(v)}`;
  if (v === undefined) return "an undefined";
  return `a ${typeof v}`;
};

// Walk one WhenCondition, calling onKey(key) for every param key it reads and
// onOp(op) for every operator name it uses. allOf/anyOf/not recurse; a bare
// `{ key: value }` entry counts as reading `key` with no operator to check.
function walkWhen(cond, onKey, onOp) {
  if (cond === null || typeof cond !== "object" || Array.isArray(cond)) return;
  for (const [key, want] of Object.entries(cond)) {
    if (key === "allOf" || key === "anyOf") {
      for (const c of Array.isArray(want) ? want : []) walkWhen(c, onKey, onOp);
    } else if (key === "not") {
      walkWhen(want, onKey, onOp);
    } else {
      onKey(key);
      if (want !== null && typeof want === "object" && !Array.isArray(want)) {
        for (const op of Object.keys(want)) onOp(op);
      }
    }
  }
}

// These used to be hand-copied from controls.js, because importing it would have
// dragged `marked`/`dompurify` into partforge/lint and broken its zero-dependency
// guarantee. panel/legacy.js imports nothing, so lint can share the real
// implementation and the two can no longer drift.

export const SCHEMA_RULES = [
  {
    id: "features-requires-sliders",
    run: ({ part }) => {
      const out = [];
      sections(part).forEach((sec, si) => {
        // A feature the panel will never reach can't crash it: skip the whole
        // section when it never renders at all (sectionRenders), and skip any
        // individual feature the panel skips via `hidden: true` (visibleFeatures'
        // own filter condition, restated inline rather than built into a Set).
        if (!sectionRenders(sec)) return;
        arr(sec?.features).forEach((f, i) => {
          if (f && !f.hidden && !Array.isArray(f.sliders)) {
            out.push(err("features-requires-sliders",
              `section "${sec.id ?? si}" feature ${i} has no \`sliders\` array`,
              "A `features` entry must carry a `sliders` array — the control panel reads it unguarded, so a missing one throws \"Cannot read properties of undefined (reading 'filter')\". A bare on/off control belongs in `toggles` instead.",
              `parameters[${si}].features[${i}]`,
              "features-missing-sliders"));
          }
        });
      });
      return out;
    },
  },
  {
    id: "features-requires-on",
    run: ({ part }) => {
      const out = [];
      sections(part).forEach((sec, si) => {
        if (!sectionRenders(sec)) return;
        arr(sec?.features).forEach((f, i) => {
          // The panel treats "enabled" as `params[key] > 0`, so `on` has to be a
          // positive number: a missing one writes undefined (NaN in the build),
          // and 0 or a negative writes a value the panel reads straight back as
          // "still off", leaving a checkbox that won't stay ticked.
          if (f && !f.hidden && !(typeof f.on === "number" && f.on > 0)) {
            out.push(err("features-requires-on",
              `section "${sec.id ?? si}" feature ${i}${f.key ? ` ("${f.key}")` : ""} has no positive numeric \`on\` value`,
              "Ticking a feature's checkbox writes `on` into the feature's own parameter, so a missing one writes `undefined` and the build reads it as NaN. Unlike a `toggles` entry — a plain flag that falls back to 1 — a feature's `on` is the real value the parameter takes when enabled (a diameter, a count), so there is no safe default to guess. It must be greater than 0, because the panel reads `> 0` as \"enabled\". Give the feature the value it should switch on to.",
              `parameters[${si}].features[${i}]`));
          }
        });
      });
      return out;
    },
  },
  {
    id: "control-key-not-in-defaults",
    run: ({ part }) => {
      // Only skip when `defaults` isn't a plain object at all (missing-defaults
      // already reports that) — an explicit `defaults: {}` must still be checked,
      // otherwise every control key in the part is silently unreachable and dead.
      if (!isPlainObject(part?.defaults)) return [];
      const known = defaultKeys(part);
      return collectDescriptors(part)
        .filter(({ container }) => !container)
        .filter(({ d }) => typeof d.key === "string" && !known.has(d.key))
        .map(({ d, path }) => err("control-key-not-in-defaults",
          `control key "${d.key}" is not in \`defaults\``,
          `Add "${d.key}" to \`defaults\`${suggest(d.key, [...known]) ? `, or correct it to "${suggest(d.key, [...known])}"` : ""} — a control whose key is absent from defaults is silently dead and never reaches the build.`,
          `${path}.key`));
    },
  },
  {
    // A control edits ONE value, and the widgets read and write it as a scalar:
    // a slider over an array renders NaN, a checkbox over an object writes
    // `true` over it. It is dead in the same silent way control-key-not-in-defaults
    // is — the part builds, the panel renders, the control does nothing usable —
    // which is why this is an error rather than a warning.
    //
    // Only a key a CONTROL is bound to. `defaults` also seeds `p` for build(), so
    // parking a table or a point list there for the build to read is legitimate
    // authoring and none of lint's business.
    id: "control-default-not-primitive",
    run: ({ part }) => {
      // Same guard as control-key-not-in-defaults: bail only when `defaults`
      // isn't a plain object at all (missing-defaults already reports that).
      if (!isPlainObject(part?.defaults)) return [];
      const defaults = part.defaults;
      return collectDescriptors(part)
        .filter(({ container }) => !container)
        // A custom control's OWN key may hold a JSON value; custom-default-not-json
        // (below) is its rule. Its `keys` stay under this one via their own controls.
        .filter(({ d }) => d.type !== "custom")
        .filter(({ d }) => typeof d.key === "string" && Object.hasOwn(defaults, d.key))
        .filter(({ d }) => !isEditableValue(defaults[d.key]))
        .map(({ d, path }) => err("control-default-not-primitive",
          `control "${d.key}" is bound to ${describeValue(defaults[d.key])} default`,
          `Give "${d.key}" a number, string or boolean default — a control writes one scalar, so it cannot edit this, and a host that saves panel settings back into \`defaults\` cannot write it either.`,
          `${path}.key`));
    },
  },
  {
    id: "preset-key-not-in-defaults",
    run: ({ part }) => {
      // Same guard as control-key-not-in-defaults: only bail when `defaults` is
      // entirely absent (or not an object), not merely empty.
      if (!isPlainObject(part?.defaults)) return [];
      const known = defaultKeys(part);
      const out = [];
      for (const { name, bundle, path } of collectPresetBundles(part)) {
        if (!bundle || typeof bundle !== "object") continue;
        for (const key of Object.keys(bundle)) {
          if (known.has(key)) continue;
          const hint = suggest(key, [...known]);
          out.push(err("preset-key-not-in-defaults",
            `preset "${name}" sets "${key}", which is not in \`defaults\``,
            `Add "${key}" to \`defaults\`${hint ? `, or correct it to "${hint}"` : ""} — a preset field absent from defaults is dropped, so selecting the preset silently does nothing for it.`,
            `${path}[${JSON.stringify(name)}].${key}`));
        }
      }
      return out;
    },
  },
  {
    id: "slider-range-excludes-default",
    run: ({ part }) => {
      const defaults = part?.defaults ?? {};
      return collectDescriptors(part)
        .filter(({ container }) => !container)
        // A slider that shares its key with the feature that owns it (demo.js's
        // flange_d) is exempt ONLY when the default is actually the feature's
        // off-sentinel: controls.js sets `params[feat.key] = 0` on uncheck (and
        // reads `params[feat.key] > 0` to decide checked state), so `0` there means
        // "off", not "out of range". Matching keys alone isn't enough — a mistyped
        // non-zero "on" default (e.g. 999 against an 8..50 slider) is exactly the
        // authoring mistake this rule exists to catch, and must still warn.
        .filter(({ d, featureKey }) => !(featureKey !== undefined && featureKey === d.key && defaults[d.key] === 0))
        .filter(({ d }) => typeof d.key === "string"
          && typeof defaults[d.key] === "number"
          && (typeof d.min === "number" || typeof d.max === "number")
          && ((typeof d.min === "number" && defaults[d.key] < d.min)
            || (typeof d.max === "number" && defaults[d.key] > d.max)))
        .map(({ d, path }) => warn("slider-range-excludes-default",
          `\`defaults.${d.key}\` is ${defaults[d.key]}, outside this control's range ${d.min ?? "-∞"}..${d.max ?? "∞"}`,
          `Widen the control's min/max or move \`defaults.${d.key}\` inside the range — as it stands the panel clamps the value on first render, so the geometry the user sees is not the geometry the defaults describe.`,
          path));
    },
  },
  {
    id: "unknown-control-field",
    run: ({ part }) => {
      const out = [];
      for (const { d, path, fields } of collectDescriptors(part)) {
        for (const key of Object.keys(d)) {
          if (fields.includes(key)) continue;
          const hint = suggest(key, fields);
          out.push(warn("unknown-control-field",
            `unrecognised control field "${key}"`,
            `The control panel ignores "${key}"${hint ? ` — did you mean "${hint}"?` : ` (recognised: ${fields.join(", ")}).`}`,
            `${path}.${key}`));
        }
      }
      return out;
    },
  },
  {
    id: "unknown-control-type",
    run: ({ part }) => collectDescriptors(part)
      .filter(({ container, authored, d }) => authored && !container && typeof d.type === "string" && !WIDGET_TYPES.includes(d.type))
      .map(({ d, path }) => {
        const hint = suggest(d.type, WIDGET_TYPES);
        return err("unknown-control-type",
          `unrecognised control type "${d.type}"`,
          `${hint ? `Did you mean "${hint}"? ` : ""}Recognised types: ${WIDGET_TYPES.join(", ")}.`,
          `${path}.type`);
      }),
  },
  {
    id: "duplicate-control-key",
    run: ({ part }) => {
      const seen = new Map();
      const out = [];
      for (const { d, path, container } of collectDescriptors(part)) {
        if (container) continue;
        if (typeof d.key !== "string") continue;
        // A feature and its own slider legitimately share a key (see demo.js's
        // flange_d), so only flag a repeat that crosses to a different owner path.
        const root = path.replace(/\.sliders\[\d+\]$/, "");
        if (seen.has(d.key) && seen.get(d.key) !== root) {
          out.push(warn("duplicate-control-key",
            `parameter key "${d.key}" is owned by more than one control`,
            `Two controls writing "${d.key}" fight over the same value — rename one, or remove the duplicate.`,
            path));
        } else if (!seen.has(d.key)) {
          seen.set(d.key, root);
        }
      }
      return out;
    },
  },
  {
    id: "default-not-exposed",
    run: ({ part }) => {
      if (sections(part).length === 0) return []; // no panel declared at all — nothing to expose
      const exposed = new Set(collectDescriptors(part).map(({ d }) => d.key).filter(Boolean));
      for (const { bundle } of collectPresetBundles(part)) {
        for (const key of Object.keys(bundle ?? {})) exposed.add(key);
      }
      return Object.keys(part?.defaults ?? {})
        .filter((key) => !exposed.has(key))
        .map((key) => warn("default-not-exposed",
          `\`defaults.${key}\` is not referenced by any control`,
          `Either add a control for "${key}" or leave it as an intentional internal constant — a hidden control (\`hidden: true\`) counts as exposing it, and is the documented way to keep a build-only value out of the panel.`,
          `defaults.${key}`));
    },
  },
  {
    id: "mixed-section-shape",
    run: ({ part }) => {
      const out = [];
      sections(part).forEach((sec, si) => {
        if (!Array.isArray(sec?.controls)) return;
        const legacy = ["advanced", "toggles", "features", "presets"].filter((k) => sec[k] != null);
        if (legacy.length) {
          out.push(err("mixed-section-shape",
            `section "${sec.id ?? si}" mixes \`controls\` with legacy ${legacy.map((k) => `\`${k}\``).join(", ")}`,
            "A section is either the new shape (everything in `controls`) or the legacy shape — mixing them would make the render order arbitrary. Move the legacy entries into `controls` (a toggle becomes a checkbox control, `advanced` becomes a nested group, `presets` becomes a `{ type: \"preset\" }` node), or drop `controls`.",
            `parameters[${si}]`));
        }
      });
      return out;
    },
  },
  {
    id: "duplicate-preset-name",
    run: ({ part }) => {
      const seen = new Map(); // name -> first path
      const out = [];
      for (const { name, path } of collectPresetBundles(part)) {
        if (seen.has(name)) {
          out.push(err("duplicate-preset-name",
            `preset "${name}" is declared more than once (first at ${seen.get(name)})`,
            "Preset names are global to the part: verify() expands one case per name and throws on a repeat, which is a worse place to find out. Rename one of them.",
            path));
        } else seen.set(name, path);
      }
      return out;
    },
  },
  {
    id: "select-options-missing",
    run: ({ part }) => collectDescriptors(part)
      .filter(({ d, container }) => !container && (d.type === "select" || d.type === "radio"))
      .filter(({ d }) => normalizeOptions(d.options).length === 0)
      .map(({ d, path }) => err("select-options-missing",
        `${d.type} "${d.key}" has no options`,
        "A `select` or `radio` needs an `options` array — either strings/numbers (value doubles as label) or `{ value, label }` objects. With none, the control renders empty and the parameter can never change.",
        `${path}.options`)),
  },
  {
    id: "select-default-not-in-options",
    run: ({ part }) => {
      if (!isPlainObject(part?.defaults)) return [];
      return collectDescriptors(part)
        .filter(({ d, container }) => !container && (d.type === "select" || d.type === "radio"))
        .filter(({ d }) => {
          const opts = normalizeOptions(d.options);
          return opts.length > 0 && typeof d.key === "string" && d.key in part.defaults
            && !opts.some((o) => o.value === part.defaults[d.key]);
        })
        .map(({ d, path }) => err("select-default-not-in-options",
          `\`defaults.${d.key}\` is ${JSON.stringify(part.defaults[d.key])}, which is not one of the ${d.type}'s options`,
          "The default value must be selectable, or the panel opens showing a value the user can never get back to. Add it to `options` or change the default.",
          `${path}.options`));
    },
  },
  {
    id: "duplicate-node-id",
    run: ({ part }) => {
      // Ids key the renderer's element/state/disclosure maps — a collision
      // silently cross-wires two nodes (one picker syncing another section's
      // widgets). Catch it statically: build the tree and look for repeats.
      const canonical = desugar(part?.parameters ?? []);
      // A top-level section's built id is (authored ?? String(canonical index)),
      // so this maps each built section back to its TRUE parameters[] index even
      // after buildTree drops hidden/empty siblings.
      const sourceIndex = new Map();
      canonical.forEach((sec, i) => {
        const key = sec.id ?? String(i);
        if (!sourceIndex.has(key)) sourceIndex.set(key, i);
      });
      const seen = new Map(); // id -> [sectionIndex, ...]
      const tree = buildTree(canonical);
      tree.forEach((section) => {
        const si = sourceIndex.get(section.id) ?? 0;
        const walk = (nodes) => {
          for (const n of nodes ?? []) {
            if (!seen.has(n.id)) seen.set(n.id, []);
            seen.get(n.id).push(si);
            if (n.kind === "group") walk(n.children);
          }
        };
        seen.set(section.id, [...(seen.get(section.id) ?? []), si]);
        walk(section.children);
      });
      return [...seen].filter(([, secs]) => secs.length > 1).map(([id, secs]) =>
        err("duplicate-node-id",
          `two panel nodes share the id "${id}"`,
          "Node ids must be unique across the whole panel — the renderer keys its element and state maps on them, and a collision silently cross-wires the two nodes. Rename one `id` (or drop it to use the positional default).",
          `parameters[${secs[0]}]`));
    },
  },
  {
    id: "readout-unknown-derived-key",
    run: ({ part }) => {
      let derivedKeys = null;
      try { derivedKeys = new Set(Object.keys(resolveDerived(part, { ...part?.defaults }))); }
      catch { return []; } // a throwing derive() is diagnosed elsewhere
      return collectDescriptors(part)
        .filter(({ d, container }) => !container && d.type === "readout")
        .filter(({ d }) => typeof d.derivedKey !== "string" || !derivedKeys.has(d.derivedKey))
        .map(({ d, path }) => warn("readout-unknown-derived-key",
          `readout names derived key "${d.derivedKey}", which derive() does not produce`,
          "A readout displays one output of `derive()`. Name a key a derive group returns, or add that key to `derive` — as it stands the readout shows an em-dash forever.",
          `${path}.derivedKey`));
    },
  },
  {
    id: "log-scale-needs-positive-min",
    run: ({ part }) => collectDescriptors(part)
      .filter(({ d, container }) => !container && d.scale === "log" && !(typeof d.min === "number" && d.min > 0))
      .map(({ d, path }) => err("log-scale-needs-positive-min",
        `"${d.key}" uses scale:"log" with min ${d.min}`,
        "A logarithmic track needs min > 0 — log(0) is -Infinity and the mapping breaks. Raise `min` (e.g. 0.1) or drop `scale`.",
        `${path}.scale`)),
  },
  {
    id: "slider-refinement-invalid",
    run: ({ part }) => {
      const out = [];
      for (const { d, path, container } of collectDescriptors(part)) {
        if (container) continue;
        const numeric = typeof d.min === "number" && typeof d.max === "number";
        if (Array.isArray(d.ticks) && numeric && d.ticks.some((t) => t < d.min || t > d.max)) {
          out.push(warn("slider-refinement-invalid",
            `"${d.key}" has ticks outside its ${d.min}..${d.max} range`,
            "Every tick must sit inside [min, max] — an out-of-range tick renders nowhere and, with snap, drags the value out of range.",
            `${path}.ticks`));
        }
        if (Array.isArray(d.recommended)
            && (d.recommended.length !== 2 || !(d.recommended[0] < d.recommended[1]))) {
          out.push(warn("slider-refinement-invalid",
            `"${d.key}" has a malformed recommended band`,
            "`recommended` is [lo, hi] with lo < hi — the tinted span of the track the DFM checks consider safe.",
            `${path}.recommended`));
        }
        if (d.scale === "log" && (d.ticks || d.recommended)) {
          out.push(warn("slider-refinement-invalid",
            `"${d.key}" combines scale:"log" with ticks/recommended`,
            "Ticks and the recommended band render on a linear track only; on a log slider they are ignored. Drop one or the other.",
            `${path}.scale`));
        }
      }
      return out;
    },
  },
  {
    id: "when-key-not-in-defaults",
    run: ({ part }) => {
      if (!isPlainObject(part?.defaults)) return [];
      const known = defaultKeys(part);
      const out = [];
      for (const { d, path, fields } of collectDescriptors(part)) {
        if (!d.when) continue;
        // A legacy descriptor's `when` isn't a real field (fields wouldn't
        // list it) — controls.js silently drops it as an unknown key
        // (unknown-control-field already says so), so validating its
        // *contents* would imply fixing the key alone makes it work.
        if (!fields.includes("when")) continue;
        walkWhen(d.when, (key) => {
          if (!known.has(key)) {
            const hint = suggest(key, [...known]);
            out.push(err("when-key-not-in-defaults",
              `\`when\` references "${key}", which is not in \`defaults\``,
              `Conditions read raw parameter keys only${hint ? ` — did you mean "${hint}"?` : "."} A key defaults doesn't have always reads undefined, so the condition is always false and the node never shows.`,
              `${path}.when`));
          }
        }, () => {});
      }
      return out;
    },
  },
  {
    id: "when-unknown-operator",
    run: ({ part }) => {
      const ops = Object.keys(WHEN_OPS);
      const out = [];
      for (const { d, path, fields } of collectDescriptors(part)) {
        if (!d.when) continue;
        // Same reasoning as when-key-not-in-defaults: a legacy `when` is a
        // dropped unknown field, not a condition to validate.
        if (!fields.includes("when")) continue;
        walkWhen(d.when, () => {}, (op) => {
          if (!ops.includes(op)) {
            const hint = suggest(op, ops);
            out.push(err("when-unknown-operator",
              `\`when\` uses unknown operator "${op}"`,
              `evalWhen treats an unknown operator as false, so the node silently never shows. Recognised: ${ops.join(", ")}${hint ? ` — did you mean "${hint}"?` : "."}`,
              `${path}.when`));
          }
        });
      }
      return out;
    },
  },
  {
    id: "group-depth",
    run: ({ part }) => {
      // Depth counts AUTHORED nesting only, so it needs source paths — walk the
      // raw sections, not the desugared tree (which adds the legacy Advanced
      // group an author never wrote).
      const out = [];
      sections(part).forEach((sec, si) => {
        const walk = (list, base, depth) => arr(list).forEach((entry, i) => {
          if (!entry || entry.type !== "group") return;
          const path = `${base}[${i}]`;
          if (depth >= 2) {
            out.push(warn("group-depth",
              `group "${entry.title ?? i}" is nested ${depth + 1} levels deep`,
              "Two levels (a section, one fold inside it) is as deep as a 300px rail stays readable. Flatten: promote the inner group to its own section, or fold its controls into the parent.",
              path));
          }
          walk(entry.controls, `${path}.controls`, depth + 1);
        });
        walk(sec?.controls, `parameters[${si}].controls`, 1);
      });
      return out;
    },
  },
  {
    id: "section-too-many-controls",
    run: ({ part }) => {
      const out = [];
      const countControls = (nodes) => {
        let n = 0;
        for (const node of nodes ?? []) {
          if (node.hidden) continue;
          if (node.kind === "group") n += countControls(node.children);
          else if (node.kind === "control") n += 1;
        }
        return n;
      };
      desugar(part?.parameters ?? []).forEach((sec, si) => {
        if (sec.hidden) return;
        const n = countControls(sec.children);
        if (n > SECTION_CONTROL_BUDGET) {
          out.push(warn("section-too-many-controls",
            `section "${sec.id ?? si}" shows ${n} controls`,
            `More than ${SECTION_CONTROL_BUDGET} visible controls in one section reads as a wall. Split the section, or hide internals (\`hidden: true\`) — grouping organizes but does not reduce the count.`,
            `parameters[${si}]`));
        }
      });
      return out;
    },
  },
  {
    // The whole feature is the function: a missing or non-function `widget`
    // renders the error card in the rail and nothing else, every time.
    id: "custom-control-widget-not-function",
    run: ({ part }) => collectDescriptors(part)
      .filter(({ container, authored, d }) => authored && !container && d.type === "custom" && typeof d.widget !== "function")
      .map(({ d, path }) => err("custom-control-widget-not-function",
        `custom control "${d.key}" has no \`widget\` function`,
        "Set `widget` to a function `(host) => …` — usually imported from a sibling file of the part — that draws into `host.el`. See \"Custom controls\" in AUTHORING-PARTS.md.",
        `${path}.widget`)),
  },
  {
    // The one relaxation of control-default-not-primitive: a custom control's
    // key may hold a JSON value (json-value.js), and nothing else — a host that
    // persists panel settings writes it back as a JSON literal.
    id: "custom-default-not-json",
    run: ({ part }) => {
      if (!isPlainObject(part?.defaults)) return [];
      const defaults = part.defaults;
      return collectDescriptors(part)
        .filter(({ container, authored, d }) => authored && !container && d.type === "custom")
        .filter(({ d }) => typeof d.key === "string" && Object.hasOwn(defaults, d.key))
        .map(({ d }) => ({ d, problem: jsonValueProblem(defaults[d.key]) }))
        .filter(({ problem }) => problem !== null)
        .map(({ d, problem }) => err("custom-default-not-json",
          `\`defaults.${d.key}\` ${problem}`,
          `Give "${d.key}" a JSON value: numbers, strings, booleans, arrays and plain objects of those, at most 16 KB and 8 levels deep, with no null. A custom control stores and persists its value as JSON, so anything else is silently lost on reload.`,
          `defaults.${d.key}`));
    },
  },
  {
    // `keys` are params the widget writes besides its own; each needs a
    // default or the write lands on a key the build never reads.
    id: "custom-keys-not-in-defaults",
    run: ({ part }) => {
      if (!isPlainObject(part?.defaults)) return [];
      const known = defaultKeys(part);
      const out = [];
      for (const { d, path, container, authored } of collectDescriptors(part)) {
        if (!authored || container || d.type !== "custom" || !Array.isArray(d.keys)) continue;
        d.keys.forEach((k, i) => {
          if (typeof k === "string" && known.has(k)) return;
          const hint = typeof k === "string" ? suggest(k, [...known]) : null;
          out.push(err("custom-keys-not-in-defaults",
            `custom control "${d.key}" lists key "${k}", which is not in \`defaults\``,
            `Add "${k}" to \`defaults\`${hint ? `, or correct it to "${hint}"` : ""} — a key the widget writes must exist for the build to read it.`,
            `${path}.keys[${i}]`));
        });
      }
      return out;
    },
  },
];
