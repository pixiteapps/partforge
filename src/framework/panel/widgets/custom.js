// A part-authored widget in the rail. Filled in by the custom-control task.
export function makeCustom(node) {
  const el = document.createElement("div");
  el.className = "pf-custom";
  return { el, sync: () => {}, keys: [node.key] };
}
