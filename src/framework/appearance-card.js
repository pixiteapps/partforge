// src/framework/appearance-card.js
// The appearance card: the popover's second page, for one sub-part. Header
// (Back, label, eye, close), See-through, the material tiles, the colour row,
// the finish sliders, and a footer that says where a change goes. Every write
// is one parts.setDisplay(name, patch); the card re-renders from parts.getState
// on the change event, so what it shows is always the viewer's answer.
import { PRESETS } from "./materials/presets.js";
import { OVERRIDE_RANGES } from "./materials/resolve.js";
import { MIN_USER_OPACITY } from "./materials/overrides.js";
import { hexColor } from "./parts-list.js";

const COLORS = ["#b3261e", "#e8711a", "#e3b31c", "#2e8b57", "#1f5bd6", "#6f42c1", "#f2f2f0", "#8c8c90", "#1f1f22"];
const FINISH = [
  ["roughness", "Roughness"], ["metalness", "Metalness"], ["clearcoat", "Clearcoat"],
  ["clearcoatRoughness", "Clearcoat roughness"], ["anisotropy", "Anisotropy"], ["textureScale", "Texture scale"],
];
const FOOT = {
  "saved": { note: "Material and colour are saved to this forge. See-through and hiding are only on this screen.", reset: "Reset to authored" },
  "screen-only": { note: "", reset: "Reset" },
  "blocked": { note: "This part's look is set by code. Ask the assistant to change it.", reset: "Reset" },
};
const ICONS = {
  back: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>`,
  close: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
  eye: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>`,
  eyeOff: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>`,
};
// Texture scale spans 0.01–1000 mm, five decades: a linear slider over that puts
// ~4 mm under each pixel and cannot land on the print presets' 0.2 mm. The
// slider moves a POSITION in [0, 1] instead, mapped logarithmically onto
// OVERRIDE_RANGES.textureScale; values are clamped to the range both ways.
const [TS_LO, TS_HI] = OVERRIDE_RANGES.textureScale;
const clampTs = (v) => Math.min(TS_HI, Math.max(TS_LO, v));
export function textureScaleToPos(value) {
  const v = Number.isFinite(value) ? clampTs(value) : TS_LO;
  return Math.log(v / TS_LO) / Math.log(TS_HI / TS_LO);
}
export function posToTextureScale(pos) {
  const p = Number.isFinite(pos) ? Math.min(1, Math.max(0, pos)) : 0;
  return clampTs(TS_LO * (TS_HI / TS_LO) ** p);
}
// Sensible precision for a millimetre scale: 0.2 mm, 4.8 mm, 48 mm, 250 mm.
function formatTextureScale(v) {
  const digits = v < 1 ? 2 : v < 10 ? 1 : 0;
  return `${Number(v.toFixed(digits))} mm`;
}
// The tiles' repaint is a pass over ~25 spheres, one per frame; a dragged colour
// well re-renders the card every frame, so repaints are held to one per this
// many milliseconds (leading edge, plus one trailing pass for the last state).
const REPAINT_MS = 150;

const parseHex = (s) => (/^#?[0-9a-f]{6}$/i.test(String(s).trim()) ? parseInt(String(s).trim().replace("#", ""), 16) : null);
const known = (m) => typeof m === "string" && Object.hasOwn(PRESETS, m);

// Leading-edge, once-per-frame write. The viewer rebuilds the sub-part's
// material on every appearance write, so a dragged slider or colour well must
// not write on every input event: the first event in a frame writes at once,
// later ones in the same frame keep only their latest value, which is written
// when the frame ends. requestAnimationFrame where there is one; a 16ms timer
// otherwise (a test DOM, a worker-less host).
const hasRaf = () => typeof requestAnimationFrame === "function";
const nextFrame = () => new Promise((res) => (hasRaf() ? requestAnimationFrame(() => res()) : setTimeout(res, 16)));
function frameThrottle(fn) {
  const raf = hasRaf() ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
  const caf = typeof cancelAnimationFrame === "function" && hasRaf() ? cancelAnimationFrame : clearTimeout;
  let handle = null;
  let pending = null; // [args] waiting for the frame's end, or null
  const tick = () => {
    handle = null;
    if (!pending) return;
    const args = pending; pending = null;
    fn(...args);
    handle = raf(tick); // this write opened a new frame of its own
  };
  const call = (...args) => {
    if (handle === null) { fn(...args); handle = raf(tick); } else pending = args;
  };
  call.cancel = () => { if (handle !== null) caf(handle); handle = null; pending = null; };
  return call;
}

function el(tag, className, attrs = {}) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

// `renderThumb(materialId, display) -> Promise<dataUrl|null>` (Task 7) paints a
// sphere into a tile; absent, tiles stay flat discs in the preset colour.
// `onBack(name)` gets the name the card was showing, so the host can put focus
// back on that row; `onGone(name)` fires when a re-render finds the part gone
// (dropped by a rebuild), so the host can leave the card for the list.
export function attachAppearanceCard(parts, { onBack, onClose, onGone, getSaveState, renderThumb = null } = {}) {
  const root = el("div", "pf-card");
  let name = null;
  let row = null;

  // --- static skeleton (rebuilt values only on render) ---
  const head = el("div", "pf-card-head");
  const back = el("button", "pf-card-back", { type: "button", "aria-label": "Back to parts" }); back.innerHTML = ICONS.back;
  const title = el("span", "pf-card-title");
  const eye = el("button", "pf-card-eye", { type: "button" });
  const close = el("button", "pf-card-close", { type: "button", "aria-label": "Close" }); close.innerHTML = ICONS.close;
  head.append(back, title, eye, close);

  const seeRow = el("label", "pf-card-row");
  const seeLab = el("span", "pf-card-lab"); seeLab.textContent = "See-through";
  const seeVal = el("span", "pf-card-val");
  const see = el("input", "pf-card-seethrough", { type: "range", min: String(Math.round(MIN_USER_OPACITY * 100)), max: "100", step: "1", "aria-label": "See-through" });
  seeRow.append(seeLab, seeVal, see);

  const matHead = el("div", "pf-card-lab-row");
  const matLab = el("span", "pf-card-lab"); matLab.textContent = "Material";
  const matVal = el("span", "pf-card-val");
  matHead.append(matLab, matVal);
  const tiles = el("div", "pf-card-tiles", { role: "group", "aria-label": "Material" });
  const tileFor = (id, label, color) => {
    const t = el("button", "pf-card-tile", { type: "button", "data-material": id, "aria-pressed": "false", title: label });
    const ball = el("span", "pf-card-ball"); ball.style.setProperty("--pf-swatch", hexColor(color));
    const img = el("img", "", { alt: "" }); img.hidden = true; ball.append(img);
    const lab = el("span", "pf-card-tile-label"); lab.textContent = label;
    t.append(ball, lab);
    return t;
  };
  // One tile per preset. There is no "no material" tile: in the realistic
  // view a part with no material looks like plain matte in its colour, which
  // nothing on screen can tell from a neighbouring preset, so the tile read as
  // dead. A part with no (or an unknown) material presses nothing; Reset is
  // the way back to the authored look.
  tiles.append(...Object.values(PRESETS).map((p) => tileFor(p.id, p.label, p.color)));
  const unknown = el("p", "pf-card-unknown"); unknown.hidden = true;

  const colHead = el("div", "pf-card-lab-row");
  const colLab = el("span", "pf-card-lab"); colLab.textContent = "Colour";
  const colVal = el("span", "pf-card-val");
  colHead.append(colLab, colVal);
  const colors = el("div", "pf-card-colors");
  for (const c of COLORS) {
    const b = el("button", "pf-card-color", { type: "button", "data-color": c, title: c, "aria-label": c });
    b.style.setProperty("--pf-swatch", c);
    colors.append(b);
  }
  const native = el("input", "pf-card-native", { type: "color", "aria-label": "Custom colour" });
  colors.append(native);
  const hexRow = el("div", "pf-card-hexrow");
  const hex = el("input", "pf-card-hex", { type: "text", "aria-label": "Hex colour", spellcheck: "false", maxlength: "7" });
  hexRow.append(hex);
  const tintNote = el("p", "pf-card-tint-note"); tintNote.hidden = true;

  const finish = el("details", "pf-card-finish-group");
  const summary = el("summary"); summary.textContent = "Finish";
  finish.append(summary);
  const finishInputs = new Map();
  // Each throttle is bound to the part it was started for, so a write still
  // pending when the card switches part lands on the part it was meant for.
  const writeFinish = frameThrottle((who, patch) => parts.setDisplay(who, patch));
  for (const [key, label] of FINISH) {
    const [lo, hi] = OVERRIDE_RANGES[key];
    const r = el("label", "pf-card-row");
    const lab = el("span", "pf-card-lab"); lab.textContent = label;
    const val = el("span", "pf-card-val");
    // Texture scale's range input holds a log POSITION (textureScaleToPos), not mm.
    const logScale = key === "textureScale";
    const input = el("input", "pf-card-finish", logScale
      ? { type: "range", "data-key": key, min: "0", max: "1", step: "0.001", "aria-label": label }
      : { type: "range", "data-key": key, min: String(lo), max: String(hi), step: "0.01", "aria-label": label });
    r.append(lab, val, input);
    finish.append(r);
    finishInputs.set(key, { input, val });
    input.addEventListener("input", () => {
      const raw = Number(input.value);
      if (!name || !Number.isFinite(raw)) return;
      const v = logScale ? posToTextureScale(raw) : raw;
      writeFinish(name, { [key]: Math.min(hi, Math.max(lo, v)) });
    });
  }

  const foot = el("div", "pf-card-foot");
  const note = el("span", "pf-card-foot-note");
  const reset = el("button", "pf-card-reset", { type: "button" });
  foot.append(note, reset);

  root.append(head, seeRow, matHead, tiles, unknown, colHead, colors, hexRow, tintNote, finish, foot);

  // --- wiring ---
  back.addEventListener("click", () => onBack?.(name));
  close.addEventListener("click", () => onClose?.());
  eye.addEventListener("click", () => { if (name && row) parts.setDisplay(name, { hidden: !row.hidden }); });
  // See-through rebuilds the fade clone on every write, like the finish sliders:
  // once per frame, the first event at once.
  const writeSee = frameThrottle((who, patch) => parts.setDisplay(who, patch));
  see.addEventListener("input", () => {
    if (!name) return;
    const v = Number(see.value) / 100;
    writeSee(name, { opacity: v >= 1 ? null : v });
  });
  tiles.addEventListener("click", (e) => {
    const t = e.target.closest(".pf-card-tile");
    if (!t || !name) return;
    const id = t.dataset.material;
    // An untintable preset draws its own colour, and the card disables the
    // colour row under it — so a colour the USER set would be stranded there
    // (drawn as red brass, with nothing but Reset to clear it). Picking one
    // clears the override colour. An authored colour is source and persists.
    const ownColor = known(id) && !PRESETS[id].tintable && typeof parts.getState(name)?.override?.color === "number";
    parts.setDisplay(name, ownColor ? { material: id, color: null } : { material: id });
  });
  colors.addEventListener("click", (e) => {
    const b = e.target.closest(".pf-card-color");
    if (!b || !name) return;
    parts.setDisplay(name, { color: parseHex(b.dataset.color) });
  });
  const writeNative = frameThrottle((who, patch) => parts.setDisplay(who, patch));
  native.addEventListener("input", () => { const c = parseHex(native.value); if (name && c !== null) writeNative(name, { color: c }); });
  hex.addEventListener("change", () => { const c = parseHex(hex.value); if (name && c !== null) parts.setDisplay(name, { color: c }); else render(); });
  reset.addEventListener("click", () => { if (name) parts.clear({ appearance: true, name }); });

  function render() {
    if (!name) return;
    row = parts.list().find((r) => r.name === name) ?? null;
    const state = parts.getState(name);
    if (!row || !state) {
      // The part went away under the card (a rebuild dropped it): there is
      // nothing left to show, so hand the page back rather than leave a card
      // for a part that no longer exists.
      const gone = name;
      name = null; row = null; thumbToken++; cancelRepaint();
      onGone?.(gone);
      return;
    }
    title.textContent = row.label;
    eye.innerHTML = row.hidden ? ICONS.eyeOff : ICONS.eye;
    eye.setAttribute("aria-pressed", String(row.hidden));
    eye.setAttribute("aria-label", `${row.hidden ? "Show" : "Hide"} ${row.label}`);
    eye.title = eye.getAttribute("aria-label");
    const pct = Math.round(row.opacity * 100);
    see.value = String(pct); seeVal.textContent = `${pct}%`;
    const m = state.effective.material;
    for (const t of tiles.children) t.setAttribute("aria-pressed", String(known(m) && t.dataset.material === m));
    matVal.textContent = row.materialLabel ?? "None";
    unknown.hidden = !(m != null && !known(m));
    unknown.textContent = unknown.hidden ? "" : String(m);
    const color = row.color;
    // An explicit colour under an untintable preset still exists (an override
    // cannot clear an authored colour, only replace it), so it is shown by
    // value rather than as "from the material" — the row stays disabled.
    const ownColor = typeof state.effective.color === "number";
    colVal.textContent = row.tintable || ownColor ? hexColor(color) : "from the material";
    colors.classList.toggle("disabled", !row.tintable);
    // Disabled for real, not only dimmed: pointer-events alone left the
    // swatches and the colour well reachable by keyboard and screen reader.
    for (const b of colors.querySelectorAll(".pf-card-color")) b.disabled = !row.tintable;
    native.disabled = !row.tintable;
    hex.disabled = !row.tintable;
    for (const b of colors.querySelectorAll(".pf-card-color")) b.classList.toggle("on", parseHex(b.dataset.color) === color);
    native.value = hexColor(color);
    if (document.activeElement !== hex) hex.value = hexColor(color);
    tintNote.hidden = row.tintable;
    tintNote.textContent = row.tintable ? "" : `${row.materialLabel} has its own colour. Pick a tintable preset to colour it.`;
    for (const [key, { input, val }] of finishInputs) {
      const v = state.effective[key];
      const shown = typeof v === "number" ? v : (known(m) ? (PRESETS[m][key] ?? 0) : 0);
      if (key === "textureScale") {
        const mm = shown > 0 ? clampTs(shown) : null;
        input.value = String(textureScaleToPos(mm ?? TS_LO));
        val.textContent = mm === null ? "—" : formatTextureScale(mm);
      } else {
        input.value = String(shown); val.textContent = shown.toFixed(2);
      }
    }
    const f = FOOT[getSaveState?.() ?? "screen-only"] ?? FOOT["screen-only"];
    note.textContent = f.note; note.hidden = !f.note; reset.textContent = f.reset;
    if (renderThumb) requestPaint(state.effective);
  }

  // Repaints, held to one per REPAINT_MS: the first at once, then at most one
  // trailing pass carrying the latest state when the window closes.
  let repaintTimer = null;
  let repaintPending = null;
  function requestPaint(effective) {
    if (repaintTimer !== null) { repaintPending = effective; return; }
    paintThumbs(effective);
    const windowEnd = () => {
      repaintTimer = null;
      if (!repaintPending) return;
      const next = repaintPending; repaintPending = null;
      paintThumbs(next);
      repaintTimer = setTimeout(windowEnd, REPAINT_MS);
    };
    repaintTimer = setTimeout(windowEnd, REPAINT_MS);
  }
  function cancelRepaint() {
    if (repaintTimer !== null) clearTimeout(repaintTimer);
    repaintTimer = null; repaintPending = null;
  }

  // Thumbnails: one per tile, lazily, in order, cached by the renderer (Task 7),
  // with a frame between tiles so a pass of cold renders never blocks a task
  // for all ~25 spheres at once.
  let thumbToken = 0;
  async function paintThumbs(effective) {
    const token = ++thumbToken;
    let first = true;
    for (const t of tiles.children) {
      if (token !== thumbToken || !root.isConnected) return;
      const id = t.dataset.material;
      if (!first) { await nextFrame(); if (token !== thumbToken || !root.isConnected) return; }
      first = false;
      let url = null;
      try { url = await renderThumb(id, { ...effective, material: id }); } catch { url = null; }
      if (token !== thumbToken) return;
      const img = t.querySelector("img");
      if (url) { img.src = url; img.hidden = false; } else img.hidden = true;
    }
  }

  const off = parts.onChange(() => render());
  return {
    element: root,
    show(next) {
      if (!parts.list().some((r) => r.name === next)) return false;
      name = next;
      render();
      return true;
    },
    hide() { name = null; thumbToken++; cancelRepaint(); },
    render,
    detach() { writeFinish.cancel(); writeNative.cancel(); writeSee.cancel(); cancelRepaint(); thumbToken++; try { off(); } catch { /* gone */ } root.remove(); },
  };
}
