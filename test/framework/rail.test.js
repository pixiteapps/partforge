// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test } from "vitest";
import { attachRail } from "../../src/framework/rail.js";
import { RAIL_DEFAULT_WIDTH, RAIL_MIN_WIDTH } from "../../src/framework/rail-state.js";

// Mirrors the private CHEVRON_RAIL_OPEN/CHEVRON_RAIL_COLLAPSED constants in
// rail.js (not exported - they're an implementation detail of the toggle
// icon), so assertions below can check the chevron actually flipped rather
// than just that some string changed.
const CHEVRON_RAIL_OPEN = "m8 9 3 3-3 3";
const CHEVRON_RAIL_COLLAPSED = "m10 15-3-3 3-3";
const toggleChevronD = (toggle) => toggle.querySelector("svg path:last-child").getAttribute("d");

function fakeStorage() {
  let value = null;
  return { getItem: () => value, setItem: (_k, v) => { value = v; }, read: () => value };
}

// Every attachRail() a test creates is tracked here so afterEach can detach it —
// otherwise each test leaves a live `window` resize listener (and, mid-drag,
// pointerup/pointercancel listeners) bound to DOM that beforeEach is about to
// discard, accumulating across the whole file.
let liveHandles = [];
function track(handle) {
  liveHandles.push(handle);
  return handle;
}

// happy-dom gives every element a zero-size box, so the shell width the state
// machine clamps against has to be stubbed.
function setup({ withToggle = false, shellWidth = 1600 } = {}) {
  document.body.innerHTML = `
    <div class="pf-shell">
      <div class="pf-stage"></div>
      <div class="pf-rail"></div>
    </div>`;
  const shell = document.querySelector(".pf-shell");
  const rail = document.querySelector(".pf-rail");
  shell.getBoundingClientRect = () => ({ left: 0, right: shellWidth, width: shellWidth, top: 0, bottom: 720, height: 720 });
  const toggle = withToggle ? document.createElement("button") : undefined;
  if (toggle) document.body.append(toggle);
  const storage = fakeStorage();
  const handle = track(attachRail({ rail, shell, toggle, storage }));
  return { shell, rail, toggle, storage, handle, seam: shell.querySelector(".pf-rail-seam") };
}

const railWidth = () => document.documentElement.style.getPropertyValue("--pf-rail-w");
const key = (seam, k, init = {}) => seam.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));

beforeEach(() => {
  document.documentElement.style.removeProperty("--pf-rail-w");
  document.body.innerHTML = "";
});

afterEach(() => {
  for (const handle of liveHandles) handle.detach();
  liveHandles = [];
});

test("creates the seam with separator semantics and the live width", () => {
  const { seam } = setup();
  expect(seam).not.toBeNull();
  expect(seam.getAttribute("role")).toBe("separator");
  expect(seam.getAttribute("aria-orientation")).toBe("vertical");
  expect(seam.getAttribute("aria-label")).toBe("Resize controls");
  expect(seam.tabIndex).toBe(0);
  expect(seam.getAttribute("aria-valuenow")).toBe(String(RAIL_DEFAULT_WIDTH));
  expect(seam.getAttribute("aria-valuemin")).toBe("0");
  // The affordance pill is a child, not a background on the seam itself.
  expect(seam.querySelector("span")).not.toBeNull();
  expect(railWidth()).toBe(`${RAIL_DEFAULT_WIDTH}px`);
});

test("is a no-op without a rail, so embed hosts are unaffected", () => {
  expect(() => attachRail({}).detach()).not.toThrow();
  expect(document.querySelector(".pf-rail-seam")).toBeNull();
});

test("ArrowLeft widens the rail and ArrowRight narrows it", () => {
  const { seam } = setup();
  key(seam, "ArrowLeft");
  expect(railWidth()).toBe(`${RAIL_DEFAULT_WIDTH + 16}px`);
  key(seam, "ArrowRight");
  expect(railWidth()).toBe(`${RAIL_DEFAULT_WIDTH}px`);
});

test("Shift multiplies the keyboard step", () => {
  const { seam } = setup();
  key(seam, "ArrowLeft", { shiftKey: true });
  expect(railWidth()).toBe(`${RAIL_DEFAULT_WIDTH + 64}px`);
});

test("Home and End jump to the clamped min and max", () => {
  const { seam } = setup({ shellWidth: 900 });
  key(seam, "Home");
  expect(railWidth()).toBe(`${RAIL_MIN_WIDTH}px`);
  key(seam, "End");
  expect(railWidth()).toBe("450px"); // half of a 900px shell
});

test("arrow keys never collapse — they clamp at the minimum", () => {
  const { seam, rail } = setup();
  for (let i = 0; i < 40; i++) key(seam, "ArrowRight");
  expect(railWidth()).toBe(`${RAIL_MIN_WIDTH}px`);
  expect(rail.hasAttribute("inert")).toBe(false);
});

test("Enter collapses: width 0, rail inert, seam still mounted and re-cursored", () => {
  const { seam, rail, shell } = setup();
  key(seam, "Enter");
  expect(railWidth()).toBe("0px");
  expect(rail.hasAttribute("inert")).toBe(true);
  expect(seam.hasAttribute("data-collapsed")).toBe(true);
  expect(seam.getAttribute("aria-valuenow")).toBe("0");
  // Recovery depends on the seam surviving collapse.
  expect(shell.contains(seam)).toBe(true);
});

test("Space toggles back open at the remembered width", () => {
  const { seam } = setup();
  key(seam, "ArrowLeft");
  const widened = railWidth();
  key(seam, " ");
  expect(railWidth()).toBe("0px");
  key(seam, " ");
  expect(railWidth()).toBe(widened);
});

test("double-click resets to the default width", () => {
  const { seam } = setup();
  key(seam, "ArrowLeft");
  seam.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  expect(railWidth()).toBe(`${RAIL_DEFAULT_WIDTH}px`);
});

test("a drag writes the width live and persists once on pointerup", () => {
  const { seam, shell, storage } = setup();
  seam.getBoundingClientRect = () => ({ left: 1600 - RAIL_DEFAULT_WIDTH - 6, right: 1600 - RAIL_DEFAULT_WIDTH + 6, width: 12 });
  seam.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 1600 - RAIL_DEFAULT_WIDTH }));
  expect(shell.hasAttribute("data-pf-dragging")).toBe(true);
  expect(storage.read()).toBeNull(); // nothing persisted mid-drag
  seam.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 1200 }));
  expect(railWidth()).toBe("400px");
  seam.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 1200 }));
  expect(shell.hasAttribute("data-pf-dragging")).toBe(false);
  expect(JSON.parse(storage.read())).toEqual({ width: 400, collapsed: false });
});

test("a drag corrects for where inside the seam the pointer grabbed it", () => {
  const { seam } = setup();
  // The other drag test grabs dead-centre on the stubbed seam box, so its
  // grabOffset is always 0 and never exercises the correction. Grab the left
  // edge instead (clientX 1306, box centre 1312) for grabOffset -6.
  seam.getBoundingClientRect = () => ({ left: 1600 - RAIL_DEFAULT_WIDTH - 6, right: 1600 - RAIL_DEFAULT_WIDTH + 6, width: 12 });
  seam.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 1600 - RAIL_DEFAULT_WIDTH - 6 }));
  seam.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 1200 }));
  // Ignoring the offset would read 1600 - 1200 = 400px; folding in grabOffset
  // -6 moves the rail edge to follow the actual grab point: 394px.
  expect(railWidth()).toBe("394px");
});

test("a stored preference is restored on attach", () => {
  document.body.innerHTML = `<div class="pf-shell"><div class="pf-stage"></div><div class="pf-rail"></div></div>`;
  const shell = document.querySelector(".pf-shell");
  shell.getBoundingClientRect = () => ({ left: 0, right: 1600, width: 1600 });
  const storage = fakeStorage();
  storage.setItem("partforge:rail", JSON.stringify({ width: 420, collapsed: false }));
  track(attachRail({ rail: document.querySelector(".pf-rail"), shell, storage }));
  expect(railWidth()).toBe("420px");
});

test("an optional toggle button collapses and restores, tracking state in its label", () => {
  const { toggle, rail } = setup({ withToggle: true });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.getAttribute("aria-label")).toBe("Hide controls");
  expect(toggleChevronD(toggle)).toBe(CHEVRON_RAIL_OPEN);

  toggle.click();
  expect(rail.hasAttribute("inert")).toBe(true);
  expect(railWidth()).toBe("0px");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.getAttribute("aria-label")).toBe("Show controls");
  expect(toggleChevronD(toggle)).toBe(CHEVRON_RAIL_COLLAPSED);
  expect(toggle.classList.contains("on")).toBe(true);

  toggle.click();
  expect(rail.hasAttribute("inert")).toBe(false);
  expect(railWidth()).toBe(`${RAIL_DEFAULT_WIDTH}px`);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
});

test("the toggle still works mid-drag", () => {
  const { toggle, seam } = setup({ withToggle: true });
  // happy-dom's default window.innerWidth (1024) is above RAIL_NARROW_BREAKPOINT,
  // so this pointerdown actually starts a drag (see the narrow-viewport test
  // below for the refusal itself). This proves the toggle doesn't depend on
  // drag state, even while a drag is in progress.
  seam.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 10 }));
  toggle.click();
  expect(railWidth()).toBe("0px");
});

test("onPointerDown refuses to start a drag in the stacked layout (<720px)", () => {
  const original = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { value: 600, configurable: true });
  try {
    const { shell, seam } = setup();
    seam.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 10 }));
    expect(shell.hasAttribute("data-pf-dragging")).toBe(false);
  } finally {
    Object.defineProperty(window, "innerWidth", { value: original, configurable: true });
  }
});

test("detach removes the seam and stops responding", () => {
  const { seam, shell, handle } = setup();
  handle.detach();
  expect(shell.querySelector(".pf-rail-seam")).toBeNull();
  key(seam, "ArrowLeft");
  expect(railWidth()).toBe(""); // property cleaned up, listener gone
});

test("Home and End animate the width; arrow keys suppress the transition instead", () => {
  const { seam, shell, storage } = setup();
  key(seam, "ArrowRight");
  expect(shell.hasAttribute("data-pf-key-resizing")).toBe(true);
  key(seam, "Home");
  expect(shell.hasAttribute("data-pf-key-resizing")).toBe(false);
  // Committed immediately, not left for the arrow-key debounce to persist.
  expect(JSON.parse(storage.read()).width).toBe(RAIL_MIN_WIDTH);

  key(seam, "ArrowLeft");
  expect(shell.hasAttribute("data-pf-key-resizing")).toBe(true);
  key(seam, "End");
  expect(shell.hasAttribute("data-pf-key-resizing")).toBe(false);
});

test("keyboard resize keeps working after the window shrinks", () => {
  const { seam, shell } = setup({ shellWidth: 1600 });
  key(seam, "End");
  expect(railWidth()).toBe("560px");
  // Shell reports narrower now; the remembered 560px no longer fits.
  shell.getBoundingClientRect = () => ({ left: 0, right: 900, width: 900, top: 0, bottom: 720, height: 720 });
  key(seam, "ArrowRight");
  expect(railWidth()).toBe("434px"); // clamped to the new 450px max, then stepped by 16
});

test("arrow keys are no-ops while collapsed; Enter still reopens at the remembered width", () => {
  const { seam, rail } = setup();
  key(seam, "ArrowLeft"); // widen away from the default so reopening is distinguishable from the 240px minimum
  const widened = railWidth();
  key(seam, "Enter");
  expect(railWidth()).toBe("0px");

  key(seam, "ArrowLeft");
  expect(railWidth()).toBe("0px");
  expect(rail.hasAttribute("inert")).toBe(true);
  key(seam, "ArrowRight");
  expect(railWidth()).toBe("0px");
  expect(rail.hasAttribute("inert")).toBe(true);

  key(seam, "Enter");
  expect(railWidth()).toBe(widened);
});

test("modifier-held arrow keys pass through untouched; shift alone still steps", () => {
  const { seam } = setup();
  const before = railWidth();
  key(seam, "ArrowLeft", { metaKey: true });
  expect(railWidth()).toBe(before);
  key(seam, "ArrowLeft", { ctrlKey: true });
  expect(railWidth()).toBe(before);
  key(seam, "ArrowLeft", { altKey: true });
  expect(railWidth()).toBe(before);
  key(seam, "ArrowLeft", { shiftKey: true });
  expect(railWidth()).toBe(`${RAIL_DEFAULT_WIDTH + 64}px`);
});

test("detach restores a toggle to its pre-attach label instead of leaving it wired to 'Show controls'", () => {
  document.body.innerHTML = `
    <div class="pf-shell">
      <div class="pf-stage"></div>
      <div class="pf-rail"></div>
    </div>`;
  const shell = document.querySelector(".pf-shell");
  const rail = document.querySelector(".pf-rail");
  shell.getBoundingClientRect = () => ({ left: 0, right: 1600, width: 1600, top: 0, bottom: 720, height: 720 });
  const toggle = document.createElement("button");
  toggle.textContent = "Controls";
  toggle.title = "Toggle the controls panel";
  document.body.append(toggle);
  const storage = fakeStorage();
  const handle = track(attachRail({ rail, shell, toggle, storage }));

  expect(toggleChevronD(toggle)).toBe(CHEVRON_RAIL_OPEN); // attach took over the content
  expect(toggle.title).toBe("Hide controls");

  handle.detach();
  expect(toggle.textContent).toBe("Controls");
  expect(toggle.querySelector("svg")).toBeNull(); // the icon markup is gone too
  expect(toggle.title).toBe("Toggle the controls panel");
  expect(toggle.getAttribute("aria-expanded")).toBeNull();
  expect(toggle.getAttribute("aria-label")).toBeNull();
  expect(toggle.classList.contains("on")).toBe(false);
});

// --- shared tooltip ----------------------------------------------------
// With mount's tooltip presenter passed in, the toggle's label renders as the
// shared anchored pf-hover-tip (like the viewbar buttons) instead of a native
// title tooltip — and tracks the collapse state across hovers.

function fakeTooltip() {
  const shown = [];
  return {
    shown,
    showAnchor: (content, anchor) => { shown.push({ content, anchor }); return Symbol("t"); },
    showPointer: () => Symbol("t"),
    hide: () => {},
  };
}

test("with a shared tooltip the toggle never gets a native title and shows the presenter's tip", () => {
  document.body.innerHTML = `
    <div class="pf-shell">
      <div class="pf-stage"></div>
      <div class="pf-rail"></div>
    </div>`;
  const shell = document.querySelector(".pf-shell");
  shell.getBoundingClientRect = () => ({ left: 0, right: 1600, width: 1600, top: 0, bottom: 720, height: 720 });
  const toggle = document.createElement("button");
  document.body.append(toggle);
  const tooltip = fakeTooltip();
  track(attachRail({ rail: document.querySelector(".pf-rail"), shell, toggle, storage: fakeStorage(), tooltip }));

  // The label lives in aria-label only; a title would double up as a second,
  // native tooltip alongside the shared one.
  expect(toggle.hasAttribute("title")).toBe(false);
  expect(toggle.getAttribute("aria-label")).toBe("Hide controls");

  toggle.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
  expect(tooltip.shown.at(-1)).toEqual({ content: { title: "Hide controls" }, anchor: toggle });
  toggle.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));

  toggle.click(); // collapse — the next hover must read the NEW label
  expect(toggle.hasAttribute("title")).toBe(false);
  toggle.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
  expect(tooltip.shown.at(-1)).toEqual({ content: { title: "Show controls" }, anchor: toggle });
});

test("detach with a shared tooltip still restores the pre-attach title", () => {
  document.body.innerHTML = `
    <div class="pf-shell">
      <div class="pf-stage"></div>
      <div class="pf-rail"></div>
    </div>`;
  const shell = document.querySelector(".pf-shell");
  shell.getBoundingClientRect = () => ({ left: 0, right: 1600, width: 1600, top: 0, bottom: 720, height: 720 });
  const toggle = document.createElement("button");
  toggle.title = "Toggle the controls panel";
  document.body.append(toggle);
  const handle = track(attachRail({ rail: document.querySelector(".pf-rail"), shell, toggle, storage: fakeStorage(), tooltip: fakeTooltip() }));
  expect(toggle.hasAttribute("title")).toBe(false); // absorbed while attached

  handle.detach();
  expect(toggle.title).toBe("Toggle the controls panel");
  expect(toggle.getAttribute("aria-label")).toBeNull();
});

// --- narrow layout -----------------------------------------------------
// Below RAIL_NARROW_BREAKPOINT the shell shows exactly one pane and the tab
// bar (mobile-tabs.js) picks it, so collapse is suspended: an inert rail
// would land the Controls tab on a dead, invisible pane. The STORED flag
// must survive untouched, because it applies again the instant the window
// widens past the breakpoint.
//
// window.innerWidth is read-only in this vitest+happy-dom setup (matching
// the existing "onPointerDown refuses..." test above), so it takes
// Object.defineProperty rather than a plain assignment — and, unlike the
// shell's zero-size getBoundingClientRect box, nothing resets it between
// tests, so each test restores the original value itself.

test("narrow: a stored collapsed flag does not make the rail inert", () => {
  const original = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { value: 500, configurable: true });
  try {
    document.body.innerHTML = `
      <div class="pf-shell">
        <div class="pf-stage"></div>
        <div class="pf-rail"></div>
      </div>`;
    const shell = document.querySelector(".pf-shell");
    const rail = document.querySelector(".pf-rail");
    shell.getBoundingClientRect = () => ({ left: 0, right: 1600, width: 1600, top: 0, bottom: 720, height: 720 });
    const storage = fakeStorage();
    storage.setItem("partforge:rail", JSON.stringify({ width: 300, collapsed: true }));
    track(attachRail({ rail, shell, storage }));

    expect(rail.hasAttribute("inert")).toBe(false);
    // Nothing is reserved beside the viewer at this width — the rail is
    // either the whole surface or absent — so anything centring itself
    // against the rail must not be offset by a stale width.
    expect(railWidth()).toBe("0px");
  } finally {
    Object.defineProperty(window, "innerWidth", { value: original, configurable: true });
  }
});

test("narrow: the rail toggle is hidden, since the tab bar replaces it", () => {
  const original = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { value: 500, configurable: true });
  try {
    const { toggle } = setup({ withToggle: true });
    expect(toggle.hidden).toBe(true);
  } finally {
    Object.defineProperty(window, "innerWidth", { value: original, configurable: true });
  }
});

test("widening restores the stored collapsed state and the toggle", () => {
  const original = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { value: 500, configurable: true });
  try {
    document.body.innerHTML = `
      <div class="pf-shell">
        <div class="pf-stage"></div>
        <div class="pf-rail"></div>
      </div>`;
    const shell = document.querySelector(".pf-shell");
    const rail = document.querySelector(".pf-rail");
    shell.getBoundingClientRect = () => ({ left: 0, right: 1600, width: 1600, top: 0, bottom: 720, height: 720 });
    const toggle = document.createElement("button");
    document.body.append(toggle);
    const storage = fakeStorage();
    storage.setItem("partforge:rail", JSON.stringify({ width: 300, collapsed: true }));
    track(attachRail({ rail, shell, toggle, storage }));
    expect(rail.hasAttribute("inert")).toBe(false);

    Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
    window.dispatchEvent(new Event("resize"));

    expect(rail.hasAttribute("inert")).toBe(true); // the preference was never lost
    expect(toggle.hidden).toBe(false);
  } finally {
    Object.defineProperty(window, "innerWidth", { value: original, configurable: true });
  }
});

// --- host rail layouts -------------------------------------------------
// A host (partforge-cloud) can lease the rail's placement through
// attachMobileTabs' setRailLayout, which writes data-pf-rail-layout (and, in
// overlay mode, data-pf-rail-open) onto the shell. Both layouts size the rail
// themselves, so width, collapse and the seam are suspended for the duration —
// and in overlay mode the toggle stops being a collapse control and becomes the
// drawer's open/close control. layoutChanged() is how the host tells us the
// attributes moved; it is a plain re-apply, so calling it on a no-change
// notification is safe.

test("overlay: the toggle drives the drawer instead of collapsing the rail", () => {
  const { shell, rail, toggle, storage, handle } = setup({ withToggle: true });
  shell.dataset.pfRailLayout = "overlay";
  handle.layoutChanged();
  handle.layoutChanged(); // a no-change notification must be harmless

  toggle.click();
  expect(shell.hasAttribute("data-pf-rail-open")).toBe(true);
  expect(toggle.getAttribute("aria-expanded")).toBe("true"); // the DRAWER, not the collapse
  expect(toggle.getAttribute("aria-label")).toBe("Hide controls");
  expect(toggleChevronD(toggle)).toBe(CHEVRON_RAIL_OPEN);
  // Collapse is a wide-layout preference the drawer must leave alone.
  expect(rail.hasAttribute("inert")).toBe(false);
  expect(storage.read()).toBeNull();

  toggle.click();
  expect(shell.hasAttribute("data-pf-rail-open")).toBe(false);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggleChevronD(toggle)).toBe(CHEVRON_RAIL_COLLAPSED);
  expect(storage.read()).toBeNull();
});

test("overlay: the toggle stays visible below the narrow breakpoint", () => {
  const original = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { value: 600, configurable: true });
  try {
    const { shell, toggle, handle } = setup({ withToggle: true });
    expect(toggle.hidden).toBe(true); // no host layout: the tab bar replaces it

    shell.dataset.pfRailLayout = "overlay";
    handle.layoutChanged();
    // The host's tab bar is hidden under a layout lease, so this is the only
    // way back to the controls.
    expect(toggle.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  } finally {
    Object.defineProperty(window, "innerWidth", { value: original, configurable: true });
  }
});

test("dock: the toggle hides and the seam refuses to start a drag", () => {
  const { shell, toggle, seam, handle } = setup({ withToggle: true });
  shell.dataset.pfRailLayout = "dock";
  handle.layoutChanged();

  // Collapse is suppressed under a lease, so a visible toggle would be dead.
  expect(toggle.hidden).toBe(true);
  seam.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 10 }));
  expect(shell.hasAttribute("data-pf-dragging")).toBe(false);
});

test("dock keeps the rail's width above the breakpoint and zeroes it below", () => {
  const original = window.innerWidth;
  try {
    const { shell, handle } = setup();
    shell.dataset.pfRailLayout = "dock";
    handle.layoutChanged();
    // Wide dock: the host leases only the bottom inset, so the rail is still
    // side by side with the stage and must keep reserving its width — zeroing
    // it here left the 720-899 band with no controls at all.
    expect(railWidth()).toBe(`${RAIL_DEFAULT_WIDTH}px`);

    Object.defineProperty(window, "innerWidth", { value: 600, configurable: true });
    handle.layoutChanged();
    // Below the breakpoint the rail IS the pane (chrome.css sizes it), so the
    // token must not offset anything that centres against the rail.
    expect(railWidth()).toBe("0px");
  } finally {
    Object.defineProperty(window, "innerWidth", { value: original, configurable: true });
  }
});

test("overlay zeroes the rail's width at any window size", () => {
  const { shell, handle } = setup();
  shell.dataset.pfRailLayout = "overlay";
  handle.layoutChanged();
  // The drawer sizes itself and floats over the stage: it reserves nothing.
  expect(railWidth()).toBe("0px");
});

test("a host layout refuses keyboard resizing and never moves the remembered width", () => {
  const { shell, seam, handle } = setup();
  shell.dataset.pfRailLayout = "overlay";
  handle.layoutChanged();

  key(seam, "ArrowLeft");
  key(seam, "Home");
  expect(railWidth()).toBe("0px");

  delete shell.dataset.pfRailLayout;
  handle.layoutChanged();
  expect(railWidth()).toBe(`${RAIL_DEFAULT_WIDTH}px`);
});

test("a host layout suspends a stored collapse, which comes back when the lease is released", () => {
  const { shell, rail, seam, handle } = setup();
  key(seam, "Enter");
  expect(rail.hasAttribute("inert")).toBe(true);

  shell.dataset.pfRailLayout = "dock";
  handle.layoutChanged();
  expect(rail.hasAttribute("inert")).toBe(false); // a docked rail is always live

  delete shell.dataset.pfRailLayout;
  handle.layoutChanged();
  expect(rail.hasAttribute("inert")).toBe(true); // the preference was never rewritten
});

test("layoutChanged is a callable no-op without a rail", () => {
  const handle = attachRail({});
  expect(() => handle.layoutChanged()).not.toThrow();
  handle.detach();
});

test("detach restores the toggle's original hidden state", () => {
  const original = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { value: 500, configurable: true });
  try {
    document.body.innerHTML = `
      <div class="pf-shell">
        <div class="pf-stage"></div>
        <div class="pf-rail"></div>
      </div>`;
    const shell = document.querySelector(".pf-shell");
    const rail = document.querySelector(".pf-rail");
    shell.getBoundingClientRect = () => ({ left: 0, right: 1600, width: 1600, top: 0, bottom: 720, height: 720 });
    const toggle = document.createElement("button");
    toggle.hidden = false;
    document.body.append(toggle);
    const handle = track(attachRail({ rail, shell, toggle, storage: fakeStorage() }));
    expect(toggle.hidden).toBe(true);
    handle.detach();
    expect(toggle.hidden).toBe(false);
  } finally {
    Object.defineProperty(window, "innerWidth", { value: original, configurable: true });
  }
});

test("reveal(): expands a collapsed rail, opens an overlay drawer, refuses a dock, keeps a narrow collapse", () => {
  const { shell, rail, toggle, storage, handle } = setup({ withToggle: true });
  toggle.click();
  expect(rail.hasAttribute("inert")).toBe(true);
  expect(handle.reveal()).toBe(true);
  expect(rail.hasAttribute("inert")).toBe(false);
  expect(JSON.parse(storage.read()).collapsed).toBe(false);

  shell.dataset.pfRailLayout = "overlay";
  expect(handle.reveal()).toBe(true);
  expect(shell.hasAttribute("data-pf-rail-open")).toBe(true);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");

  shell.dataset.pfRailLayout = "dock";
  shell.removeAttribute("data-pf-rail-open");
  expect(handle.reveal()).toBe(false);
  expect(shell.hasAttribute("data-pf-rail-open")).toBe(false);

  delete shell.dataset.pfRailLayout;
  handle.layoutChanged();
  toggle.click(); // collapse again, then go narrow
  const original = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { value: 600, configurable: true });
  try {
    expect(handle.reveal()).toBe(true); // the pane is mobile-tabs' to show
    expect(JSON.parse(storage.read()).collapsed).toBe(true);
  } finally {
    Object.defineProperty(window, "innerWidth", { value: original, configurable: true });
  }
});
