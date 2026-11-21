// Display units: a pure, DOM-free module. Parts are always authored and stored
// in millimetres; the unit only changes how a length is SHOWN and typed.
// Unit ids are exactly "mm" and "in"; anything else is treated as "mm".
export const UNIT_IDS = Object.freeze(["mm", "in"]);
export const MM_PER_IN = 25.4;

const KEY = "partforge:units";

export const isUnitId = (v) => v === "mm" || v === "in";
const norm = (u) => (u === "in" ? "in" : "mm");

// Only the exact unit "mm" is a length the switch converts (not "mm²", "°", "%").
export const convertsUnit = (unit) => unit === "mm";

export const toDisplay = (mm, units) => (norm(units) === "in" ? mm / MM_PER_IN : mm);

export const fromDisplay = (value, units) =>
  norm(units) === "in" ? Math.round(value * MM_PER_IN * 1e4) / 1e4 : value;

const trim = (v, decimals) => String(Math.round(v * 10 ** decimals) / 10 ** decimals);

export function formatLength(mm, units) {
  return norm(units) === "in" ? trim(mm / MM_PER_IN, 3) : trim(mm, 4);
}

const DECIMAL = /^([+-]?)(\d+(?:[.,]\d*)?|[.,]\d+)$/;
const FRACTION = /^([+-]?)(\d+)\/(\d+)$/;
const MIXED = /^([+-]?)(\d+)\s+(\d+)\/(\d+)$/;

// Returns millimetres, or null when the text is not a length.
export function parseLength(text, units) {
  if (typeof text !== "string") return null;
  const inch = norm(units) === "in";
  let s = text.trim();
  if (inch) s = s.replace(/\s*(?:"|in)$/, "").trim();
  let value;
  let m;
  if ((m = DECIMAL.exec(s))) {
    value = Number(m[2].replace(",", "."));
    if (m[1] === "-") value = -value;
  } else if (inch && (m = FRACTION.exec(s))) {
    if (Number(m[3]) === 0) return null;
    value = Number(m[2]) / Number(m[3]);
    if (m[1] === "-") value = -value;
  } else if (inch && (m = MIXED.exec(s))) {
    if (Number(m[4]) === 0) return null;
    value = Number(m[2]) + Number(m[3]) / Number(m[4]);
    if (m[1] === "-") value = -value;
  } else return null;
  return Number.isFinite(value) ? fromDisplay(value, units) : null;
}

export const unitLabel = (unit, units) => (convertsUnit(unit) ? norm(units) : unit);

export function createUnitsState(initial) {
  let current = norm(initial);
  const subs = new Set();
  return {
    get: () => current,
    set(next) {
      if (!isUnitId(next) || next === current) return false;
      current = next;
      for (const cb of [...subs]) cb(current);
      return true;
    },
    onChange(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}

// null = nothing (valid) stored — the caller falls back to "mm".
export function loadUnits() {
  let raw = null;
  try { raw = localStorage.getItem(KEY); } catch { /* storage unavailable */ }
  return isUnitId(raw) ? raw : null;
}

export function saveUnits(u) {
  if (!isUnitId(u)) return;
  try { localStorage.setItem(KEY, u); } catch { /* storage unavailable — no-op */ }
}
