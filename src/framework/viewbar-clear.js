// Publish the viewbar's vertical claim as --pf-viewbar-clear on the stage, so
// chrome.css can stack the view cube on top of it without hardcoding a height
// that cutaway/measure/annotate action rows can change. A hidden bar (ours or a
// host stylesheet's) claims 0 — stage-clear.js has the why; the observer fires
// on the hide itself, since the bar's box goes to zero. Shared by mount() and
// mountPreview(). Returns a dispose; a no-op without a bar or a ResizeObserver.
//
// The claim also covers any shown `[data-pf-viewbar-float]` inside the bar: an
// absolutely placed child floated above it (measure's X/Y/Z readout) is outside
// the bar's own box, so without it the cube would sit on top of the readout.
// Showing or hiding one moves no box the ResizeObserver watches, hence the
// MutationObserver; floats can be added after this is attached.
import { stageClearFor } from "./stage-clear.js";

export const VIEWBAR_FLOAT_ATTR = "data-pf-viewbar-float";

/**
 * The viewbar's READOUT SLOT: a pill floated just off the bar, right edges flush (above a
 * bottom-anchored bar, below the legacy top-right one) — app.css's `.pf-viewbar-readout`.
 * Measure mode's X/Y/Z parts and pose mode's live drag values both show there; the two
 * modes are never live at once (measure suppresses posing). Marked as a float, so the
 * view cube's clearance counts it. Starts hidden; the caller puts it in the bar.
 */
export function createViewbarReadout(tag, className) {
  const el = document.createElement(tag);
  el.className = `pf-viewbar-readout ${className}`;
  el.setAttribute(VIEWBAR_FLOAT_ATTR, "");
  el.hidden = true;
  return el;
}

// The highest claim among the bar and its floats. A hidden bar claims nothing
// whatever its floats say, and a hidden float drops out on stageClearFor's own
// empty-box terms.
export function viewbarClearFor(stageRect, barRect, floatRects = []) {
  if (!barRect || barRect.height === 0) return 0;
  return Math.max(stageClearFor(stageRect, barRect), ...floatRects.map((r) => stageClearFor(stageRect, r)));
}

export function observeViewbarClear(stage, viewbar) {
  if (!viewbar || typeof ResizeObserver !== "function") return () => {};
  const publish = () => {
    const floats = [...viewbar.querySelectorAll(`[${VIEWBAR_FLOAT_ATTR}]`)].map((el) => el.getBoundingClientRect());
    const clear = viewbarClearFor(stage.getBoundingClientRect(), viewbar.getBoundingClientRect(), floats);
    stage.style.setProperty("--pf-viewbar-clear", `${clear}px`);
  };
  const observer = new ResizeObserver(publish);
  observer.observe(viewbar);
  observer.observe(stage);
  const mutations = typeof MutationObserver === "function" ? new MutationObserver(publish) : null;
  mutations?.observe(viewbar, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden"] });
  publish();
  return () => {
    observer.disconnect();
    mutations?.disconnect();
    stage.style.removeProperty("--pf-viewbar-clear");
  };
}
