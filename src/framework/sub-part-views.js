// One sub-part's views and placement, in either authoring form.
//
//   map form:    views: { assembly: (s, p, d) => s.translate(…), lid: true }
//   legacy form: views: ["assembly", "lid"], place: (s, { view, purpose, p, d }) => s
//
// Every reader of a sub-part's views or placement asks here, so the map form compiles to
// the same place(s, { view, purpose, p, d }) the pose probe, the pose ladder, print frames
// and the oracle already understand (spec 2026-10-04 "Compilation"). A map entry is `true`
// (shown as built) or a rigid pose; anything else leaves the piece out of that view and is
// lint's view-entry-invalid. Export never applies an entry: a map-form piece exports as
// built. A base `place` on a map-form sub-part can only be sheetPart's generated pose
// (lint's views-and-place refuses an author's), and it runs first for both purposes, as
// sheet poses always have.
//
// Pure and import-free: lint rules import it (test/lint-purity.test.js).

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isEntry = (v) => v === true || typeof v === "function";

export const isViewsMap = (views) => isPlainObject(views);

export function viewsOf(sp) {
  const v = sp?.views;
  if (Array.isArray(v)) return v;
  if (isPlainObject(v)) return Object.keys(v).filter((name) => isEntry(v[name]));
  return [];
}

export const inView = (sp, view) => viewsOf(sp).includes(view);

export const formOf = (sp) => (isViewsMap(sp?.views) ? "map" : "legacy");

// Memo only: never identity-compared across module instances (the cloud worker loads two).
const compiled = new WeakMap();

export function placeOf(sp) {
  if (!sp) return null;
  if (compiled.has(sp)) return compiled.get(sp);
  if (!isViewsMap(sp.views)) {
    // A wrapper, so a method-style place keeps `this` when callers invoke it detached.
    const legacy = typeof sp.place === "function" ? (s, ctx) => sp.place(s, ctx) : null;
    compiled.set(sp, legacy);
    return legacy;
  }
  const base = typeof sp.place === "function" ? sp.place : null;
  const entries = sp.views;
  const anyPose = Object.values(entries).some((v) => typeof v === "function");
  const fn = !base && !anyPose ? null : (s, ctx) => {
    const posed = base ? base(s, ctx) : s;
    if (ctx.purpose === "export") return posed;
    const entry = entries[ctx.view];
    return typeof entry === "function" ? entry(posed, ctx.p, ctx.d) : posed;
  };
  compiled.set(sp, fn);
  return fn;
}
