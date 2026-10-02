// The `type: "font"` control. Its VALUE is a font source — either a source
// string (the same grammar `PartDefinition.fonts` already accepts) or raw
// font bytes (an ArrayBuffer/typed array): the partforge-cloud sandbox cannot
// fetch URLs, so it puts the bytes straight in the param (font-source.js now
// accepts that shape). Everything downstream (presets, undo, the params hash,
// `when`) works with either shape, no special case.
//
// Two renderings, mirroring widgets/image.js. With a host-supplied
// `fontCatalog` it is a button showing the current face IN that face, opening
// the picker. Without one it degrades to a URL text field, so a standalone
// partforge app (which ships no catalog) still exposes the parameter.
//
// Fonts are the "used as-is" kind: the ingest registry's `font` row has
// `convert: null` (a TTF/OTF is validated, never converted), so unlike
// image.js/svg there is no converter to warm up here — see makeFont's own
// note below.
import { attachInfo } from "../info.js";
import { FONT_ALLOW_DEFAULT, fontSourceAllowed } from "../../font-source.js";
import { mountDrop } from "./file-drop.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const isBytes = (v) => v instanceof ArrayBuffer || ArrayBuffer.isView(v);

const WEIGHTS = { 100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium",
                  600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black" };
export const variantLabel = (v) => {
  if (!v) return "Regular";
  const w = String(v).replace(/i$/, ""), italic = /i$/.test(String(v));
  return `${WEIGHTS[w] ?? w}${italic ? " Italic" : ""}`;
};

// A source string → something human. Cloud's fetch_web_font stores files as
// `<family-slug>[-<variant>].ttf`, so the filename round-trips the label for
// free on the vendored path; a bare URL falls back to its filename stem.
export function fontLabel(source) {
  if (typeof source !== "string" || !source) return { family: "—", variant: null };
  let path = source;
  try { path = new URL(source).pathname; } catch { /* not a URL — use the raw string */ }
  const file = path.split("/").filter(Boolean).pop() ?? source;
  const stem = file.replace(/\.(ttf|otf)$/i, "");
  const m = /^(.*)-(\d{3}i?|italic)$/i.exec(stem);
  const slug = m ? m[1] : stem;
  const family = slug.split("-").filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ") || "—";
  return { family, variant: m ? m[2] : null };
}

export function makeFont(node, params, { onChange, onCommit, info, fontCatalog, onAssetUpload } = {}) {
  const allow = Array.isArray(node.allow) && node.allow.length ? node.allow : FONT_ALLOW_DEFAULT;
  const wrap = el("div", "slider");
  const row = el("div", "row");
  const label = el("label", "", node.label ?? node.key);
  attachInfo(label, node.description, info);
  row.append(label);
  wrap.append(row);

  if (!fontCatalog) {
    // Degraded path: a URL field. Unlike `text`, it does NOT write on every
    // keystroke — a half-typed URL is a guaranteed failed fetch, and the
    // rebuild loop would chase every one of them.
    const field = document.createElement("input");
    field.type = "text";
    field.className = "text-input";
    const paintField = () => {
      const v = params[node.key];
      // Bytes cannot round-trip through a text field — `String(arrayBuffer)`
      // is "[object ArrayBuffer]", not a value anyone typed. Show an honest
      // placeholder instead of that, and leave the field free to type a
      // replacement URL over it. Mirrors widgets/image.js's paintField.
      field.value = isBytes(v) ? "" : String(v ?? "");
      field.placeholder = isBytes(v) ? "Uploaded font" : "";
      field.classList.remove("warn");
    };
    field.addEventListener("change", () => {
      if (!fontSourceAllowed(field.value, allow)) { field.classList.add("warn"); return; }
      field.classList.remove("warn");
      params[node.key] = field.value;
      onChange?.();
      onCommit?.();
    });
    paintField();
    // Same opt-in rule as image/vector: the URL box appears only for
    // `sourceField: true`. This branch has no catalog button, so hiding it
    // leaves the drop zone as the way in — which is why THIS branch keeps its
    // labelled drop zone rather than going ambient like the catalog one below.
    if (node.sourceField === true) wrap.append(field);

    const drop = mountDrop("font", {
      params, node, onAssetUpload, onChange, onCommit, onRender: paintField,
    });
    wrap.append(drop.el, drop.errorEl);

    return { el: wrap, sync: paintField, dispose: () => drop.dispose() };
  }

  const btn = el("button", "font-btn");
  btn.type = "button";
  const fname = el("span", "fname");
  const fvar = el("span", "fvar");
  btn.append(fname, fvar);
  btn.insertAdjacentHTML("beforeend",
    '<svg class="caret" width="8" height="7" viewBox="0 0 8 7" aria-hidden="true"><polygon points="0,0 8,0 4,7" fill="currentColor"/></svg>');
  wrap.append(btn);

  // The value alone cannot name a live-picked face: a gstatic filename is a
  // content hash. Ask the catalog first (it holds the reverse lookup), and fall
  // back to the filename — which is right for a vendored `<family>-<variant>.ttf`
  // and merely ugly for a hash. `describe` is optional and may be async, so the
  // label is painted twice: filename immediately, catalog answer when it lands.
  //
  // A byte-valued param (the cloud sandbox path, dropped or uploaded) has no
  // filename to derive a label from — `fontLabel` would print "—" for it, so
  // it is special-cased to an honest "Uploaded font" instead, the same rule
  // widgets/image.js applies for a byte-valued image.
  let paintSeq = 0;
  const paint = () => {
    const src = params[node.key];
    const seq = ++paintSeq;
    const show = ({ family, variant }) => {
      if (seq !== paintSeq) return;                  // a newer paint already won
      fname.textContent = family;
      fvar.textContent = variantLabel(variant);
      fname.style.fontFamily = `"${family}", var(--pf-sans)`;
    };
    show(isBytes(src) ? { family: "Uploaded font", variant: null } : fontLabel(src));
    if (typeof fontCatalog.describe !== "function") return;
    Promise.resolve()
      .then(() => fontCatalog.describe(src))
      .then((d) => { if (d?.family) show(d); })
      .catch(() => { /* a failed lookup keeps the filename label */ });
  };
  paint();

  // The picker registers itself through setFontPicker (see below); with no
  // picker in the bundle the button is inert rather than broken.
  //
  // The handle is kept because the picker is a TAKEOVER: it appends itself to
  // the rail, outside the panel root, so tearing the panel down does not take it
  // with it. Without dispose() the element — and the `document` keydown listener
  // that only close() unhooks — would outlive the panel holding a stale `params`.
  //
  // A picker SESSION is one commit (spec 2026-10-01 §2): every pick rebuilds
  // live through onChange, and the commit — "the user finished", the same
  // split the slider makes on release — fires once, when the picker closes
  // (Done, ×, Escape, a re-open superseding it, or dispose), and only if the
  // value actually moved. A host that persists on commit (partforge-cloud
  // vendors and saves) then pays once per session instead of once per pick.
  let picker = null;
  btn.addEventListener("click", () => {
    const atOpen = params[node.key];
    picker = openFontPicker?.({
      node, params, allow, fontCatalog, anchor: wrap,
      onPicked: () => { paint(); onChange?.(); },
      onClose: () => { picker = null; if (params[node.key] !== atOpen) onCommit?.(); },
    }) ?? null;
  });

  // Ambient: this branch already has the catalog button as its visible way in, so
  // the drop covers the control invisibly and reveals itself only while a file is
  // over it. The no-catalog branch above stays labelled — there, the drop zone is
  // the only affordance and hiding it would strand the user.
  const drop = mountDrop("font", { params, node, onAssetUpload, onChange, onCommit, onRender: paint, ambient: true });
  wrap.append(drop.el, drop.errorEl);

  return {
    el: wrap,
    sync: paint,
    dispose: () => { picker?.close(); picker = null; drop.dispose(); },
  };
}

// Assigned by font-picker.js, which widgets/index.js imports for the side
// effect. Kept
// as a mutable binding rather than a static import so this file stays usable —
// and testable — without dragging the whole picker in.
export let openFontPicker = null;
export const setFontPicker = (fn) => { openFontPicker = fn; };
