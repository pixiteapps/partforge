// Viewbar chrome for measurement mode: the ruler toggle + contextual actions
// ("Clear" while a measurement is on screen, a unit toggle cycling the dimension display
// between millimetres and inches — display only; the rail stays mm). A direct sibling of
// cutaway-controls.js — same no-op-without-button contract, same attribute
// restore discipline on detach. The mode object (measure-mode.js) owns all
// behavior; this file only puts it on screen.
import { attachButtonTooltips } from "../tooltip.js";
import { runCleanupSteps, captureAttributes, restoreAttributes } from "../teardown.js";

const BUTTON_ATTRIBUTES = ["type", "aria-pressed", "aria-label", "title", "disabled"];
const RULER_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.3 8.7 8.7 21.3c-.4.4-1 .4-1.4 0l-4.6-4.6c-.4-.4-.4-1 0-1.4L15.3 2.7c.4-.4 1-.4 1.4 0l4.6 4.6c.4.4.4 1 0 1.4Z"/><path d="m7.5 10.5 2 2"/><path d="m10.5 7.5 2 2"/><path d="m13.5 4.5 2 2"/><path d="m4.5 13.5 2 2"/></svg>`;

const noop = () => {};

// escapeScope: when a host places cutaway's Flip/Reset/etc. buttons as
// canvas SIBLINGS in a shared #viewbar (not descendants of the canvas),
// attaching Escape to viewer.domElement alone leaves those buttons dead —
// nothing containing them ever sees the keydown. Attaching to a shared
// ancestor instead (mount.js passes the whole viewer stage) lets it bubble
// from canvas and viewbar buttons alike.
export function attachMeasureControls(viewer, mode, { measure: button } = {}, { tooltip, escapeScope } = {}) {
  if (!button) return { detach: noop };

  const hostAttributes = captureAttributes(button, BUTTON_ATTRIBUTES);
  const hostHtml = button.innerHTML;
  const hostOn = button.classList.contains("on");

  button.type = "button";
  button.innerHTML = RULER_ICON;
  button.setAttribute("aria-pressed", "false");
  if (!tooltip && !button.hasAttribute("title")) button.title = "Toggle measurements";

  const actions = document.createElement("span");
  actions.className = "pf-measure-actions";
  const clearButton = document.createElement("button");
  clearButton.type = "button";
  clearButton.textContent = "Clear";
  clearButton.title = "Clear the measurement";
  clearButton.setAttribute("aria-label", "Clear the measurement");
  const unitButton = document.createElement("button");
  unitButton.type = "button";
  unitButton.className = "pf-measure-unit";
  actions.append(clearButton, unitButton);
  button.after(actions);

  const tooltipBinding = tooltip
    ? attachButtonTooltips(tooltip, [button, clearButton, unitButton].map((element) => ({ element })))
    : null;

  function sync() {
    const on = mode.isEnabled();
    button.setAttribute("aria-pressed", String(on));
    button.setAttribute("aria-label", on ? "Hide measurements" : "Show measurements");
    button.classList.toggle("on", on);
    actions.hidden = !on;
    clearButton.hidden = mode.pinCount() === 0;
    const u = mode.getUnits?.() ?? "mm";
    unitButton.textContent = u;
    const unitLabel = u === "mm" ? "Show measurements in inches" : "Show measurements in millimetres";
    unitButton.setAttribute("aria-label", unitLabel);
    if (!tooltip) unitButton.title = unitLabel;
    tooltipBinding?.sync();
  }

  const onToggle = () => { mode.setEnabled(!mode.isEnabled()); sync(); };
  const onClear = () => { mode.clearPins(); sync(); };
  const onUnit = () => { mode.setUnits?.(mode.getUnits?.() === "mm" ? "in" : "mm"); sync(); };
  const onEscape = (event) => {
    if (event.key !== "Escape" || !mode.isEnabled()) return;
    event.preventDefault();
    // Consume the keystroke: with measure attached first, cutaway's listener
    // on the same element would otherwise read the guard AFTER we've disabled
    // and close too. Order-independent together with cutaway's escapeGuard
    // (which covers the cutaway-attached-first order).
    event.stopImmediatePropagation();
    mode.setEnabled(false);
    sync();
    tooltipBinding?.hide();
  };
  const offPins = mode.onPinsChange(sync);
  const offMode = mode.onModeChange(sync);

  button.addEventListener("click", onToggle);
  clearButton.addEventListener("click", onClear);
  unitButton.addEventListener("click", onUnit);
  const escapeTargets = [escapeScope ?? viewer.domElement, button, clearButton, unitButton];
  for (const element of escapeTargets) element.addEventListener("keydown", onEscape);
  sync();

  let detached = false;
  return {
    detach() {
      if (detached) return;
      detached = true;
      runCleanupSteps([
        offPins,
        offMode,
        () => button.removeEventListener("click", onToggle),
        () => clearButton.removeEventListener("click", onClear),
        () => unitButton.removeEventListener("click", onUnit),
        ...escapeTargets.map((element) => () => element.removeEventListener("keydown", onEscape)),
        () => tooltipBinding?.detach(),
        () => actions.remove(),
        () => restoreAttributes(button, hostAttributes),
        () => { button.innerHTML = hostHtml; },
        () => button.classList.toggle("on", hostOn),
      ], "measure control cleanup failed");
    },
  };
}
