// Always-on hover inspection: a cursor-following tooltip naming the feature +
// sub-part under the pointer, and an overlay mesh highlighting the feature's
// surface. Feature names come from Solid.label() in the part's build, carried
// per-triangle in the mesh payload (geometry.userData.featureIds/features).
import { createTooltipPresenter } from "../tooltip.js";
import { raycastViewer } from "./raycast.js";
import { createFeatureHighlight } from "./feature-highlight.js";
import { runCleanupSteps } from "../teardown.js";

export function attachHoverLabels(
  viewer,
  { part, schedule = (cb) => requestAnimationFrame(cb), tooltip } = {},
) {
  // Hover is a mouse idiom — skip entirely on touch-only devices. The stub
  // still answers the WHOLE interface: mount.js calls setSuppressed from the
  // measure and annotate mode-change listeners without asking which device it
  // is on, and a missing method there threw inside notifyMode on every phone —
  // aborting the listener loop before the host application's own relay ran.
  if (globalThis.matchMedia && !matchMedia("(hover: hover)").matches) {
    return { setSuppressed: () => {}, detach: () => {} };
  }

  const ownsTooltip = !tooltip;
  const tooltipPresenter = tooltip ?? createTooltipPresenter();
  let presentationToken;
  let hasPresented = false;

  const highlight = createFeatureHighlight(viewer);

  const subLabel = (name) => part.parts[name]?.label ?? name;

  function hide() {
    if (hasPresented) {
      hasPresented = false;
      tooltipPresenter.hide(presentationToken);
      presentationToken = undefined;
    }
    highlight.clear();
  }

  function show(hit, x, y) {
    let content;
    if (hit.feature) {
      content = { title: hit.feature.label, subtitle: subLabel(hit.subPart) };
    } else {
      content = { title: subLabel(hit.subPart), subtitle: "" };
    }
    highlight.show(hit);
    if (hasPresented) {
      hasPresented = false;
      tooltipPresenter.hide(presentationToken);
      presentationToken = undefined;
    }
    presentationToken = tooltipPresenter.showPointer(content, x, y);
    hasPresented = true;
  }

  let pending = null; // latest pointer position; one raycast per scheduled frame
  let frameScheduled = false;
  let workVersion = 0;
  let down = false;
  let detached = false;
  let suppressed = false;
  let externallySuppressed = false;

  function invalidatePendingWork() {
    pending = null;
    frameScheduled = false;
    workVersion += 1;
  }

  const unsubscribeHandleHover = viewer.onCutawayHandleHover?.((handle) => {
    suppressed = handle != null;
    if (!suppressed) return;
    invalidatePendingWork();
    hide();
  }) ?? (() => {});

  function onMove(ev) {
    if (detached) return;
    if (ev.pointerType === "touch") return;
    if (down || suppressed || externallySuppressed) return;
    pending = { x: ev.clientX, y: ev.clientY };
    if (frameScheduled) return;
    frameScheduled = true;
    const scheduledVersion = workVersion;
    schedule(() => {
      if (scheduledVersion !== workVersion) return;
      frameScheduled = false;
      const p = pending;
      pending = null;
      if (detached || !p || down || suppressed || externallySuppressed) return;
      const hit = raycastViewer(viewer, p.x, p.y);
      if (hit) show(hit, p.x, p.y); else hide();
    });
  }
  const onDown = () => { down = true; invalidatePendingWork(); hide(); };
  const onUp = () => { down = false; };
  const onLeave = () => { invalidatePendingWork(); hide(); };

  viewer.domElement.addEventListener("pointermove", onMove);
  viewer.domElement.addEventListener("pointerdown", onDown);
  viewer.domElement.addEventListener("pointerup", onUp);
  viewer.domElement.addEventListener("pointerleave", onLeave);

  return {
    setSuppressed(on) {
      externallySuppressed = !!on;
      if (externallySuppressed) { invalidatePendingWork(); hide(); }
    },
    detach: () => {
      if (detached) return;
      detached = true;
      invalidatePendingWork();
      runCleanupSteps([
        unsubscribeHandleHover,
        () => viewer.domElement.removeEventListener("pointermove", onMove),
        () => viewer.domElement.removeEventListener("pointerdown", onDown),
        () => viewer.domElement.removeEventListener("pointerup", onUp),
        () => viewer.domElement.removeEventListener("pointerleave", onLeave),
        hide,
        () => highlight.dispose(),
        () => { if (ownsTooltip) tooltipPresenter.dispose(); },
      ], "feature hover cleanup failed");
    },
  };
}
