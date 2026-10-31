// Viewbar chrome for posing: one contextual action, "Release pins", shown while posing
// is live (no measure, sketch or cutaway on) and any pin is set. There is no toggle:
// posing is always on in the viewer's normal click mode (pose-mode.js). A sibling of
// measure/measure-controls.js in its no-op-without-a-host-element contract. The mode
// object owns all behaviour; this file only puts the action on screen.
import { attachButtonTooltips } from "../tooltip.js";
import { runCleanupSteps } from "../teardown.js";

const noop = () => {};

/**
 * @param viewer the viewer (unused today; kept for the controls' common signature).
 * @param mode a pose mode (pose-mode.js): isLive, pinCount, releasePins, onPinsChange,
 *   onModeChange.
 * @param elements `{ viewbar }` — the host's `#viewbar`; without one this is a no-op.
 *   The action goes first in the bar, before the mode toggles.
 * @param opts `{ tooltip }`.
 */
export function attachPoseControls(viewer, mode, { viewbar } = {}, { tooltip } = {}) {
  if (!viewbar) return { detach: noop };

  const actions = document.createElement("span");
  actions.className = "pf-pose-actions";
  const releaseButton = document.createElement("button");
  releaseButton.type = "button";
  releaseButton.className = "pf-pose-release";
  releaseButton.textContent = "Release pins";
  releaseButton.title = "Release every pinned point";
  releaseButton.setAttribute("aria-label", "Release every pinned point");
  actions.append(releaseButton);
  viewbar.prepend(actions);

  const tooltipBinding = tooltip ? attachButtonTooltips(tooltip, [{ element: releaseButton }]) : null;

  function sync() {
    const show = mode.isLive() && mode.pinCount() > 0;
    actions.hidden = !show;
    if (!show) tooltipBinding?.hide();
    tooltipBinding?.sync();
  }

  const onRelease = () => { mode.releasePins(); sync(); };
  const offPins = mode.onPinsChange(sync);
  const offMode = mode.onModeChange(sync);
  releaseButton.addEventListener("click", onRelease);
  sync();

  let detached = false;
  return {
    detach() {
      if (detached) return;
      detached = true;
      runCleanupSteps([
        offPins,
        offMode,
        () => releaseButton.removeEventListener("click", onRelease),
        () => tooltipBinding?.detach(),
        () => actions.remove(),
      ], "pose control cleanup failed");
    },
  };
}
