// Publish the viewbar's vertical claim as --pf-viewbar-clear on the stage, so
// chrome.css can stack the view cube on top of it without hardcoding a height
// that cutaway/measure/annotate action rows can change. A hidden bar (ours or a
// host stylesheet's) claims 0 — stage-clear.js has the why; the observer fires
// on the hide itself, since the bar's box goes to zero. Shared by mount() and
// mountPreview(). Returns a dispose; a no-op without a bar or a ResizeObserver.
import { stageClearFor } from "./stage-clear.js";

export function observeViewbarClear(stage, viewbar) {
  if (!viewbar || typeof ResizeObserver !== "function") return () => {};
  const publish = () => {
    const clear = stageClearFor(stage.getBoundingClientRect(), viewbar.getBoundingClientRect());
    stage.style.setProperty("--pf-viewbar-clear", `${clear}px`);
  };
  const observer = new ResizeObserver(publish);
  observer.observe(viewbar);
  observer.observe(stage);
  publish();
  return () => {
    observer.disconnect();
    stage.style.removeProperty("--pf-viewbar-clear");
  };
}
