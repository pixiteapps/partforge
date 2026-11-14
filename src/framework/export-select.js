// Pure selection helpers for headless export. No kernel, no DOM.

export function partLabel(part, name) {
  return part.parts[name]?.label ?? name;
}

// The union of sub-parts eligible for export, independent of the active view:
// exportable (not exportable:false) AND enabled under the current params.
export function exportablePartNames(part, params) {
  return Object.keys(part.parts).filter((name) => {
    const sp = part.parts[name];
    if (sp.exportable === false) return false;
    return sp.enabled ? !!sp.enabled(params) : true;
  });
}

// The names a caller asked for, kept only while exportable and enabled, in definition
// order — an export's selection when it names its parts (a headless exportParts, a kit
// section). A name that is gone, disabled or not exportable is dropped.
export function selectExportable(part, params, names) {
  return exportablePartNames(part, params).filter((name) => names.includes(name));
}
