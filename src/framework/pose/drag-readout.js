// Pose mode's live drag readout: while any handle is dragged — a generic one (`on` /
// `point`), or a limb's angles or goal handle (its dot, a joint ring, an aim ring) — its
// readout values — each named by its control's label and unit, as handle-guides'
// readoutItems gives them, and for a limb drag out of reach an "Out of reach" item in mm —
// show in the viewbar's readout slot (viewbar-clear.js's
// createViewbarReadout), the pill measure mode's X/Y/Z parts use: same spot, same look, and
// the view cube steps up to clear it the same way. It updates every drag frame
// (pose-mode's onReadout) and goes away when the drag ends; for a generic handle the
// values chip by the handle (readout-chip.js) takes over from there. The scene draws no text. Display only: no focus, no pointer.
//
// A sibling of pose-controls.js: DOM chrome only, no three.js; pose-mode owns behaviour.
// A no-op without a #viewbar (the slot floats off the bar).
import { createViewbarReadout } from "../viewbar-clear.js";

const noop = () => {};

/**
 * @param mode a pose mode: onReadout.
 * @param elements `{ viewbar }` — the bar the slot floats off.
 */
export function attachDragReadout(mode, { viewbar } = {}) {
  if (!viewbar) return { detach: noop, text: () => null };
  const box = createViewbarReadout("div", "pf-pose-readout");
  viewbar.append(box);

  let key = "";
  function show(r) {
    const items = r?.items ?? [];
    const next = items.map((i) => `${i.label}|${i.text}|${i.unit ?? ""}`).join(",");
    if (next === key) return;
    key = next;
    box.replaceChildren(...items.map((i) => {
      const span = document.createElement("span");
      span.className = "pf-pose-readout-item";
      span.dataset.key = i.key;
      const label = document.createElement("span");
      label.className = "pf-pose-readout-label";
      label.textContent = i.label;
      span.append(label, ` ${i.text}${i.unit ? ` ${i.unit}` : ""}`);
      return span;
    }));
    box.hidden = items.length === 0;
  }
  const off = mode.onReadout?.(show) ?? noop;
  show(mode.getReadout?.() ?? null);

  let detached = false;
  return {
    /** What the slot shows now (its text), or null while hidden. For tests and the browser check. */
    text: () => (box.hidden ? null : box.textContent),
    detach() {
      if (detached) return;
      detached = true;
      off();
      box.remove();
    },
  };
}
