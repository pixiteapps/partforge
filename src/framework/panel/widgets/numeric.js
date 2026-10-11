// slider + number: a range input (omitted for `number`) beside an editable value
// box. The box accepts exact values finer than `step` AND values outside
// [min, max]: the authored range bounds the slider track, not the parameter.
// A typed out-of-range value commits as typed (the build gets to try it and
// fails visibly if it can't), the thumb pins at the nearer end of the track,
// and the box paints red until the value is back inside the range.
import { attachInfo } from "../info.js";

// Short numeric string without float noise (4 dp max) for the value box.
const numStr = (v) => String(Math.round(v * 1e4) / 1e4);

// Kept as a public helper (re-exported from controls.js) for hosts; the widget
// itself no longer clamps typed input — see the header comment.
export function clampToRange(raw, min, max) {
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, v));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function makeNumeric(node, params, { onChange, onCommit, info }) {
  const numeric = node.type === "number";
  const wrap = el("div", "slider");
  const row = el("div", "row");
  const label = el("label", "", node.label);
  attachInfo(label, node.description, info);
  row.append(label);

  const val = el("div", "val");
  const box = document.createElement("input");
  box.type = "number";
  box.className = "num";
  // No native min/max on the box: the range is advisory for typed input, and
  // the attributes would add browser validity styling and clamp the spinner.
  box.step = node.step;
  box.value = numStr(params[node.key]);
  val.append(box);
  if (node.unit) val.append(el("span", "unit", node.unit));
  row.append(val);
  wrap.append(row);

  // A log track maps thumb position 0..LOG_STEPS onto [min, max] geometrically —
  // the value box stays linear and exact (see AUTHORING-PARTS.md's "Slider
  // refinements" section). Only valid when min > 0; lint's log-scale-needs-positive-min
  // catches an authored part that violates that before it ever reaches here.
  const LOG_STEPS = 1000;
  const log = node.scale === "log" && node.min > 0;
  const toValue = (t) => Math.exp(Math.log(node.min) + (t / LOG_STEPS) * (Math.log(node.max) - Math.log(node.min)));
  const toPos = (v) => Math.round(LOG_STEPS * (Math.log(v) - Math.log(node.min)) / (Math.log(node.max) - Math.log(node.min)));
  // toPos(0) is -Infinity and a non-finite assignment to slider.value snaps the
  // thumb to mid-track instead of an end — guard the live-typed, unclamped box
  // value before it reaches the slider.
  const toPosSafe = (v) => {
    if (!(v > 0)) return 0;
    const t = toPos(v);
    return Math.max(0, Math.min(LOG_STEPS, Number.isFinite(t) ? t : 0));
  };

  // Where the thumb sits for a value: pinned at the nearer end when the value
  // is outside [min, max] (a range input sanitises this itself, but jsdom and
  // the log mapping don't, so be explicit).
  const thumbFor = (v) => log ? toPosSafe(v) : Math.max(node.min, Math.min(node.max, v));

  // Edited (an `input`) since the last `change`. A widget torn down mid-edit
  // commits what it holds (dispose below): the DOM fires no `change` for a
  // detached input on WebKit, and the value is already in params either way.
  let dirty = false;
  let slider = null;
  if (!numeric) {
    slider = document.createElement("input");
    slider.type = "range";
    slider.min = log ? 0 : node.min; slider.max = log ? LOG_STEPS : node.max; slider.step = log ? 1 : node.step;
    slider.value = log ? toPosSafe(params[node.key]) : params[node.key];
    slider.addEventListener("input", () => {
      const v = log ? toValue(+slider.value) : snapTo(+slider.value);
      params[node.key] = v;
      box.value = numStr(v);
      paintWarn();
      dirty = true;
      onChange?.();
    });
    slider.addEventListener("change", () => { dirty = false; onCommit?.(); });
    wrap.append(slider);
  }

  // ticks: native datalist marks; snap quantizes input to the nearest tick.
  // The datalist id derives from the node id (assigned by buildTree before
  // factories run) — stable across re-renders, no randomness.
  if (slider && !log && Array.isArray(node.ticks) && node.ticks.length) {
    const dl = document.createElement("datalist");
    dl.id = `pf-ticks-${node.id.replaceAll("/", "-")}`;
    for (const t of node.ticks) {
      const o = document.createElement("option");
      o.value = String(t);
      dl.append(o);
    }
    wrap.append(dl);
    slider.setAttribute("list", dl.id);
  }
  const snapTo = (v) => {
    if (!node.snap || !Array.isArray(node.ticks) || !node.ticks.length) return v;
    return node.ticks.reduce((best, t) => Math.abs(t - v) < Math.abs(best - v) ? t : best);
  };

  // recommended: a tinted band of the track — purely visual; it never colours
  // the value box (that is reserved for values outside [min, max] below).
  // Linear tracks only (like ticks).
  const band = !log && Array.isArray(node.recommended) && node.recommended.length === 2
    ? node.recommended : null;
  if (band) {
    wrap.classList.add("has-band");
    const pct = (v) => {
      const raw = Math.max(0, Math.min(100, ((v - node.min) / (node.max - node.min)) * 100));
      return `${Math.round(raw * 1e4) / 1e4}%`; // trim float noise (e.g. 12.499999999999996)
    };
    wrap.style.setProperty("--band-lo", pct(band[0]));
    wrap.style.setProperty("--band-hi", pct(band[1]));
  }
  // The box goes red only when the value is outside the authored range — a
  // typed overshoot, or a preset/host value the range never covered.
  const paintWarn = () => {
    const v = params[node.key];
    box.classList.toggle("warn", v < node.min || v > node.max);
  };

  // live preview while typing; reformat (never clamp) on commit
  box.addEventListener("input", () => {
    const v = parseFloat(box.value);
    if (!Number.isFinite(v)) return;
    params[node.key] = v;
    if (slider) slider.value = thumbFor(v);
    paintWarn();
    dirty = true;
    onChange?.();
  });
  box.addEventListener("change", () => {
    const v = parseFloat(box.value);
    if (!Number.isFinite(v)) { box.value = numStr(params[node.key]); return; } // revert invalid input
    params[node.key] = v;
    box.value = numStr(v);
    if (slider) slider.value = thumbFor(v);
    paintWarn();
    dirty = false;
    onChange?.();
    onCommit?.();
  });

  const sync = () => {
    box.value = numStr(params[node.key]);
    if (slider) slider.value = thumbFor(params[node.key]);
    paintWarn();
  };
  paintWarn();
  // Torn down with an edit still uncommitted (a sub-panel rebuilt under the
  // pointer, a remount): commit it, since no `change` is coming.
  const dispose = () => { if (dirty) { dirty = false; onCommit?.(); } };
  return { el: wrap, sync, dispose };
}
