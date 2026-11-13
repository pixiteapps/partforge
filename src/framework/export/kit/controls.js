// What the kit's README reads off a part's controls: every control that owns a key, the
// ones that are design fit (CLEARANCES), and the one that sets a sheet's thickness.

// The words of a control's key or label: camelCase, snake_case, digits and spaces all
// split, lowercased — "fingerClearance" → finger, clearance.
const wordsOf = (s) => String(s ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([a-zA-Z])([0-9])/g, "$1 $2")
  .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

// Controls the README lists as design fit rather than kerf (spec D.9): a WORD of the key
// or label is clearance, fit or play — so "Finger clearance", "tab_play" and "pressFit"
// are listed, and "display", "outfit" and "profit" are not.
const CLEARANCE_WORDS = new Set(["clearance", "clearances", "fit", "play"]);
export const isClearance = (c) => [...wordsOf(c.key), ...wordsOf(c.label)].some((w) => CLEARANCE_WORDS.has(w));

// Every control that owns a parameter key, whatever the section shape: authored
// `controls` (groups nest), and the legacy `advanced`, `toggles`, `features` and a
// feature's own `sliders`. Groups and presets own no key.
export function collectControls(parameters) {
  const out = [];
  const visit = (list) => {
    for (const c of Array.isArray(list) ? list : []) {
      if (!c || typeof c !== "object") continue;
      if (typeof c.key === "string" && c.type !== "group" && c.type !== "preset") out.push(c);
      visit(c.controls);
      visit(c.sliders);
    }
  };
  for (const sec of Array.isArray(parameters) ? parameters : []) {
    visit(sec?.controls); visit(sec?.advanced); visit(sec?.toggles); visit(sec?.features);
  }
  return out;
}

// The control that sets a sheet part's thickness, so the README can name the setting to
// change when the user's sheet measures differently. Of the controls the thickness
// function reads, the one whose value IS the thickness it returned (a
// `p.material === "acrylic" ? p.acrylicT : p.plyT` reads Material first, and Material
// is not the thickness); failing a single such control, the one read whose key or label
// says "thick"; else null — the generic wording, never a guess. Null too for a literal
// thickness or one that reads no control.
export function thicknessControlLabel(controls, sp, p, d) {
  const t = sp.sheet.thickness;
  if (typeof t !== "function") return null;
  const reads = new Set();
  const spy = new Proxy(p, { get: (target, key) => { if (typeof key === "string") reads.add(key); return target[key]; } });
  let value;
  try { value = t(spy, d); } catch { return null; }
  const read = controls.filter((x) => reads.has(x.key));
  const holds = read.filter((x) => typeof p[x.key] === "number" && Math.abs(p[x.key] - value) <= 1e-9);
  const pool = holds.length > 1 ? holds : read;
  const named = pool.filter((x) => [...wordsOf(x.key), ...wordsOf(x.label)].some((w) => w.startsWith("thick")));
  const c = holds.length === 1 ? holds[0] : named.length === 1 ? named[0] : null;
  return c ? String(c.label ?? c.key) : null;
}
