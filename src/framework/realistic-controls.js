// Viewbar chrome for realistic mode: a toggle button and an environment <select>.
// Both optional (a host without the elements simply has no built-in controls and
// drives runtime.renderMode / runtime.environment itself). Same shape as
// viewer-controls.js. The state shown is always the viewer's: the toggle is
// pressed only once realistic has actually landed, and the menu shows the
// environment in effect (a failed switch snaps it back).
import { ENVIRONMENTS } from "./materials/environments.js";
import { saveRenderMode, saveEnvironment } from "./view-state.js";
import { attachButtonTooltips } from "./tooltip.js";

const LABEL = "Realistic view";
const ERROR_LABEL = "Couldn't load realistic view";

export function attachRealisticControls(viewer, { toggle, envMenu } = {}, { tooltip } = {}) {
  const binding = tooltip && toggle ? attachButtonTooltips(tooltip, [{ element: toggle }]) : null;
  if (envMenu && !envMenu.options.length) {
    for (const env of Object.values(ENVIRONMENTS)) {
      const o = document.createElement("option");
      o.value = env.id;
      o.textContent = env.label;
      envMenu.append(o);
    }
    envMenu.setAttribute("aria-label", "Environment");
  }

  // The last mode event's busy/error, so an environment event or sync() —
  // which carry neither — re-render without clearing them.
  let busy = false;
  let error = null;

  function render() {
    const mode = viewer.getRenderMode();
    if (toggle) {
      const on = mode === "realistic";
      toggle.classList.toggle("on", on);
      toggle.setAttribute("aria-pressed", String(on));
      if (busy) toggle.dataset.busy = "true"; else delete toggle.dataset.busy;
      const label = error ? ERROR_LABEL : LABEL;
      toggle.setAttribute("aria-label", label);
      if (!tooltip) toggle.title = label;
    }
    if (envMenu) {
      envMenu.hidden = mode !== "realistic";
      envMenu.value = viewer.getEnvironment();
    }
    binding?.sync();
  }

  // A click while realistic is still loading is a change of mind: back to CAD.
  // What persists is what the viewer says took effect, not what was asked for.
  const onToggle = () => {
    const next = viewer.getRenderMode() === "realistic" || busy ? "cad" : "realistic";
    viewer.setRenderMode(next).then(saveRenderMode, () => {});
  };
  const onEnv = () => {
    viewer.setEnvironment(envMenu.value).then(saveEnvironment, () => {});
  };
  toggle?.addEventListener("click", onToggle);
  envMenu?.addEventListener("change", onEnv);
  const offMode = viewer.onRenderModeChange((e) => {
    busy = !!e?.busy;
    error = e?.error ?? null;
    render();
  });
  const offEnv = viewer.onEnvironmentChange(() => render());
  render();

  return {
    sync: render,
    detach() {
      toggle?.removeEventListener("click", onToggle);
      envMenu?.removeEventListener("change", onEnv);
      offMode();
      offEnv();
      binding?.detach();
    },
  };
}
