// The readout chip: after a generic handle's drag, a small DOM chip by the handle (in the
// stage) shows the readout values for CHIP_MS. A click or tap on it turns it into one
// number input per readout param; Enter, or focus leaving the chip, writes what was typed
// as a slider would (handle-guides' chipValues: snapped and clamped, a wrapped param kept in
// its turn) through `apply` — mount's slider path, one commit. Escape cancels. A drag that
// wrote nothing because a pin held it (pose-mode's onDragEnd `pinHeld`) shows PIN_HINT for
// HINT_MS instead, not editable. A press on the canvas, posing standing down or detach puts
// the chip away. Where it sits is pose-mode's handlePoints() (canvas px, through `toStage`),
// re-read every frame while it shows. An edit in progress outlives its handle going off
// screen (the chip stays, held inside the stage); posing going off, the view dropping the
// handle, or detach end the edit unwritten. Only the inputs whose text was changed are
// written; each value is named by its control's label and unit.
//
// A sibling of pose-controls.js: DOM chrome only, no three.js; pose-mode owns behaviour.
import { readoutItems, chipValues } from "./handle-guides.js";
import { rangesOf } from "./param-solve.js";

/** How long the values chip shows after a drag, and the pin hint (ms). */
export const CHIP_MS = 4000;
export const HINT_MS = 3000;
export const PIN_HINT = "Held by a pin — Release pins to move it";
/** The chip's corner sits this far right of and above the handle's point (CSS px). */
const OFFSET_PX = 12;

const noop = () => {};
// a short numeric string without float noise, as the panel's value box shows it
const numStr = (v) => String(Math.round(v * 1e4) / 1e4);

/**
 * @param viewer the viewer: `domElement` (a press there puts the chip away) and `onFrame`.
 * @param mode a pose mode: onDragEnd, handlePoints, isLive, onModeChange.
 * @param elements `{ stage }` — the element the chip lives in; without one this is a no-op.
 * @param opts `{ part, getParams, apply(values), toStage(point) }` — `apply` writes the
 *   chip's values (mount: the slider path, one commit); `toStage` turns a canvas point into
 *   stage px (default: as is).
 */
export function attachReadoutChip(viewer, mode, { stage } = {}, { part, getParams, apply, toStage = (a) => a } = {}) {
  if (!stage) return { detach: noop };
  const handles = part?.handles ?? {};

  const chip = document.createElement("div");
  chip.className = "pf-pose-chip";
  chip.hidden = true;
  stage.append(chip);

  let shown = null;   // { handleId, kind: "values" | "hint", editing }
  let timer = null;
  let lastAt = null;  // the chip's last on-screen spot (stage px), kept by an edit off screen

  function clearTimer() { if (timer !== null) { clearTimeout(timer); timer = null; } }
  function hide() {
    clearTimer();
    shown = null;
    lastAt = null;
    chip.hidden = true;
    chip.replaceChildren();
    delete chip.dataset.kind;
  }
  /**
   * Put the chip by its handle. A handle this view no longer shows hides it (an edit is
   * dropped). One that is only off screen hides it too — unless an edit is open, which
   * keeps the chip where it last was, held inside the stage.
   */
  function place() {
    if (!shown) return;
    const p = mode.handlePoints?.({ offscreen: true }).find((h) => h.handleId === shown.handleId);
    if (!p) { hide(); return; }
    const s = toStage(p);
    const w = stage.clientWidth, h = stage.clientHeight;
    const onScreen = s && s.visible !== false && Number.isFinite(s.x) && Number.isFinite(s.y)
      && (!(w > 0 && h > 0) || (s.x >= 0 && s.y >= 0 && s.x <= w && s.y <= h));
    if (!onScreen && !shown.editing) { hide(); return; }
    let x = onScreen ? s.x + OFFSET_PX : lastAt?.x ?? OFFSET_PX;
    let y = onScreen ? s.y - OFFSET_PX : lastAt?.y ?? h;
    if (w > 0 && h > 0) {
      // inside the stage: the chip hangs above (left, top) by its own height
      x = Math.max(0, Math.min(w - chip.offsetWidth, x));
      y = Math.max(chip.offsetHeight, Math.min(h, y));
    }
    lastAt = { x, y };
    chip.style.left = `${Math.round(x)}px`;
    chip.style.top = `${Math.round(y)}px`;
  }
  function show(handleId, kind, ms) {
    clearTimer();
    shown = { handleId, kind, editing: false };
    chip.dataset.kind = kind;
    chip.replaceChildren();
    if (kind === "hint") {
      const hint = document.createElement("span");
      hint.className = "pf-pose-chip-hint";
      hint.setAttribute("role", "status");
      hint.textContent = PIN_HINT;
      chip.append(hint);
    } else {
      const handle = handles[handleId];
      const text = readoutItems(part, { ...part?.defaults, ...getParams() }, handle)
        .map((i) => `${i.label} ${i.text}${i.unit ? ` ${i.unit}` : ""}`).join(" · ");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "pf-pose-chip-value";
      button.textContent = text;
      button.title = "Type exact values";
      button.setAttribute("aria-label", `Edit ${handle?.label ?? handleId}: ${text}`);
      button.addEventListener("click", startEdit);
      chip.append(button);
    }
    chip.hidden = false;
    place();
    if (shown) timer = setTimeout(hide, ms);
  }

  function startEdit() {
    if (!shown || shown.kind !== "values" || shown.editing) return;
    clearTimer(); // an edit holds the chip open
    const params = { ...part?.defaults, ...getParams() };
    const ranges = rangesOf(part);
    const form = document.createElement("div");
    form.className = "pf-pose-chip-edit";
    for (const item of readoutItems(part, params, handles[shown.handleId])) {
      const label = document.createElement("label");
      const name = document.createElement("span");
      name.className = "pf-pose-chip-name";
      name.textContent = item.label;
      const input = document.createElement("input");
      input.type = "number";
      input.name = item.key;
      input.value = numStr(item.value);
      input.dataset.shown = input.value; // written back only once it is changed
      const step = ranges.get(item.key)?.step;
      input.step = Number.isFinite(step) && step > 0 ? String(step) : "any";
      label.append(name, input);
      if (item.unit) {
        const unit = document.createElement("span");
        unit.className = "pf-pose-chip-unit";
        unit.textContent = item.unit;
        label.append(unit);
      }
      form.append(label);
    }
    // The clicked button has the focus: removing it would blur it (a focusout), and that
    // must not read as the edit's blur. Blur it first, and mark the edit only once the
    // inputs are in and focused.
    if (chip.contains(document.activeElement)) document.activeElement.blur?.();
    chip.replaceChildren(form);
    const first = form.querySelector("input");
    first?.focus();
    first?.select?.();
    shown.editing = true;
  }

  /** Write what was typed (Enter, or focus leaving the chip), once, and close. */
  function commitEdit() {
    if (!shown?.editing) return;
    const typed = {};
    for (const input of chip.querySelectorAll("input")) {
      if (input.value === input.dataset.shown) continue; // never touched: not written
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) typed[input.name] = v;
    }
    const values = chipValues(part, { ...part?.defaults, ...getParams() }, typed);
    hide();
    if (Object.keys(values).length) apply(values);
  }

  function onKeyDown(ev) {
    if (!shown?.editing) return;
    if (ev.key === "Enter") {
      ev.preventDefault();
      commitEdit();
    } else if (ev.key === "Escape") {
      // consumed: nothing else on the page (a cutaway's or measure's Escape) acts on it
      ev.preventDefault();
      ev.stopPropagation();
      hide();
    }
  }
  function onFocusOut(ev) {
    if (!shown?.editing || chip.contains(ev.relatedTarget)) return;
    commitEdit();
  }
  // A press on the canvas puts the chip away; one that ends an edit writes it (a blur).
  function onCanvasDown() {
    if (!shown) return;
    if (shown.editing) commitEdit();
    else hide();
  }
  chip.addEventListener("keydown", onKeyDown);
  chip.addEventListener("focusout", onFocusOut);
  viewer.domElement?.addEventListener("pointerdown", onCanvasDown, true);

  const offEnd = mode.onDragEnd?.((e) => {
    if (!e?.generic || !handles[e.handleId]) return;
    if (e.changed?.length) show(e.handleId, "values", CHIP_MS);
    else if (e.pinHeld) show(e.handleId, "hint", HINT_MS);
  }) ?? noop;
  const offMode = mode.onModeChange?.(() => { if (!mode.isLive()) hide(); }) ?? noop;
  const offFrame = viewer.onFrame?.(() => { if (shown) place(); }) ?? noop;

  let detached = false;
  return {
    /** What the chip shows now, for tests and the browser check: `{ handleId, kind, editing }` or null. */
    state: () => (shown ? { ...shown } : null),
    detach() {
      if (detached) return;
      detached = true;
      hide();
      offEnd();
      offMode();
      offFrame();
      chip.removeEventListener("keydown", onKeyDown);
      chip.removeEventListener("focusout", onFocusOut);
      viewer.domElement?.removeEventListener("pointerdown", onCanvasDown, true);
      chip.remove();
    },
  };
}
