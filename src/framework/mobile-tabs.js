// The narrow-layout pane tab bar. Below RAIL_NARROW_BREAKPOINT there is no room
// for a rail beside the viewer, so the shell shows exactly ONE pane and this bar
// chooses which. chrome.css owns the layout, keyed on the data-pf-pane attribute
// this module writes onto .pf-shell; a missing attribute reads as "stage", so
// the layout is already correct before any of this runs.
//
// Three independent reasons the bar can be absent, and they are deliberately
// handled by different mechanisms:
//   * WIDTH — above the breakpoint the rail sits beside the viewer and no tab is
//     needed. That is pure CSS (.pf-tabbar { display: none }). There is no JS
//     media-query bookkeeping in this file at all, and no resize listener.
//   * A HOST owns pane selection — partforge-cloud draws its own bottom bar at
//     the window level and drives this layout through setHostPane(). Then our
//     bar is `hidden` and only the host's choice writes data-pf-pane.
//   * A HOST owns the rail's LAYOUT — setRailLayout() docks the rail into a
//     bottom sheet or floats it as an overlay drawer, each with its own way in
//     and out, so a pane tab would be a second, competing control. That lease
//     is independent of the pane one: either alone hides the bar.
//
// State is in-memory: a fresh load starts on the stage, and nothing persists.
// Which pane you are looking at right now is not a preference.
//
// The DOM is created here, so no host markup declares it — same contract as
// rail.js's seam, and the reason this composes with partforge-cloud's
// hand-built sandbox scaffold without that scaffold knowing anything about it.

import { RAIL_NARROW_BREAKPOINT } from "./rail-state.js";
const SVG_NS = "http://www.w3.org/2000/svg";

// Hand-authored in lucide's 24x24 / 2px-stroke idiom so these sit beside
// rail.js's toggle icon without introducing a second icon vocabulary (and
// without a dependency for three glyphs). `stroke="currentColor"` is
// load-bearing: it is how each icon picks up its button's themed colour, and
// the accent colour of the pressed state, with no icon-specific CSS anywhere.
const ICONS = {
  // A box: the part itself.
  stage: [
    "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z",
    "m3.3 7 8.7 5 8.7-5",
    "M12 22V12",
  ],
  // Three horizontal sliders: the parameter controls.
  rail: [
    "M21 4h-7", "M10 4H3", "M21 12h-9", "M8 12H3", "M21 20h-5", "M12 20H3",
    "M14 2v4", "M8 10v4", "M16 18v4",
  ],
};
const LABELS = { stage: "3D", rail: "Controls" };
const PANES = ["stage", "rail"];

// A host-driven rail layout (partforge-cloud's bottom sheet / overlay drawer).
// null = partforge's own default layout. Normalization is strict: a shape this
// module does not recognize is a null, never a guess — the host is trusted to
// send well-formed layouts and a garbled one must not wedge the shell.
const MAX_RAIL_INSET = 4096;

function normalizeRailLayout(next) {
  if (!next || typeof next !== "object") return null;
  if (next.mode === "overlay") return { mode: "overlay" };
  if (next.mode !== "dock") return null;
  if (!Number.isInteger(next.inset) || next.inset < 0 || next.inset > MAX_RAIL_INSET) return null;
  // A missing or unusable railHeight is a zero, not a rejection: the inset is
  // what the stage lays out against, and a sheet with no visible collapsed
  // height is a legitimate state.
  const railHeight = Number.isInteger(next.railHeight)
    ? Math.max(0, Math.min(next.inset, next.railHeight))
    : 0;
  return { mode: "dock", inset: next.inset, railHeight };
}

function buildIcon(paths) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  // Decorative: every button carries a visible text label already.
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

// role="group" + aria-pressed, NOT role="tablist": a real tablist owes its tabs
// aria-controls'd tabpanels, and .pf-stage / .pf-rail are host-built DOM this
// module does not own and must not relabel. Two pressed-state buttons describe
// what this actually is without promising semantics we cannot honour.
//
// Everything is optional, like attachRail: with no shell to manage this returns
// a no-op handle, so a legacy id-only page or a host that lays the framework out
// itself (embed-test.html) is unaffected — including its setHostPane and
// setRailLayout, which stay callable no-ops so mount()'s handle shape never
// varies. `toggle` is rail.js's own rail toggle, passed only so the overlay duck
// below can recognize it; omitting it costs the drawer its close button.
export function attachMobileTabs({ shell, stage, rail, toggle, onRailLayout } = {}) {
  if (!shell || !stage || !rail) {
    return { setHostPane: () => {}, setRailLayout: () => {}, showPane: () => false, detach: () => {} };
  }

  let pane = "stage"; // the standalone user's choice
  let hostPane = null; // a host's lease over that choice, while non-null
  let railLayout = null; // a host's lease over where the rail sits, while non-null

  const bar = document.createElement("div");
  bar.className = "pf-tabbar";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Viewer panes");
  const buttons = new Map();
  for (const p of PANES) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.pfPaneTab = p;
    button.title = LABELS[p];
    button.append(buildIcon(ICONS[p]));
    const label = document.createElement("span");
    label.textContent = LABELS[p];
    button.append(label);
    bar.append(button);
    buttons.set(p, button);
  }
  // Last child of the shell: in the narrow layout .pf-shell is a column, so the
  // bar lands under whichever pane is showing. Above the breakpoint it is
  // display:none and its position in the flex row is moot.
  shell.append(bar);

  function apply() {
    const active = hostPane ?? pane;
    shell.dataset.pfPane = active;
    for (const [p, button] of buttons) {
      button.setAttribute("aria-pressed", String(p === active));
    }
    // chrome.css keys the docked/overlay rail off these; the two lengths are
    // zero in overlay mode, where the drawer floats over a full-width stage.
    if (railLayout) {
      shell.dataset.pfRailLayout = railLayout.mode;
      shell.style.setProperty("--pf-rail-inset", `${railLayout.mode === "dock" ? railLayout.inset : 0}px`);
      shell.style.setProperty("--pf-rail-dock-h", `${railLayout.mode === "dock" ? railLayout.railHeight : 0}px`);
    } else {
      delete shell.dataset.pfRailLayout;
      shell.style.removeProperty("--pf-rail-inset");
      shell.style.removeProperty("--pf-rail-dock-h");
    }
    // The drawer-open flag only means anything in overlay mode; entering any
    // other layout must not leave a stale open state behind.
    if (railLayout?.mode !== "overlay") shell.removeAttribute("data-pf-rail-open");
    // A host that owns EITHER pane selection or the layout draws its own
    // controls; ours would compete.
    bar.hidden = hostPane !== null || railLayout !== null;
  }

  // Delegated, so the icon <svg>/<span> inside a button resolve to the button.
  const onClick = (e) => {
    const next = e.target?.closest?.("[data-pf-pane-tab]")?.dataset?.pfPaneTab;
    if (!PANES.includes(next)) return;
    pane = next;
    apply();
  };
  bar.addEventListener("click", onClick);

  // Overlay mode's "duck": any interaction with the stage slides the drawer
  // back. Capture phase, because the canvas consumes pointer events.
  //
  // Two things the plain "remove the attribute" version got wrong, both because
  // the rail toggle is a DESCENDANT of the stage (it floats at the stage's
  // top-right):
  //   * its own tap arrives here first, so this would close the drawer a moment
  //     before rail.js's click handler reopened it — the toggle could open the
  //     drawer but never shut it. Hence the exemption, which needs the element
  //     itself: nothing in the DOM marks it out for a class/closest() test.
  //   * a real duck has to be REPORTED. The toggle's chevron, aria-expanded and
  //     label are derived from the open flag in rail.js's apply(), so a close it
  //     was never told about leaves the button announcing an open drawer. The
  //     callback is the same one setRailLayout uses (the host wires it to
  //     railChrome.layoutChanged), so this is a re-look, not a new channel.
  const onStagePointerDown = (e) => {
    if (toggle && (e.target === toggle || toggle.contains?.(e.target))) return;
    if (shell.dataset.pfRailLayout !== "overlay") return;
    // Nothing to duck: stay silent rather than nudge on every stage pointerdown.
    if (!shell.hasAttribute("data-pf-rail-open")) return;
    shell.removeAttribute("data-pf-rail-open");
    onRailLayout?.(railLayout);
  };
  stage.addEventListener("pointerdown", onStagePointerDown, true);
  apply();

  return {
    // Show a pane as the tab bar would ("More in the panel"). False when a host
    // holds the pane lease: the host draws the pane, so it has to be told instead.
    showPane: (next) => {
      if (hostPane !== null || !PANES.includes(next)) return false;
      if (window.innerWidth >= RAIL_NARROW_BREAKPOINT) return true; // side by side: already shown
      pane = next;
      apply();
      return true;
    },
    // 'stage' | 'rail' takes the lease; anything else (including null) releases
    // it and restores the standalone bar and the user's own last choice.
    setHostPane: (next) => {
      hostPane = PANES.includes(next) ? next : null;
      apply();
    },
    // A dock/overlay layout takes the lease; anything this module cannot read —
    // null included — releases it and restores partforge's own layout. The
    // callback reports what was actually applied, so a host never has to guess
    // whether its request survived normalization.
    setRailLayout: (next) => {
      railLayout = normalizeRailLayout(next);
      apply();
      onRailLayout?.(railLayout);
    },
    detach: () => {
      bar.removeEventListener("click", onClick);
      stage.removeEventListener("pointerdown", onStagePointerDown, true);
      bar.remove();
      delete shell.dataset.pfPane;
      delete shell.dataset.pfRailLayout;
      shell.removeAttribute("data-pf-rail-open");
      shell.style.removeProperty("--pf-rail-inset");
      shell.style.removeProperty("--pf-rail-dock-h");
    },
  };
}
