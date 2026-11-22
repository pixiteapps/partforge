// src/framework/compare-view.js
// The reference compare view's controller (spec: partforge-cloud
// docs/superpowers/specs/2026-11-20-reference-compare-view-design.md §2, §5).
//
// When the current view shows a sub-part together with the sub-part its `reference`
// names, and the user hides neither, it asks the worker for the three difference
// solids (jobs.js `compare-generate`) once the build has settled, and hands them to
// the viewer (setCompare), which draws them in place of the pair. One pair per view:
// the first in the part's declaration order.
//
// The job runs WHATEVER the "Show differences" switch says: the switch (and the
// hidden pieces) decide only what is drawn on screen (viewer.setCompareShown). The
// viewer holds the result either way, because the agent's captures always draw the
// comparison (viewer.js withCompareForced): its picture must not depend on a setting
// it cannot see.
//
// It also owns:
//   - the on-stage legend, three chips in the viewbar's readout slot ("Matches",
//     "Missing", "Extra"); Missing and Extra are buttons that hide their piece. It shows
//     only while a comparison is drawn, and yields while another readout (measure's,
//     a handle drag's) is showing in that slot;
//   - the `seam` the view style popover's Parts section reads (parts-list.js): the
//     "Show differences" switch and the three piece rows under the part's row.
//
// Every change to the pair's geometry, pose or view clears the comparison at once
// (the viewer shows the stable ghost meanwhile) and the job runs again after it
// settles; a param the pair does not read changes nothing. A reply is matched by job
// id: anything but the latest is dropped, never drawn over newer geometry. A
// refused comparison (skipped, or the worker's error reply) draws nothing and leaves
// the switch disabled with the reason, until the next change.
//
// Viewer state (getViewerState().compare, handed back as `initial`): whether the
// switch is on and which pieces are hidden. Never saved to the part.
import { viewSubParts } from "./part-model.js";
import { partLabel } from "./export-select.js";
import { createViewbarReadout } from "./viewbar-clear.js";
import { COMPARE_COLORS } from "./compare-colors.js";
import { relevanceHash, subPartParamKeys } from "./param-deps.js";

/** How long a view must rest before the comparison runs (a slider drag shows the ghost). */
export const SETTLE_MS = 180;
const JOB_ID = /^cmp-\d+-\d+$/;
const hex = (n) => `#${n.toString(16).padStart(6, "0")}`;
export const COMPARE_HEX = Object.fromEntries(Object.entries(COMPARE_COLORS).map(([k, v]) => [k, hex(v)]));
/** A compare job with no reply by then is refused (a wedged or reset worker must not
 * hold the controller), and captureReady() gives up waiting on an unsettled build. */
export const JOB_TIMEOUT_MS = 10_000;
const LEGEND = [
  { kind: "common", label: "Matches" },
  { kind: "missing", label: "Missing" },
  { kind: "excess", label: "Extra" },
];
const REFUSED = {
  "too-large": "Differences not available (model too large)",
  "not-closed": "Differences not available (reference is not a closed solid)",
  unsupported: "Differences not available (exact-kernel part)",
};
const REFUSED_ERROR = "Differences not available";
const SWITCH_TEXT = "Show differences";
let builds = 0;

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);

/** The default viewer state, and a defensive read of one that crossed a postMessage. */
function readCompareState(raw) {
  const out = { enabled: true, hidden: { missing: false, excess: false } };
  if (!isObj(raw)) return out;
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (isObj(raw.hidden)) {
    for (const k of ["missing", "excess"]) if (typeof raw.hidden[k] === "boolean") out.hidden[k] = raw.hidden[k];
  }
  return out;
}

export function isDefaultCompareState(s) {
  return s.enabled === true && !s.hidden.missing && !s.hidden.excess;
}

export function createCompareView({ part, viewer, view, params, send, viewbar, initial, settled = () => true, readsOf }) {
  const build = ++builds;
  const start = readCompareState(initial);
  let nextId = 1, disposed = false;
  let enabled = start.enabled;
  const hidden = { ...start.hidden };
  let shownKey = null;   // what the comparison on screen was computed from
  let pendingKey = null; // what the timer or the job in flight is for
  let pendingJob = null, timer = null, jobTimer = null;
  let refusedKey = null, refusal = null; // the change a refusal holds for, and its text
  let pieces = null;     // { common, missing, excess }: true / null, for the one on screen
  let currentPair = null;
  const listeners = new Set();
  const waiters = [];
  viewer.setCompareShown?.(enabled);

  // --- the legend ------------------------------------------------------------------
  const box = viewbar ? createViewbarReadout("div", "pf-compare-legend") : null;
  if (box) {
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", "Differences from the reference");
    viewbar.append(box);
  }
  // Another readout in the slot (measure's parts, a drag's values) wins it.
  const otherReadout = () => !!viewbar && [...viewbar.querySelectorAll(".pf-viewbar-readout")]
    .some((el) => el !== box && !el.hidden);
  function syncLegendHidden() {
    if (!box) return;
    const want = !(pieces && enabled) || otherReadout();
    if (box.hidden !== want) box.hidden = want; // unchanged: no mutation record, no loop
  }
  const observer = viewbar && typeof MutationObserver === "function"
    ? new MutationObserver((records) => { if (records.some((r) => r.target !== box && !box.contains(r.target))) syncLegendHidden(); })
    : null;
  observer?.observe(viewbar, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden"] });

  function chip({ kind, label }) {
    const none = pieces[kind] == null;
    const canHide = kind !== "common" && !none;
    const el = document.createElement(canHide ? "button" : "span");
    el.className = "pf-compare-chip";
    const sw = document.createElement("span");
    sw.className = "pf-compare-swatch";
    sw.style.background = COMPARE_HEX[kind];
    sw.setAttribute("aria-hidden", "true");
    el.append(sw, none && kind !== "common" ? `${label}: none` : label);
    if (canHide) {
      el.type = "button";
      const off = hidden[kind];
      if (off) el.classList.add("off");
      el.setAttribute("aria-pressed", String(!off));
      el.title = off ? `Show ${label.toLowerCase()}` : `Hide ${label.toLowerCase()}`;
      el.addEventListener("click", () => setHidden(kind, !hidden[kind]));
    }
    return el;
  }
  function drawLegend() {
    if (!box) return;
    if (pieces && enabled) box.replaceChildren(...LEGEND.map(chip));
    else box.replaceChildren();
    syncLegendHidden();
  }

  function changed() {
    drawLegend();
    for (const cb of [...listeners]) { try { cb(); } catch { /* listener's problem */ } }
    if (!timer && !pendingJob) for (const w of waiters.splice(0)) w();
  }

  // --- deciding ----------------------------------------------------------------------
  function pair() {
    const shown = new Set(viewSubParts(part, view(), params()));
    const overrides = viewer.getDisplayOverrides?.() ?? {};
    const visible = (n) => shown.has(n) && overrides?.[n]?.hidden !== true;
    for (const name of Object.keys(part.parts)) {
      const ref = part.parts[name].reference;
      if (typeof ref === "string" && ref !== name && part.parts[ref] && visible(name) && visible(ref)) return { name, ref };
    }
    return null;
  }
  // Keyed on the pair's OWN params (each one's recorded reads, its enabled() gate and
  // its place() reads in this view — param-deps.subPartParamKeys, the ladder selection
  // and measure use), never the whole params object: an animation or slider the pair
  // does not read must not clear the comparison every frame. `readsOf` is mount's
  // displayReadsOf; without one the prediction rung answers.
  const keyFor = (p) => {
    const v = view(), ps = params();
    const keys = new Set([
      ...subPartParamKeys(part, v, ps, readsOf, p.name),
      ...subPartParamKeys(part, v, ps, readsOf, p.ref),
    ]);
    return JSON.stringify([v, p.name, p.ref, relevanceHash([...keys], ps)]);
  };

  function stop() {
    clearTimeout(timer); timer = null;
    clearTimeout(jobTimer); jobTimer = null;
    pendingKey = null; pendingJob = null;
  }
  function clearShown() {
    shownKey = null; pieces = null;
    viewer.clearCompare?.();
  }

  function refresh() {
    if (disposed) return;
    const p = pair();
    const pairMoved = currentPair?.name !== p?.name || currentPair?.ref !== p?.ref;
    currentPair = p;
    if (!p) {
      // Nothing to compare: announced only when something changed, since a playing
      // animation re-shows the assembly (and so lands here) every frame.
      const busy = timer || pendingJob || pieces;
      stop(); clearShown();
      refusedKey = null; refusal = null;
      if (busy || pairMoved) changed();
      return;
    }
    const key = keyFor(p);
    if (key === shownKey || key === pendingKey || key === refusedKey) return;
    // Out of date: back to the plain pair (the stable ghost) until the new one lands.
    stop(); clearShown();
    refusedKey = null; refusal = null;
    pendingKey = key;
    arm();
    changed();
  }
  // The job goes out once the view has rested SETTLE_MS and the build has settled
  // (mount: nothing missing, no drag held); until then the timer re-arms.
  function arm() {
    timer = setTimeout(() => {
      timer = null;
      if (disposed) return;
      if (!settled()) { arm(); return; }
      const p = pair();
      if (!p || keyFor(p) !== pendingKey) { pendingKey = null; refresh(); return; }
      pendingJob = `cmp-${build}-${nextId++}`;
      const id = pendingJob;
      jobTimer = setTimeout(() => {
        jobTimer = null;
        if (disposed || pendingJob !== id) return;
        refuse(pendingKey, REFUSED_ERROR);
      }, JOB_TIMEOUT_MS);
      send({ type: "compare-generate", jobId: pendingJob, name: p.name, ref: p.ref, view: view(), params: { ...params() } });
    }, SETTLE_MS);
  }
  // No comparison for this key: drawn as the plain pair, the reason in the switch.
  function refuse(key, text) {
    clearTimeout(jobTimer); jobTimer = null;
    pendingJob = null; pendingKey = null;
    refusedKey = key;
    refusal = text;
    changed();
  }

  // true iff the message is a reply to a compare job (mount's switch then skips it).
  function handleMessage(data) {
    const jobId = data?.jobId;
    if (typeof jobId !== "string" || !JOB_ID.test(jobId)) return false;
    if (disposed || jobId !== pendingJob) return true; // an older job's, or another mount's: dropped
    if (data.type === "progress") return true;
    clearTimeout(jobTimer); jobTimer = null;
    pendingJob = null;
    const key = pendingKey;
    pendingKey = null;
    const p = pair();
    if (!p || keyFor(p) !== key) { refresh(); changed(); return true; }
    if (data.type !== "compare-meshes" || data.skipped || !isObj(data.pieces)) {
      refuse(key, data.type === "compare-meshes" ? REFUSED[data.skipped] ?? REFUSED_ERROR : REFUSED_ERROR);
      return true;
    }
    viewer.setCompare?.({ name: p.name, ref: p.ref, pieces: data.pieces });
    for (const kind of ["missing", "excess"]) viewer.setCompareHidden?.(kind, hidden[kind]);
    pieces = Object.fromEntries(LEGEND.map(({ kind }) => [kind, data.pieces[kind] ? true : null]));
    shownKey = key;
    changed();
    return true;
  }

  function setHidden(kind, flag) {
    if (kind !== "missing" && kind !== "excess") return;
    hidden[kind] = !!flag;
    viewer.setCompareHidden?.(kind, hidden[kind]);
    changed();
  }
  // What is drawn on screen only: the result (or the job for it) is kept either way.
  function setEnabled(on) {
    if (enabled === !!on) return;
    enabled = !!on;
    viewer.setCompareShown?.(enabled);
    changed();
  }

  const offs = [
    viewer.onAssemblyChange?.(refresh) ?? (() => {}),
    viewer.onDisplayChange?.(refresh) ?? (() => {}),
  ];

  // The Parts section's view of this (parts-list.js).
  const seam = {
    state() {
      if (!currentPair) return null;
      const label = partLabel(part, currentPair.name);
      return {
        under: currentPair.name,
        toggle: refusal ? { on: false, disabled: true, text: refusal } : { on: enabled, disabled: false, text: SWITCH_TEXT },
        pieces: pieces && enabled ? [
          { kind: "common", label: "Matches", color: COMPARE_HEX.common, canHide: false, hidden: false, none: false },
          { kind: "missing", label: `Missing from ${label}`, color: COMPARE_HEX.missing, canHide: pieces.missing != null, hidden: hidden.missing, none: pieces.missing == null },
          { kind: "excess", label: `Extra in ${label}`, color: COMPARE_HEX.excess, canHide: pieces.excess != null, hidden: hidden.excess, none: pieces.excess == null },
        ] : null,
      };
    },
    setEnabled,
    setHidden,
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  };

  return {
    handleMessage,
    seam,
    getState: () => ({ enabled, hidden: { ...hidden } }),
    setEnabled,
    /** Re-read the view now (mount calls it on changes the viewer does not announce). */
    refresh,
    /** Resolves once the comparison for the current build has been drawn or refused. */
    // Bounded: a build that never settles resolves it after JOB_TIMEOUT_MS, with no comparison.
    captureReady: () => {
      if (!timer && !pendingJob) return Promise.resolve();
      return new Promise((resolve) => {
        const done = () => { clearTimeout(t); const i = waiters.indexOf(done); if (i >= 0) waiters.splice(i, 1); resolve(); };
        const t = setTimeout(done, JOB_TIMEOUT_MS);
        waiters.push(done);
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      for (const off of offs) { try { off(); } catch { /* gone */ } }
      observer?.disconnect();
      viewer.clearCompare?.();
      box?.remove();
      listeners.clear();
      for (const w of waiters.splice(0)) w();
    },
  };
}
