// Persist a little viewer UI state across browser reloads (notably Vite dev
// auto-refresh). `camera` and `theme` live in localStorage under global
// keys — they're viewer preferences, not part state. The active view is different:
// it's scoped to one part and stored in sessionStorage, so a hot reload keeps your
// tab but the name can't bleed into another part that happens to share a view name,
// and a fresh session opens on the part's own default (see default-view.js).
// Reads/writes are guarded: if storage is unavailable (private mode, disabled) or a
// value is corrupt, reads return the documented default and writes are no-ops —
// persistence never throws. `renderMode` and `environment` are viewer
// preferences like `theme`; in the cloud's opaque-origin sandbox storage throws,
// so there the host carries them in viewerState instead.
import { ENVIRONMENTS } from "./materials/environments.js";

const KEY = {
  camera: "partforge:camera",
  theme: "partforge:theme",
  projection: "partforge:projection",
  renderMode: "partforge:renderMode",
  environment: "partforge:environment",
  featureLines: "partforge:featureLines",
};

const viewKey = (partKey) => `partforge:view:${partKey}`;

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable — no-op */ }
}
function readSession(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function writeSession(key, value) {
  try { sessionStorage.setItem(key, value); } catch { /* storage unavailable — no-op */ }
}

const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n));

export function loadCamera() {
  const raw = read(KEY.camera);
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (parsed && isVec3(parsed.pos) && isVec3(parsed.target)) {
    return { pos: parsed.pos, target: parsed.target };
  }
  return null;
}

export function saveCamera(state) {
  if (!state || !isVec3(state.pos) || !isVec3(state.target)) return;
  write(KEY.camera, JSON.stringify({ pos: state.pos, target: state.target }));
}

export function loadTheme() {
  const raw = read(KEY.theme);
  return raw === "light" ? "light" : "dark"; // default: dark (matches the viewer's default)
}

export function saveTheme(mode) {
  if (mode === "light" || mode === "dark") write(KEY.theme, mode);
}

export function loadProjection() {
  return read(KEY.projection) === "orthographic" ? "orthographic" : "perspective";
}

export function saveProjection(mode) {
  if (mode === "perspective" || mode === "orthographic") write(KEY.projection, mode);
}

// null = nothing (valid) stored — the caller falls back to "cad".
export function loadRenderMode() {
  const raw = read(KEY.renderMode);
  return raw === "realistic" || raw === "cad" ? raw : null;
}

export function saveRenderMode(mode) {
  if (mode === "cad" || mode === "realistic") write(KEY.renderMode, mode);
}

// null = nothing stored, or an id this version doesn't know — the caller falls
// back to the part's own meta.environment.
export function loadEnvironment() {
  const raw = read(KEY.environment);
  return raw && Object.hasOwn(ENVIRONMENTS, raw) ? raw : null;
}

export function saveEnvironment(id) {
  if (typeof id === "string" && Object.hasOwn(ENVIRONMENTS, id)) write(KEY.environment, id);
}

// Feature lines are remembered PER STYLE ("cad" or an environment id); a style
// with no entry uses its default (view-style-state.js). Unknown styles and
// non-boolean values are dropped, so an older or corrupt value reads as {}.
const knownStyle = (id) => id === "cad" || Object.hasOwn(ENVIRONMENTS, id);
export function loadFeatureLinesPrefs() {
  let raw;
  try { raw = JSON.parse(read(KEY.featureLines) ?? "{}"); } catch { return {}; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([k, v]) => knownStyle(k) && typeof v === "boolean"));
}

export function saveFeatureLinesPrefs(prefs) {
  write(KEY.featureLines, JSON.stringify(prefs ?? {}));
}

// `partKey` identifies the part — createViewTabs passes `meta.title`. Without one
// there is nothing safe to key on, so both calls no-op rather than falling back to a
// shared key (the cross-part bleed this scoping exists to remove).
export function loadView(partKey) {
  if (typeof partKey !== "string" || !partKey) return null;
  return readSession(viewKey(partKey)); // raw string or null; caller validates against available tabs
}

export function saveView(partKey, name) {
  if (typeof partKey !== "string" || !partKey) return;
  if (typeof name === "string" && name) writeSession(viewKey(partKey), name);
}
