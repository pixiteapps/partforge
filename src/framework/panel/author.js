// The NEW authored parameter-schema shape — a section (or nested group) whose
// children live in a `controls: []` array — normalized to canonical nodes.
// This file is author.js's mirror of legacy.js: legacy.js is the only code that
// knows the OLD shapes, this is the only code that knows the new one. Hidden
// nodes are RETAINED (lint needs them; buildTree drops them).
//
// No bare imports: partforge/lint consumes this through desugar() and
// test/lint-purity.test.js requires a dependency-free closure.

const arr = (x) => (Array.isArray(x) ? x : []);

// Uniform rule for the new shape: every control marks Custom. The legacy
// exemptions (feature sliders, toggles) encoded legacy-renderer history, not a
// design principle — preset application still goes through raw syncs, so
// applying a preset never marks itself Custom.
function authoredControl(c) {
  return {
    kind: "control",
    key: c.key,
    type: c.type ?? "slider",
    label: c.label,
    description: c.description,
    unit: c.unit,
    min: c.min,
    max: c.max,
    step: c.step,
    on: c.type === "checkbox" ? (c.on ?? 1) : c.on,
    options: c.options,
    scale: c.scale,
    ticks: c.ticks,
    snap: c.snap,
    recommended: c.recommended,
    hidden: !!c.hidden,
    when: c.when,
    whenFalse: c.whenFalse,
    // Asset-control fields. This list is an explicit allow-list, so anything
    // missing from it is silently dropped rather than failing loudly — which is
    // how `allow` came to be ignored: an authored `allow: ["asset"]` never
    // reached the widget, so its own typed-URL check fell back to the default
    // list and accepted values the worker then refused and reset underneath the
    // user. The worker-side gate was never affected (imageControlAllows and its
    // siblings walk the raw authored tree, not this node), so the enforcement
    // held throughout — but the panel disagreed with it.
    allow: c.allow,
    preview: c.preview,
    sourceField: c.sourceField,
    // Custom controls (type: "custom"): the author's widget function and the
    // extra scalar keys it may write. Both are on this allow-list for the same
    // reason `allow` is (see above) — a field missing here is silently dropped.
    widget: c.widget,
    keys: c.keys,
    preserveOn: false,
    marksCustom: true,
  };
}

function authoredPreset(p) {
  const names = p.presets ? Object.keys(p.presets) : [];
  if (!names.length) return null; // a picker with only "Custom" in it is useless
  return {
    kind: "preset", id: p.id, label: p.label, presets: p.presets,
    hidden: !!p.hidden, when: p.when, whenFalse: p.whenFalse,
  };
}

function authoredGroup(g) {
  // No description on inner groups: the fold toggle is itself a button, so
  // there is nowhere to hang an info glyph. Sections keep theirs.
  return {
    kind: "group", id: g.id, title: g.title,
    collapsed: g.collapsed ?? "auto", bare: !!g.bare, hidden: !!g.hidden,
    when: g.when, whenFalse: g.whenFalse,
    children: authoredChildren(g.controls),
  };
}

function authoredChildren(list) {
  const out = [];
  for (const entry of arr(list)) {
    if (!entry) continue; // lint must be able to walk a broken part
    if (entry.type === "group") out.push(authoredGroup(entry));
    else if (entry.type === "preset") {
      const node = authoredPreset(entry);
      if (node) out.push(node);
    } else if (entry.type === "readout") out.push({
      kind: "display", type: "readout", label: entry.label, description: entry.description,
      unit: entry.unit, derivedKey: entry.derivedKey,
      hidden: !!entry.hidden, when: entry.when, whenFalse: entry.whenFalse,
    });
    else out.push(authoredControl(entry));
  }
  return out;
}

export function authoredSection(sec) {
  return {
    kind: "group", id: sec?.id, title: sec?.title, description: sec?.description,
    collapsed: sec?.collapsed ?? "auto", hidden: !!sec?.hidden,
    when: sec?.when, whenFalse: sec?.whenFalse,
    children: authoredChildren(sec?.controls),
  };
}
// Authored `id` is honored on containers only; a control entry's `id` is
// dropped (positional ids serve) and lint warns on the unknown field.
