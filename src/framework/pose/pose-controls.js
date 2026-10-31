// Viewbar chrome for Pose mode: the `#pose` toggle plus one contextual action,
// "Release pins", shown while the mode is on and any pin is set. A sibling of
// measure/measure-controls.js — same no-op-without-button contract, same attribute
// restore discipline on detach. The mode object (pose-mode.js) owns all behaviour;
// this file only puts it on screen.
import { attachButtonTooltips } from "../tooltip.js";
import { runCleanupSteps, captureAttributes, restoreAttributes } from "../teardown.js";

const BUTTON_ATTRIBUTES = ["type", "aria-pressed", "aria-label", "title", "disabled"];
// A two-bone limb: a shoulder, an elbow, and a tip dot — the handle you drag.
const POSE_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 19 10 10 18 7"/><circle cx="5" cy="19" r="1.6"/><circle cx="10" cy="10" r="1.6"/><circle cx="18.5" cy="6.5" r="2.6" fill="currentColor" stroke="none"/></svg>`;

const noop = () => {};

/**
 * @param viewer the viewer (its domElement is the default Escape scope).
 * @param mode a pose mode (pose-mode.js): isEnabled, setEnabled, pinCount, releasePins,
 *   onPinsChange, onModeChange.
 * @param elements `{ pose }` — the host's `#pose` button; without one this is a no-op.
 * @param opts `{ tooltip, escapeScope }`, as attachMeasureControls takes them.
 */
export function attachPoseControls(viewer, mode, { pose: button } = {}, { tooltip, escapeScope } = {}) {
  if (!button) return { detach: noop };

  const hostAttributes = captureAttributes(button, BUTTON_ATTRIBUTES);
  const hostHtml = button.innerHTML;
  const hostOn = button.classList.contains("on");

  button.type = "button";
  button.innerHTML = POSE_ICON;
  button.setAttribute("aria-pressed", "false");
  if (!tooltip && !button.hasAttribute("title")) button.title = "Pose";

  const actions = document.createElement("span");
  actions.className = "pf-pose-actions";
  const releaseButton = document.createElement("button");
  releaseButton.type = "button";
  releaseButton.className = "pf-pose-release";
  releaseButton.textContent = "Release pins";
  releaseButton.title = "Release every pinned point";
  releaseButton.setAttribute("aria-label", "Release every pinned point");
  actions.append(releaseButton);
  button.after(actions);

  const tooltipBinding = tooltip
    ? attachButtonTooltips(tooltip, [button, releaseButton].map((element) => ({ element })))
    : null;

  function sync() {
    const on = mode.isEnabled();
    button.setAttribute("aria-pressed", String(on));
    button.setAttribute("aria-label", on ? "Leave pose mode" : "Pose");
    button.classList.toggle("on", on);
    const pinned = mode.pinCount() > 0;
    actions.hidden = !on || !pinned;
    releaseButton.hidden = !pinned;
    tooltipBinding?.sync();
  }

  const onToggle = () => { mode.setEnabled(!mode.isEnabled()); sync(); };
  const onRelease = () => { mode.releasePins(); sync(); };
  // A drag in progress consumes Escape itself (pose-mode's window capture listener
  // reverts it), so this only ever sees an Escape with no drag on: leave the mode.
  const onEscape = (event) => {
    if (event.key !== "Escape" || !mode.isEnabled()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    mode.setEnabled(false);
    sync();
    tooltipBinding?.hide();
  };
  const offPins = mode.onPinsChange(sync);
  const offMode = mode.onModeChange(sync);

  button.addEventListener("click", onToggle);
  releaseButton.addEventListener("click", onRelease);
  const escapeTargets = [escapeScope ?? viewer.domElement, button, releaseButton];
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
        () => releaseButton.removeEventListener("click", onRelease),
        ...escapeTargets.map((element) => () => element.removeEventListener("keydown", onEscape)),
        () => tooltipBinding?.detach(),
        () => actions.remove(),
        () => restoreAttributes(button, hostAttributes),
        () => { button.innerHTML = hostHtml; },
        () => button.classList.toggle("on", hostOn),
      ], "pose control cleanup failed");
    },
  };
}
