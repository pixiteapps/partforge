// A part-authored widget in the rail (type: "custom"). The author's `widget`
// function draws whatever it wants into the slot — DOM, SVG, canvas — through
// a small host object; the framework's job is to make that function safe to
// run (a throw lands on a card, never on the panel), to route its writes
// through the ordinary dirty/commit chain, and to keep its transient state
// across the remount every edit performs (getState/panelState).
//
// The widget runs in the panel's own realm: mount() receives the part module
// directly, so `node.widget` is the author's real function, never a clone.
// It must never reach the geometry worker — it does not: only `params` cross.
import { attachInfo } from "../info.js";
import { vectorThumb } from "./vector-thumb.js";
import { isJsonValue, jsonValueProblem } from "../json-value.js";
import { scopedParams } from "../scoped-params.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const SVG_TAGS = new Set([
  "svg", "g", "path", "polygon", "polyline", "circle", "ellipse", "rect", "line", "text", "tspan",
  "use", "defs", "clipPath", "mask", "pattern", "marker", "symbol", "image", "title", "desc",
  "foreignObject", "linearGradient", "radialGradient", "stop",
]);
// `pfc-tree://<path>?v=<stamp>` — the token a `vector` control writes into a
// param when the artwork lives as a file in the part (partforge-cloud's
// treeTokens.js). The stamp is content-addressed and irrelevant here: the
// files map is the tree as of THIS mount.
const TREE_TOKEN_RE = /^pfc-tree:\/\/([^?#]+)(?:[?#].*)?$/i;

const isScalar = (v) => typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
const errorText = (e) => (e && typeof e.message === "string" && e.message) || String(e);
const cloneValue = (v) => (v !== null && typeof v === "object" ? structuredClone(v) : v);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Drop any `type: "custom"` entry (recursively through groups) from a
// sub-control list: a widget inside a widget is refused, one level only.
function stripNested(controls, report) {
  const out = [];
  for (const c of Array.isArray(controls) ? controls : []) {
    if (!c) continue;
    if (c.type === "custom") { report(typeof c.key === "string" ? c.key : "?"); continue; }
    if (c.type === "group") { out.push({ ...c, controls: stripNested(c.controls, report) }); continue; }
    out.push(c);
  }
  return out;
}

export function makeCustom(node, params, { onChange, onCommit, info, custom = {} } = {}) {
  const { files = null, panelState = null, onError, buildSubPanel } = custom;
  const label = node.label ?? node.key;
  const wrap = el("div", "pf-custom");
  if (node.label) {
    const row = el("div", "row");
    const lbl = el("label", "", node.label);
    attachInfo(lbl, node.description, info);
    row.append(lbl);
    wrap.append(row);
  }
  const slot = el("div", "pf-custom-slot");
  wrap.append(slot);

  const ownedKeys = [node.key, ...(Array.isArray(node.keys) ? node.keys.filter((k) => typeof k === "string") : [])];
  const pending = new Set();    // keys set since the last commit
  const subPanels = new Set();  // disposers of open host.controls panels
  let instance = null;
  let retired = false;
  let lastDerived = "{}";

  const report = (phase, message) => onError?.({ key: node.key, label, phase, message });

  // A throw anywhere in widget code: record it, retire the widget for this
  // mount, tear down its sub-panels, and put the card in the slot. Every other
  // control keeps working; the geometry keeps rendering.
  const fail = (phase, e) => {
    if (retired) return;
    retired = true;
    const message = errorText(e);
    report(phase, message);
    for (const d of [...subPanels]) { try { d(); } catch { /* already failing */ } }
    subPanels.clear();
    const card = el("div", "pf-custom-error");
    card.append(el("div", "pf-custom-error-title", `${label}: custom control failed`));
    card.append(el("div", "pf-custom-error-message", message));
    slot.replaceChildren(card);
  };
  const guarded = (phase, fn) => {
    if (retired) return undefined;
    try { return fn(); } catch (e) { fail(phase, e); return undefined; }
  };

  const restoredState = panelState && typeof panelState === "object" && Object.hasOwn(panelState, node.key)
    && panelState[node.key] && typeof panelState[node.key] === "object" && !Array.isArray(panelState[node.key])
    && isJsonValue(panelState[node.key], { maxBytes: Infinity })
    ? structuredClone(panelState[node.key])
    : null;

  const host = {
    el: slot,
    doc: slot.ownerDocument,
    key: node.key,
    state: restoredState ?? {},
    derived: {},
    get disabled() { return wrap.classList.contains("disabled"); },

    get(key = node.key) { return cloneValue(params[key]); },

    set(value, { key = node.key, commit = true } = {}) {
      if (!ownedKeys.includes(key)) {
        throw new TypeError(`custom control "${node.key}" may not write "${key}" — list it in \`keys\``);
      }
      if (key === node.key) {
        const problem = jsonValueProblem(value);
        if (problem) throw new TypeError(`value for "${key}" ${problem}`);
      } else if (!isScalar(value)) {
        throw new TypeError(`value for "${key}" must be a finite number, string or boolean`);
      }
      params[key] = cloneValue(value);
      pending.add(key);
      onChange?.();
      if (commit) host.commit([key]);
    },

    commit(keys = [node.key]) {
      const changed = keys.filter((k) => pending.has(k));
      if (!changed.length) return;
      for (const k of changed) pending.delete(k);
      onCommit?.(changed);
    },

    setState(patch) { Object.assign(host.state, patch); },

    // Element builder: SVG tags get the SVG namespace, `on<event>` attrs
    // become listeners (wrapped: a throw retires the widget), everything else
    // is set verbatim; `true` → a bare attribute, null/undefined/false → omitted.
    h(tag, attrs = {}, ...children) {
      const doc = slot.ownerDocument;
      const elm = SVG_TAGS.has(tag) ? doc.createElementNS(SVG_NS, tag) : doc.createElement(tag);
      for (const [name, v] of Object.entries(attrs ?? {})) {
        if (v === null || v === undefined || v === false) continue;
        if (name.startsWith("on") && typeof v === "function") {
          elm.addEventListener(name.slice(2).toLowerCase(), (ev) => guarded("event", () => v(ev)));
        } else {
          elm.setAttribute(name, v === true ? "" : String(v));
        }
      }
      const append = (c) => {
        if (c === null || c === undefined || c === false) return;
        if (Array.isArray(c)) { c.forEach(append); return; }
        elm.append(typeof c === "object" ? c : doc.createTextNode(String(c)));
      };
      children.forEach(append);
      return elm;
    },

    // An SVG string → its root element (HTML parsing puts `<svg>` in the SVG
    // namespace), or null. No sanitizer: this is the same author's code that
    // already runs here.
    svg(text) {
      if (typeof text !== "string") return null;
      const tpl = slot.ownerDocument.createElement("template");
      tpl.innerHTML = text.trim();
      const root = tpl.content.firstElementChild;
      return root && root.tagName.toLowerCase() === "svg" ? root : null;
    },

    svgFromVector: (doc) => vectorThumb(doc),

    // The text of one of the part's own files, by path or pfc-tree:// token.
    file(pathOrToken) {
      if (!files || typeof pathOrToken !== "string") return null;
      const m = TREE_TOKEN_RE.exec(pathOrToken);
      const path = (m ? m[1] : pathOrToken).replace(/^\.\//, "");
      return Object.hasOwn(files, path) && typeof files[path] === "string" ? files[path] : null;
    },

    // Built-in controls bound INSIDE the owned value (scoped-params.js). One
    // level: a custom control in the list is dropped and reported.
    controls(container, controls, { path = "" } = {}) {
      if (!buildSubPanel || retired) return () => {};
      const stripped = stripNested(controls, (key) =>
        report("create", `custom control "${key}" cannot be nested inside "${node.key}"`));
      const scoped = scopedParams({
        read: () => host.get(),
        write: (next) => host.set(next, { commit: false }),
        path,
        onError: (message) => report("event", message),
      });
      const sub = buildSubPanel(container, stripped, scoped, () => {}, () => host.commit());
      const dispose = () => { subPanels.delete(dispose); sub.dispose(); };
      subPanels.add(dispose);
      return dispose;
    },
  };

  guarded("create", () => {
    if (typeof node.widget !== "function") throw new TypeError("`widget` is not a function");
    const r = node.widget(host);
    instance = r && typeof r === "object" ? r : null;
    if (restoredState) instance?.update?.({ reason: "restore", disabled: host.disabled });
  });

  const update = (reason) => guarded("update", () => instance?.update?.({ reason, disabled: host.disabled }));

  return {
    el: wrap,
    keys: ownedKeys,
    sync: () => update("sync"),
    onDerived: (derived) => {
      const next = derived ?? {};
      const s = JSON.stringify(next);
      host.derived = next;
      if (s === lastDerived) return;
      lastDerived = s;
      update("derived");
    },
    getState: () => host.state,
    dispose: () => {
      for (const d of [...subPanels]) { try { d(); } catch { /* disposing anyway */ } }
      subPanels.clear();
      if (retired) return;
      try { instance?.dispose?.(); } catch (e) { report("dispose", errorText(e)); }
    },
  };
}
