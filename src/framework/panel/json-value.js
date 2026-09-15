//
// The ONE predicate for the value a `type: "custom"` control may own. The panel
// (host.set, panel state), lint (custom-default-not-json) and partforge-cloud's
// persistence (through the `partforge/panel-values` export) all ask this module,
// so "the linter accepts it" and "the save can write it" cannot drift apart.
//
// Imports nothing: it sits inside partforge/lint's pure closure
// (test/lint-purity.test.js) and inside the sandbox iframe.

export const CUSTOM_VALUE_MAX_BYTES = 16384;
export const CUSTOM_VALUE_MAX_DEPTH = 8;

// Keys a JSON value may never carry: on a plain object each of these reaches
// Object.prototype, so a value that round-trips through JSON.parse and a
// plain-object assignment could change what `params.x.constructor` means.
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const at = (path) => (path ? ` at ${path}` : "");

function shapeProblem(v, depth, maxDepth, path) {
  if (v === null) return `is null${at(path)}`;
  const t = typeof v;
  if (t === "number") return Number.isFinite(v) ? null : `is a non-finite number${at(path)}`;
  if (t === "string" || t === "boolean") return null;
  if (t !== "object") return `is a ${t}${at(path)}`;
  if (depth >= maxDepth) return `nests deeper than ${maxDepth} levels${at(path)}`;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const p = shapeProblem(v[i], depth + 1, maxDepth, `${path}[${i}]`);
      if (p) return p;
    }
    return null;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return `is not a plain object${at(path)}`;
  for (const k of Object.keys(v)) {
    if (FORBIDDEN_KEYS.has(k)) return `uses the forbidden key "${k}"${at(path)}`;
    const p = shapeProblem(v[k], depth + 1, maxDepth, path ? `${path}.${k}` : k);
    if (p) return p;
  }
  return null;
}

// Why `v` is not a JSON value — a sentence fragment that reads after the
// value's name ("`defaults.tiles` is null at tiles[2].h") — or null when it is.
export function jsonValueProblem(v, { maxBytes = CUSTOM_VALUE_MAX_BYTES, maxDepth = CUSTOM_VALUE_MAX_DEPTH } = {}) {
  const shape = shapeProblem(v, 0, maxDepth, "");
  if (shape) return shape;
  if (maxBytes === Infinity) return null;
  const bytes = new TextEncoder().encode(JSON.stringify(v)).length;
  if (bytes > maxBytes) return `is ${bytes} bytes serialized; the cap is ${maxBytes}`;
  return null;
}

export const isJsonValue = (v, opts) => jsonValueProblem(v, opts) === null;
