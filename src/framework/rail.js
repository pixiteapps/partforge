import {
  RAIL_DEFAULT_WIDTH, RAIL_MIN_WIDTH, RAIL_NARROW_BREAKPOINT,
  clampRailWidth, railMaxWidth, readRailPref, resolveRailDrag, writeRailPref,
} from "./rail-state.js";
import { attachButtonTooltips } from "./tooltip.js";

const KEY_STEP = 16;
const KEY_STEP_SHIFT = 64;
// A held arrow-key repeat must not animate either, so the suppression flag
// covers the whole repeat window rather than just the instant of a keydown.
const KEY_SETTLE_MS = 200;

// lucide v1.25.0 `panel-right-close` / `panel-right-open` node data (ISC
// licence) - inlined rather than adding an icon-library dependency for two
// paths. Both icons share the same 18x18 rounded rect and vertical divider at
// x=15; they differ only in the chevron, so the SVG is built once (below) and
// only this `d` is swapped on state change.
const SVG_NS = "http://www.w3.org/2000/svg";
// panel-right-close: rail OPEN, chevron points right (toward the divider) -
// clicking pushes the rail shut.
const CHEVRON_RAIL_OPEN = "m8 9 3 3-3 3";
// panel-right-open: rail COLLAPSED, chevron points left (away from the
// divider) - clicking pulls the rail back open.
const CHEVRON_RAIL_COLLAPSED = "m10 15-3-3 3-3";

// Builds the toggle's icon once; apply() swaps the returned chevron path's
// `d` between CHEVRON_RAIL_OPEN and CHEVRON_RAIL_COLLAPSED. `stroke="currentColor"`
// is load-bearing: it's how the icon inherits the button's themed colour and
// its `.on` active state for free, with no icon-specific CSS anywhere.
function buildToggleIcon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");

  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("width", "18");
  rect.setAttribute("height", "18");
  rect.setAttribute("x", "3");
  rect.setAttribute("y", "3");
  rect.setAttribute("rx", "2");
  svg.append(rect);

  const divider = document.createElementNS(SVG_NS, "path");
  divider.setAttribute("d", "M15 3v18");
  svg.append(divider);

  const chevron = document.createElementNS(SVG_NS, "path");
  svg.append(chevron);

  return { svg, chevron };
}

// Touching the localStorage PROPERTY can throw (opaque origin, blocked site
// data) — not just its methods. view-state.js guards it the same way; the
// framework runs in an iframe in production, where this is reachable.
function safeStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

// Make the controls rail resizable and collapsible, with partforge-cloud's seam
// affordance: a 12px hit target holding a pill that is invisible until hover,
// keyboard focus, or a drag.
//
// The seam is created here, so no host markup declares it. Width is written
// straight onto :root as --pf-rail-w during a drag with no state layer in
// between: every width change resizes the viewer, whose ResizeObserver
// reallocates the WebGL drawing buffer. One reallocation per frame is inherent
// to live resizing; anything on top of it is not.
//
// Everything is optional. With no rail this returns a no-op, so hosts that lay
// the framework out themselves (see embed-test.html) are unaffected.
//
// `tooltip` is the mount's shared presenter (tooltip.js). With it, the toggle's
// Hide/Show-controls label renders as the same anchored pf-hover-tip the
// viewbar buttons use; without it, the label falls back to a native title.
export function attachRail({ rail, toggle, shell = rail?.parentElement, storage = safeStorage(), tooltip } = {}) {
  if (!rail || !shell) {
    // No rail to resolve in this document: --pf-rail-w still defaults to 288px
    // from tokens.css, but nothing is reserving that space, so anything that
    // reads the token to centre itself against the rail (app.css's
    // #pf-pick-banner) would otherwise sit 144px off-centre for no reason.
    // Zero is the truth here — a legacy id-only page or a custom host running
    // ?pickserver with no #panel/elements.rail hits this path.
    const root = document.documentElement;
    root.style.setProperty("--pf-rail-w", "0px");
    return { layoutChanged: () => {}, reveal: () => true, detach: () => root.style.removeProperty("--pf-rail-w") };
  }

  const root = document.documentElement;
  const shellBox = () => shell.getBoundingClientRect();
  const shellWidth = () => shellBox().width;
  // A host that leases the rail's placement through attachMobileTabs'
  // setRailLayout writes this ("dock" | "overlay"); absent means partforge's own
  // layout. Read live rather than cached: the lease can move at any moment and
  // layoutChanged() (below) is only a nudge to re-apply, not the source of truth.
  const hostLayout = () => shell.dataset.pfRailLayout ?? null;
  let state = readRailPref(storage, shellWidth());
  // Captured before the first apply() mutates the toggle, so detach() can
  // hand back a plain, unwired button rather than a dead "Show controls" one.
  // innerHTML (not textContent) so a host's original content - markup, not
  // just text - genuinely round-trips; the icon apply() writes is markup too.
  const toggleOriginal = toggle
    ? { html: toggle.innerHTML, title: toggle.title, hidden: toggle.hidden }
    : null;
  // Built once here rather than inside apply() (which reruns on every resize/
  // key/drag tick); apply() only ever swaps toggleChevron's `d`.
  let toggleChevron = null;
  if (toggle) {
    const { svg, chevron } = buildToggleIcon();
    toggle.replaceChildren(svg);
    toggleChevron = chevron;
  }
  // Attached BEFORE the first apply() below writes an aria-label, so the
  // binding's original-attribute capture (what its detach() restores) sees the
  // host's own markup, not our first label.
  const tooltipBinding = toggle && tooltip
    ? attachButtonTooltips(tooltip, [{ element: toggle }])
    : null;

  const seam = document.createElement("div");
  seam.className = "pf-rail-seam";
  seam.setAttribute("role", "separator");
  seam.setAttribute("aria-orientation", "vertical");
  seam.setAttribute("aria-label", "Resize controls");
  seam.setAttribute("aria-valuemin", "0");
  seam.tabIndex = 0;
  seam.append(document.createElement("span")); // the hover/focus affordance
  rail.before(seam);

  // shellW lets a caller that already measured the shell this frame (the
  // pointermove handler) thread that width through instead of forcing a
  // second synchronous layout here — apply() writes --pf-rail-w onto :root
  // just below, so any un-measured read after that point is a style+layout
  // flush, not a cached value.
  function apply({ persist = false, shellW } = {}) {
    const sw = shellW ?? shellWidth();
    // Below the breakpoint the shell shows exactly ONE pane (chrome.css, keyed
    // on data-pf-pane) and mobile-tabs.js picks it, so collapse has no meaning:
    // a persisted `collapsed: true` must not make the Controls tab land on an
    // inert, invisible rail. `state` is deliberately NOT rewritten — the stored
    // preference applies again the moment the window widens.
    const narrow = window.innerWidth < RAIL_NARROW_BREAKPOINT;
    // A host layout suspends collapse (and every resize gesture — see
    // resizeRefused) for the same reason narrow does: the rail's placement is
    // the host's to decide, so a collapse flag would only make it inert and
    // invisible where the host is showing it. `state` is left untouched, so
    // the preference returns intact when the lease ends.
    const layout = hostLayout();
    const overlay = layout === "overlay";
    const suppressed = narrow || layout !== null;
    const collapsed = state.collapsed && !suppressed;
    // WIDTH is suppressed on a NARROWER rule than collapse, because only two of
    // the three layouts stop needing --pf-rail-w:
    //   - narrow (any layout): chrome.css stacks the panes and shows exactly
    //     one, so the rail is the whole surface or absent — it reserves no
    //     width beside the viewer;
    //   - overlay (any width): the drawer sizes itself (min(288px, 85%)) and
    //     floats over the stage, reserving nothing;
    //   - dock at >= RAIL_NARROW_BREAKPOINT: the rail is STILL side by side with
    //     the stage — the host only leases the bottom inset — so zeroing here
    //     would leave the card with no controls at all. Keep the width.
    // Anything centring itself against the rail (app.css's #pf-pick-banner)
    // reads this token, so a stale 288px in the first two cases would offset it.
    // A wide dock therefore renders as: rail visible at its remembered width,
    // no resize, no collapse, and no toggle (hidden just below — a visible one
    // would be a dead control while collapse is suppressed). That is the
    // sheet-owns-layout stance: the host decides placement, we only supply the
    // width it laid the rail out against.
    const widthSuppressed = narrow || overlay;
    const width = collapsed || widthSuppressed ? 0 : clampRailWidth(state.width, sw);
    // Written on :root, not the rail/shell, so body-appended overlays (the
    // pick banner, the ?debug overlay) inherit it — see spec §4.4. This
    // assumes ONE rail per document: attachRail is written for a single
    // instance, and mounting two on one page would fight over --pf-rail-w
    // (both write :root; whichever's detach() runs last wins, clearing the
    // survivor's width too). README's "multiple mounts" claim is about
    // multiple mount() calls in general (e.g. cross-fade swaps), which is
    // fine as long as at most one has a resolvable rail at a time.
    root.style.setProperty("--pf-rail-w", `${width}px`);
    rail.toggleAttribute("inert", collapsed);
    seam.toggleAttribute("data-collapsed", collapsed);
    seam.setAttribute("aria-valuenow", String(width));
    seam.setAttribute("aria-valuemax", String(railMaxWidth(sw)));
    if (toggle) {
      // The tab bar owns pane selection below the breakpoint, so a second
      // collapse affordance in the viewbar would be a competing control. In
      // overlay mode the toggle IS the drawer's open/close control, so it must
      // stay visible even though the width says "narrow" — and the host hides
      // its own tab bar under a layout lease, making this the only way back to
      // the controls. Under dock it stays hidden at EVERY width, including the
      // wide band that keeps its --pf-rail-w above: collapse is suppressed
      // there, so a visible toggle would be a control that does nothing.
      toggle.hidden = suppressed && !overlay;
      // One button, two meanings: the drawer's open state in overlay mode, the
      // collapse everywhere else. `shut` is whichever of the two this layout
      // asks the label, chevron and aria-expanded to report.
      const shut = overlay ? !shell.hasAttribute("data-pf-rail-open") : collapsed;
      toggleChevron?.setAttribute("d", shut ? CHEVRON_RAIL_COLLAPSED : CHEVRON_RAIL_OPEN);
      const label = shut ? "Show controls" : "Hide controls";
      toggle.setAttribute("aria-expanded", String(!shut));
      toggle.setAttribute("aria-label", label);
      // The shared tooltip reads the aria-label at show time, so a native
      // title would double up as a second, competing tooltip.
      if (!tooltipBinding) toggle.title = label;
      toggle.classList.toggle("on", shut);
      tooltipBinding?.sync();
    }
    if (persist) writeRailPref(state, storage);
  }

  // --- discrete changes: animate, and commit immediately ---
  // The same "transient, debounced" flag suppresses the width transition for
  // both a held arrow-key repeat and a window resize (below) — either can
  // fire several times in a burst, and an animated width would fight the
  // last one before the previous animation finishes.
  let keyTimer = 0;
  function settleKeys() {
    clearTimeout(keyTimer);
    shell.removeAttribute("data-pf-key-resizing");
  }
  function markTransientResize() {
    shell.toggleAttribute("data-pf-key-resizing", true);
    clearTimeout(keyTimer);
    keyTimer = setTimeout(settleKeys, KEY_SETTLE_MS);
  }
  function commit(next) {
    settleKeys(); // a discrete change interrupting a key repeat animates normally
    state = next;
    apply({ persist: true });
  }
  const toggleCollapsed = () => commit({ collapsed: !state.collapsed, width: state.width });

  // Neither gesture that sizes the rail may run when the seam is not what
  // sizes it: chrome.css hides the vertical seam in the stacked layout (the
  // rail is under the viewer, not beside it), and a host layout sizes the rail
  // itself, where a width or a collapse we wrote would be invisible at best
  // and an inert docked rail at worst. The toggle still works in both.
  const resizeRefused = () => window.innerWidth < RAIL_NARROW_BREAKPOINT || hostLayout() !== null;

  // --- keyboard: move the SEPARATOR (standard role="separator" semantics), so
  // ArrowLeft widens a right-hand rail. Arrows clamp at the minimum and never
  // collapse; Enter/Space is the collapse gesture.
  function onKeyDown(e) {
    if (resizeRefused()) return;
    // Cmd/Alt/Ctrl+Arrow are browser/OS reserved (back, tab switch, ...); don't
    // eat them just because the seam happens to hold focus.
    if (e.metaKey || e.altKey || e.ctrlKey) return;
    // Enter/Space is the deliberate reopen gesture (below); arrows must not
    // also reopen a collapsed rail — that would clamp it to the 240px minimum
    // and silently discard the remembered width, and "narrower" reopening the
    // rail at all is backwards.
    if (state.collapsed && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return;
    const step = e.shiftKey ? KEY_STEP_SHIFT : KEY_STEP;
    // Re-clamp on READ rather than reconciling state.width on resize: a width
    // that no longer fits the current shell is still the user's preference and
    // should come back if the window grows again, so only the transient value
    // used for this keypress is clamped.
    const from = state.collapsed ? 0 : clampRailWidth(state.width, shellWidth());
    let width;
    switch (e.key) {
      case "ArrowLeft": width = from + step; break;
      case "ArrowRight": width = from - step; break;
      case "Home": case "End": {
        e.preventDefault();
        // Route through commit() — the path onDoubleClick uses — so these
        // jumps animate. Only a debounced arrow-key repeat (below) suppresses
        // the width transition.
        commit({
          collapsed: false,
          width: e.key === "Home" ? RAIL_MIN_WIDTH : railMaxWidth(shellWidth()),
        });
        return;
      }
      case "Enter": case " ": e.preventDefault(); toggleCollapsed(); return;
      default: return;
    }
    e.preventDefault();
    state = { collapsed: false, width: clampRailWidth(width, shellWidth()) };
    shell.toggleAttribute("data-pf-key-resizing", true);
    clearTimeout(keyTimer);
    keyTimer = setTimeout(() => {
      shell.removeAttribute("data-pf-key-resizing");
      writeRailPref(state, storage);
    }, KEY_SETTLE_MS);
    apply();
  }

  const onDoubleClick = () => commit({ collapsed: false, width: RAIL_DEFAULT_WIDTH });
  const onToggleClick = () => {
    // Overlay: the rail is a drawer over the stage, so the toggle slides it in
    // and out. It must not touch `state` — the collapse preference belongs to
    // the wide layout the host may hand back at any moment, and persisting a
    // drawer gesture into it would collapse the rail on a desktop next visit.
    // The host clears this flag itself when the lease ends or the stage is
    // touched (mobile-tabs.js), so nothing here has to unwind it.
    if (hostLayout() === "overlay") {
      shell.toggleAttribute("data-pf-rail-open");
      apply();
      return;
    }
    toggleCollapsed();
  };

  // --- drag ---
  let grabOffset = 0;
  function onPointerDown(e) {
    if (e.button !== 0) return;
    if (resizeRefused()) return;
    e.preventDefault();
    // setPointerCapture is load-bearing: without it the pointer crosses into the
    // viewer (an iframe, in the cloud editor) whose document eats the move
    // events, and the drag dies the moment it reaches the thing being resized.
    seam.setPointerCapture?.(e.pointerId);
    const box = seam.getBoundingClientRect();
    // Where inside the 12px seam the grab landed, so the rail edge doesn't jump.
    grabOffset = e.clientX - (box.left + box.width / 2);
    shell.toggleAttribute("data-pf-dragging", true);
    // Safety net: setPointerCapture is load-bearing (see above), but it is
    // still an optional call — if it's unavailable or the browser fails to
    // honour it, the pointerup can land on the canvas instead of the seam,
    // onPointerUp never runs, data-pf-dragging is stuck forever, and
    // chrome.css's [data-pf-dragging] .pf-stage { pointer-events: none } dead-
    // locks the viewer with no recovery. Also listening on window guarantees
    // the drag always terminates regardless of where the pointer ends up.
    // Bound only for the duration of a drag (removed in onPointerUp/detach)
    // so there is never a permanently-bound window listener.
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  }
  function onPointerMove(e) {
    if (!shell.hasAttribute("data-pf-dragging")) return;
    // Measure the shell once per move and thread it through resolveRailDrag
    // and apply(), instead of re-measuring after apply() has already mutated
    // :root's style (which would force a synchronous style+layout flush).
    const box = shellBox();
    const railX = box.right - (e.clientX - grabOffset);
    const next = resolveRailDrag(railX, state, box.width);
    if (next === state) return; // unchanged — skip the redundant DOM writes
    state = next;
    apply({ shellW: box.width });
  }
  function onPointerUp(e) {
    // Guards against running end-of-drag logic twice for one gesture: whichever
    // of the seam's own pointerup and the window safety-net fires first clears
    // the attribute, so the second (if it fires at all) is a no-op.
    if (!shell.hasAttribute("data-pf-dragging")) return;
    seam.releasePointerCapture?.(e.pointerId);
    shell.removeAttribute("data-pf-dragging");
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    apply({ persist: true });
  }

  seam.addEventListener("pointerdown", onPointerDown);
  seam.addEventListener("pointermove", onPointerMove);
  seam.addEventListener("pointerup", onPointerUp);
  seam.addEventListener("pointercancel", onPointerUp);
  seam.addEventListener("keydown", onKeyDown);
  seam.addEventListener("dblclick", onDoubleClick);
  toggle?.addEventListener("click", onToggleClick);
  // A window resize can invalidate the clamp (max is half the shell). Narrowing
  // the window with a maxed-out rail can genuinely change --pf-rail-w, and
  // without suppression that change would animate — fighting the resize with
  // a trailing 150ms transition and an extra WebGL buffer reallocation.
  const onResize = () => {
    markTransientResize();
    apply();
  };
  window.addEventListener("resize", onResize);

  apply();

  return {
    // The host's data-pf-rail-layout / data-pf-rail-open attributes are read
    // live by apply(), so re-running it is the whole of "the layout moved".
    // Deliberately unconditional: attachMobileTabs reports every setRailLayout
    // call, no-change ones included, and a bare re-apply is idempotent.
    layoutChanged: () => apply(),
    // Make the rail visible where partforge places it ("More in the panel"):
    // open an overlay drawer, or expand a collapsed wide rail (persisted, as the
    // toggle would). False under a dock lease, whose sheet only the host can
    // show. Narrow with no lease is mobile-tabs' pane, and the persisted collapse
    // is left alone there, as apply() leaves it.
    reveal: () => {
      const layout = hostLayout();
      if (layout === "dock") return false;
      if (layout === "overlay") {
        if (!shell.hasAttribute("data-pf-rail-open")) {
          shell.toggleAttribute("data-pf-rail-open", true);
          apply();
        }
        return true;
      }
      if (state.collapsed && window.innerWidth >= RAIL_NARROW_BREAKPOINT) commit({ collapsed: false, width: state.width });
      return true;
    },
    detach: () => {
      settleKeys();
      seam.removeEventListener("pointerdown", onPointerDown);
      seam.removeEventListener("pointermove", onPointerMove);
      seam.removeEventListener("pointerup", onPointerUp);
      seam.removeEventListener("pointercancel", onPointerUp);
      seam.removeEventListener("keydown", onKeyDown);
      seam.removeEventListener("dblclick", onDoubleClick);
      toggle?.removeEventListener("click", onToggleClick);
      window.removeEventListener("resize", onResize);
      // In case detach() happens mid-drag, so the safety net doesn't outlive it.
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      seam.remove();
      shell.removeAttribute("data-pf-dragging");
      rail.removeAttribute("inert");
      root.style.removeProperty("--pf-rail-w");
      // Before the attribute restore below: the binding's own detach rewrites
      // title/aria-label from its capture, and ours must win.
      tooltipBinding?.detach();
      if (toggle) {
        toggle.innerHTML = toggleOriginal.html;
        toggle.title = toggleOriginal.title;
        toggle.hidden = toggleOriginal.hidden;
        toggle.removeAttribute("aria-expanded");
        toggle.removeAttribute("aria-label");
        toggle.classList.remove("on");
      }
    },
  };
}
