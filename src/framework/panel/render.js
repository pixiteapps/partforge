// The DOM binder. Builds elements from the render tree, then applies whatever
// panel-state.js decided. Everything about WHAT to show lives in the model and
// state modules; this file only knows how to put it on screen.
import { desugar } from "./legacy.js";
import { buildTree, controlNodes } from "./model.js";
import { computeState } from "./panel-state.js";
import { WIDGET_FACTORIES } from "./widgets/index.js";
import { makeReadout } from "./widgets/readout.js";
import { createInfoPopover, attachInfo } from "./info.js";
import { isJsonValue } from "./json-value.js";

// The budget every custom control's transient state shares (getState below).
export const PANEL_STATE_MAX_BYTES = 65536;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Map every node id (groups and leaves alike) to its node, for the reveal
// re-sync in applyState below.
function indexNodes(nodes, map) {
  for (const node of nodes ?? []) {
    map.set(node.id, node);
    if (node.kind === "group") indexNodes(node.children, map);
  }
}

export function buildControls(root, parameters, params, onDirty, onCommit, opts = {}) {
  const info = createInfoPopover();
  const tree = buildTree(desugar(parameters));

  const nodeEls = new Map();      // id -> the element whose visibility we toggle
  const displayUpdates = new Map(); // id -> a display widget's update(derived)
  const groupIds = new Set();     // ids that are group/section wrappers, never controls
  const syncFns = [];             // { key, sync } for every widget
  const rawSyncs = new Map();     // sectionId -> [{ key, sync }] for preset application
  const widgetSyncs = new Map();  // id -> the RAW widget sync (no markCustom)
  const disposers = [];           // widget teardown — a font picker lives OUTSIDE root
  const nodeById = new Map();     // id -> node, for the reveal re-sync
  const lastVisible = new Map();  // id -> previous `visible`, to detect a reveal
  const lastDisabled = new Map(); // id -> previous `disabled`, to skip a no-op input pass
  const keyToId = new Map();      // param key -> node id, for revealParam
  // Containers that own a disclosure: sections, and titled inner groups (the
  // legacy "Advanced" fold). Both share the same anatomy — a header row with
  // the aria-carrying button and a text-free chevron span — so `el` (the
  // section element / the fold wrapper) mirrors the disclosure with a
  // `.collapsed` class and CSS draws the closed-band affordance off that.
  const disclosures = new Map(); // id -> { body, button, el }
  indexNodes(tree, nodeById);
  let relevant = null;

  const panelErrors = [];         // {key, label, phase, message} from custom controls
  const customWidgets = new Map(); // param key -> { label, getState } for custom controls
  // What a custom control's host reaches back into the panel for: the part's
  // own files (host.file), the state a previous mount left (host.state), the
  // error sink, and the sub-panel builder — a re-entry into buildControls with
  // a scoped params view and no section header (opts.bare, Task 5).
  const customCtx = {
    files: opts.files ?? null,
    panelState: opts.panelState ?? null,
    onError: (e) => { panelErrors.push(e); opts.onPanelError?.(e); },
    buildSubPanel: (container, controls, scoped, onSubDirty, onSubCommit) =>
      buildControls(container, [{ controls }], scoped, onSubDirty, onSubCommit,
        { ...opts, bare: true, panelState: null, onPanelError: customCtx.onError }),
  };

  // Re-apply state after any change that could flip a condition. This is what
  // reproduces the legacy feature behavior generically: ticking a feature's
  // checkbox now simply makes its group's condition true. It also re-syncs any
  // subtree that just went from hidden to visible, so a just-revealed slider
  // shows the freshly-written value instead of a stale one (legacy
  // controls.js ran `syncs.forEach((s) => s())` on a feature tick).
  // The FIRST computed state decides which sections/folds start open, per the
  // auto-open rule and any explicit `collapsed`. After that, the user's own
  // clicks own it — re-running this on every param change would otherwise
  // snap a section the user opened shut on the next slider drag.
  let openApplied = false;
  const applyOpenState = (state) => {
    if (openApplied) return;
    openApplied = true;
    for (const [id, d] of disclosures) {
      const open = state.get(id)?.open ?? true;
      d.body.classList.toggle("hidden", !open);
      d.button.setAttribute("aria-expanded", String(open));
      d.el.classList.toggle("collapsed", !open);
    }
  };

  const applyState = () => {
    const state = computeState(tree, { params, relevant });
    applyOpenState(state);
    for (const [id, node] of nodeEls) {
      const s = state.get(id);
      if (!s) continue;
      const isGroup = groupIds.has(id);
      node.classList.toggle("hidden", !s.visible);
      node.classList.toggle("section-hidden", !!s.dimmedSection);
      node.classList.toggle("irrelevant", !isGroup && s.dimmed && !s.dimmedSection);
      node.classList.toggle("disabled", s.disabled);
      // Only a control leaf's own inputs get `.disabled` written. `disabled`
      // already propagates through the whole subtree in computeState, so a
      // group never needs to (and must not) walk its descendants here — doing
      // so made the outcome depend on `nodeEls` insertion order, which differs
      // between a bare group/section (registers before its children) and a
      // titled group (registers after, via its wrapper). Skipping the query
      // entirely when `disabled` hasn't changed also keeps this off the hot
      // path (applyState runs on every slider drag and relevance update).
      if (!isGroup && lastDisabled.get(id) !== s.disabled) {
        if (node.matches?.("input, select, textarea")) node.disabled = s.disabled;
        // `.seg button` is in the list for the radio widget, whose options are
        // <button>s: without it a disabled radio stayed keyboard-focusable and
        // only LOOKED disabled. Scoped to `.seg` rather than every button so a
        // disabled control's ⓘ glyph stays reachable — the popover is where the
        // author explains what has to be enabled first, which is exactly what
        // the reader wants here. (Group nodes skip this branch entirely, so the
        // section and fold disclosure buttons are never touched either way.)
        for (const input of node.querySelectorAll("input, select, textarea, .seg button")) {
          input.disabled = s.disabled;
        }
        lastDisabled.set(id, s.disabled);
      }
      if (!isGroup && s.dimmed && !s.dimmedSection) node.title = "Doesn't affect the parts in the current view";
      else node.removeAttribute("title");

      const wasVisible = lastVisible.get(id);
      if (wasVisible === false && s.visible) {
        for (const c of controlNodes([nodeById.get(id)])) widgetSyncs.get(c.id)?.();
      }
      lastVisible.set(id, s.visible);
    }
  };

  const onEdit = () => { applyState(); onDirty?.(); };

  // A commit = the user FINISHED an interaction (slider released, box
  // committed, checkbox ticked, preset applied). Distinct from onDirty, which
  // fires on every input event mid-drag. Wrapped: a throwing host handler
  // must never break the panel.
  const commit = (keys) => {
    if (!onCommit) return;
    try { onCommit(keys); } catch { /* host's problem, not the panel's */ }
  };

  // --- build ---------------------------------------------------------------
  //
  // TWO DIFFERENT THINGS USE `.hidden`, and conflating them is a real bug:
  // conditions hide a node, and a disclosure closes a fold. `applyState` runs on
  // every param change (mount.js:510), so if it toggled `.hidden` on the fold
  // body, every slider drag would re-open a fold the user had closed.
  //
  // So: a titled group gets a WRAPPER. Conditions toggle the wrapper; the
  // disclosure toggles the body inside it. A bare group has no fold, so it keeps
  // the legacy `.feat-group.hidden` markup exactly and conditions own it.
  function renderGroup(node, container, sectionCtx) {
    groupIds.add(node.id);

    if (node.bare) {
      const box = el("div", "feat-group");
      nodeEls.set(node.id, box);
      for (const child of node.children) renderNode(child, box, sectionCtx);
      container.append(box);
      return;
    }

    const wrap = el("div", "adv-wrap");
    const body = el("div", "adv hidden");   // starts closed — legacy parity
    body.id = `pf-fold-${node.id.replaceAll("/", "-")}`;
    // Same row anatomy as a section header — title button (text-free of any
    // arrow, same exact-textContent reasoning), chevron span on the right,
    // whole row clickable — at the fold's subordinate scale.
    const foldHeader = el("div", "adv-header");
    const toggle = el("button", "adv-toggle");
    toggle.type = "button";
    toggle.append(el("span", "adv-name", node.title));
    toggle.setAttribute("aria-controls", body.id);
    foldHeader.append(toggle, el("span", "chev"));
    foldHeader.addEventListener("click", () => {
      const nowHidden = body.classList.toggle("hidden");
      toggle.setAttribute("aria-expanded", String(!nowHidden));
      wrap.classList.toggle("collapsed", nowHidden);
    });
    for (const child of node.children) renderNode(child, body, sectionCtx);
    wrap.append(foldHeader, body);
    nodeEls.set(node.id, wrap);             // conditions act on the wrapper
    disclosures.set(node.id, { body, button: toggle, el: wrap });
    container.append(wrap);
  }

  // The preset picker. Applying a preset overwrites its keys and refreshes the
  // section's controls through their RAW syncs — a preset application must not
  // mark itself Custom (controls.test.js:366).
  function renderPreset(node, container, sectionCtx) {
    if (node.label) {
      const row = el("div", "row");
      row.append(el("label", "", node.label));
      container.append(row);
    }
    const names = Object.keys(node.presets);
    const select = document.createElement("select");
    select.className = "preset";
    for (const name of [...names, "Custom"]) {
      const o = document.createElement("option");
      o.value = name; o.textContent = name; select.append(o);
    }
    select.value = names[0];
    select.addEventListener("change", () => {
      const bundle = node.presets[select.value];
      if (!bundle) return; // "Custom"
      Object.assign(params, bundle);
      for (const { key, sync } of rawSyncs.get(sectionCtx.id)) if (key in params) sync();
      onEdit();
      commit(Object.keys(bundle));
    });
    // The section's controls need a handle on the picker to drop it to Custom
    // when one of them is edited. First picker in the section wins.
    if (sectionCtx && !sectionCtx.preset) sectionCtx.preset = select;
    nodeEls.set(node.id, select);
    container.append(select);
  }

  function renderNode(node, container, sectionCtx) {
    if (node.kind === "group") { renderGroup(node, container, sectionCtx); return; }
    if (node.kind === "preset") { renderPreset(node, container, sectionCtx); return; }
    if (node.kind === "display") {
      const widget = makeReadout(node, { info });
      nodeEls.set(node.id, widget.el);
      displayUpdates.set(node.id, widget.update);
      container.append(widget.el);
      return;
    }

    const factory = WIDGET_FACTORIES[node.type];
    if (!factory) return; // unknown type: lint reports it; the panel skips it

    // Editing a control in a preset section diverges from the preset, so the
    // picker falls back to Custom (controls.js:296). A feature's own slider and a
    // toggle do NOT — `marksCustom` is false for them.
    const markCustom = () => {
      if (node.marksCustom && sectionCtx?.preset) sectionCtx.preset.value = "Custom";
    };
    const widget = factory(node, params, {
      onChange: () => { markCustom(); onEdit(); },
      // A factory may name the keys it committed (custom controls own several);
      // the built-ins call onCommit() bare and get their own key, as before.
      onCommit: (keys) => commit(Array.isArray(keys) && keys.length ? keys : [node.key]),
      info,
      fontCatalog: opts.fontCatalog,
      imageCatalog: opts.imageCatalog,
      onAssetUpload: opts.onAssetUpload,
      declaredSource: opts.declaredSource,
      custom: customCtx,
    });
    nodeEls.set(node.id, widget.el);
    if (node.key && !keyToId.has(node.key)) keyToId.set(node.key, node.id);
    widgetSyncs.set(node.id, widget.sync);
    if (widget.dispose) disposers.push(widget.dispose);
    // A custom control reads derive() output like a readout does, and keeps
    // transient state the host may carry across a remount.
    if (typeof widget.onDerived === "function") displayUpdates.set(node.id, widget.onDerived);
    if (typeof widget.getState === "function" && node.key) {
      customWidgets.set(node.key, { label: node.label ?? node.key, getState: widget.getState });
    }
    container.append(widget.el);

    // The raw sync is what a PRESET application uses — it must not mark itself
    // Custom (controls.test.js:366). The registered sync is what an external
    // syncValues() uses, and for a preset-section control it does drop the
    // picker to Custom (controls.test.js:350), because a programmatic edit
    // diverges from the preset exactly as a user edit does. A widget that owns
    // several keys (custom's `keys`) registers under each of them.
    if (sectionCtx) rawSyncs.get(sectionCtx.id).push({ key: node.key, sync: widget.sync });
    const ownedKeys = Array.isArray(widget.keys) && widget.keys.length ? widget.keys : [node.key];
    for (const key of ownedKeys) {
      syncFns.push({ key, sync: () => { widget.sync(); markCustom(); } });
    }
  }

  for (const section of tree) {
    groupIds.add(section.id);
    const secEl = el("div", "section");
    nodeEls.set(section.id, secEl);

    const header = el("div", "sec-header");
    const title = el("button", "sec-title");
    title.type = "button";
    // The chev span carries NO text — its glyph comes from CSS (::before) —
    // because sectionByTitle-style lookups match `.sec-title` by exact
    // textContent === title (controls.test.js:210), and a text chevron here
    // would break that match.
    title.append(el("span", "sec-name", section.title ?? ""));
    header.append(title);
    // Row order: title (flex:1), then ⓘ, then the chevron on the far right.
    // The ⓘ is a SIBLING of the button, never a child: attachInfo appends a
    // <button>, and a button nested in a button is invalid HTML that never
    // receives clicks.
    attachInfo(header, section.description, info);
    header.append(el("span", "chev"));
    secEl.append(header);

    const body = el("div", "sec-body");
    body.id = `pf-sec-${section.id.replaceAll("/", "-")}`;
    title.setAttribute("aria-controls", body.id);
    secEl.append(body);

    // The whole header row toggles: the title button's own click bubbles up
    // here, the chevron and the empty row space hit it directly, and the ⓘ
    // stops propagation in attachInfo. aria state stays on the title button.
    header.addEventListener("click", () => {
      const nowHidden = body.classList.toggle("hidden");
      title.setAttribute("aria-expanded", String(!nowHidden));
      secEl.classList.toggle("collapsed", nowHidden);
    });
    disclosures.set(section.id, { body, button: title, el: secEl });

    // `preset` is filled in when a preset node renders. Controls read it late, so
    // one appearing after them in the children array still works.
    const ctx = { id: section.id, preset: null };
    rawSyncs.set(section.id, []);

    for (const child of section.children) renderNode(child, body, ctx);
    root.append(secEl);
  }

  applyState();

  // The single entry point for a param change: relevance dims/undims controls,
  // derived pushes fresh values into every readout. Either argument may be
  // omitted (mount.js's initial call, or a syncValues-only path) — only what's
  // passed updates. `applyRelevance` is the old name, kept as a thin delegate
  // so existing callers (and mount.test.js) don't have to change.
  const refresh = ({ relevant: nextRelevant, derived } = {}) => {
    if (nextRelevant !== undefined) relevant = nextRelevant;
    if (derived !== undefined) {
      for (const update of displayUpdates.values()) update(derived);
    }
    applyState();
  };

  return {
    refresh,
    applyRelevance: (next) => refresh({ relevant: next }),
    syncValues: (keys) => {
      const only = keys && new Set(keys);
      for (const { key, sync } of syncFns) if (!only || only.has(key)) sync();
      applyState();
    },
    // Measurement mode's dimension->control link: open whatever encloses the
    // control, bring it on screen, hand it keyboard focus, and pulse the flash
    // so the eye lands on it. DOM-containment (not tree walking) finds the
    // enclosing disclosures, so section vs fold nesting needs no special case.
    revealParam(key) {
      return this.revealParams([key], key);
    },
    // Multi-control reveal: a measurement is usually a FUNCTION of several
    // params, so clicking one flashes every control that can drive it.
    // `focusKey` (when given and present) is the one whose value exactly
    // matches the clicked dimension — it gets keyboard focus; otherwise the
    // first flashed control is only scrolled to, no focus steal.
    revealParams(keys, focusKey = null) {
      const targets = [];
      for (const key of keys) {
        const id = keyToId.get(key);
        const el = id && nodeEls.get(id);
        if (el) targets.push([key, el]);
      }
      if (!targets.length) return false;
      for (const [, target] of targets) {
        for (const [, d] of disclosures) {
          if (!d.body.contains(target) || !d.body.classList.contains("hidden")) continue;
          d.body.classList.remove("hidden");
          d.button.setAttribute("aria-expanded", "true");
          d.el.classList.remove("collapsed");
        }
        target.classList.remove("pf-param-flash");
        void target.offsetWidth; // restart the animation on repeat reveals
        target.classList.add("pf-param-flash");
        target.addEventListener("animationend", () => target.classList.remove("pf-param-flash"), { once: true });
      }
      const [primaryKey, primary] = targets.find(([k]) => k === focusKey) ?? targets[0];
      primary.scrollIntoView?.({ block: "center" });
      if (primaryKey === focusKey) {
        primary.querySelector("input, select, textarea, .seg button")?.focus({ preventScroll: true });
      }
      return true;
    },
    // What custom controls reported failing this mount, in order. A host that
    // remounts per edit (partforge-cloud) reads this after mount and hands it
    // to the agent beside the build's own warnings.
    errors: () => panelErrors.map((e) => ({ ...e })),
    // Every custom control's non-empty transient state, keyed by param, as
    // plain JSON — hand it back as mount({ panelState }) so a selection survives
    // the remount an edit performs. One shared budget: a state that would push
    // the total past it is dropped and recorded (phase "state") rather than
    // silently lost.
    getState: () => {
      const out = {};
      let budget = PANEL_STATE_MAX_BYTES;
      for (const [key, w] of customWidgets) {
        const state = w.getState();
        if (!state || typeof state !== "object" || Object.keys(state).length === 0) continue;
        if (!isJsonValue(state, { maxBytes: Infinity })) {
          customCtx.onError({ key, label: w.label, phase: "state", message: "panel state is not a JSON value; dropped" });
          continue;
        }
        const size = new TextEncoder().encode(JSON.stringify(state)).length;
        if (size > budget) {
          customCtx.onError({ key, label: w.label, phase: "state", message: `panel state (${size} bytes) exceeds the ${PANEL_STATE_MAX_BYTES}-byte budget; dropped` });
          continue;
        }
        budget -= size;
        out[key] = structuredClone(state);
      }
      return out;
    },
    // replaceChildren() only reaches what is INSIDE root; a widget that parked
    // DOM (or a document-level listener) elsewhere has to be told to let go.
    dispose: () => { info.dispose(); for (const d of disposers) d(); root.replaceChildren(); },
  };
}
