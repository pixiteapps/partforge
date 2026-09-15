# Custom Panel Controls (partforge core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `type: "custom"` to partforge's control panel so a part can render a widget of its own (DOM/SVG, written as a function) that owns a JSON-valued param, mounts built-in sub-controls, keeps ephemeral state across remounts, and reports its own failures.

**Architecture:** One new entry in the closed control registry (`WIDGET_SPECS` + `WIDGET_FACTORIES`) whose factory calls the author's `widget(host)` function inside try/catch. `render.js` grows a `custom` context (files, restored panel state, an error sink, and a sub-panel builder) plus two panel-level reads, `errors()` and `getState()`, which `mount()` exposes as `runtime.getPanelErrors()` / `runtime.getPanelState()` and accepts back as `mount({files, panelState})`. JSON-valued defaults are admitted by one predicate (`isJsonValue`) shared by the panel, lint, and — via the new `partforge/panel-values` export — partforge-cloud's persistence.

**Tech Stack:** plain ESM, vitest (`happy-dom` for DOM tests, `// @vitest-environment happy-dom` per file), Node 24 (`nvm use` first).

**Spec:** `docs/superpowers/specs/2026-09-14-custom-panel-controls-design.md` — the plan implements sections 1, 2, 3 (partforge half), 4, 5, 6 (lint + runtime half), 7 and 8 (partforge half). One placement differs from the spec: the JSON literal reader/writer the spec calls `json-literal.js` lives inside `src/framework/lint/source-scan.js`, because it must share that file's string decoder and a separate module would create a module cycle (`source-scan` → `json-literal` → `source-scan`). The exported names are the spec's.

## Global Constraints

- Lint purity: everything reachable from `src/lint.js` imports nothing outside the repo and never reaches `src/index.js`, `oracle/verify.js`, `oracle/measure.js`, `jobs.js` (`test/lint-purity.test.js`). `src/framework/panel/json-value.js` and `source-scan.js` import nothing.
- The registry parity test (`test/framework/panel/registry.test.js`) requires every `kind: "control"` spec to have a factory and vice versa.
- The docs-coherence test (`test/framework/docs-coherence.test.js`) requires `AUTHORING-PARTS.md` to mention `"custom"` once the registry lists it — Task 3 adds the table row, Task 9 the full section.
- Owned-value caps, verbatim from the spec: `CUSTOM_VALUE_MAX_BYTES = 16384`, `CUSTOM_VALUE_MAX_DEPTH = 8`; forbidden keys `__proto__`, `constructor`, `prototype`; no `null`. Panel-state budget `PANEL_STATE_MAX_BYTES = 65536` across all widgets.
- Every widget-code entry point (create, update, dispose, listeners installed through `host.h`, sub-control writes) runs inside a try/catch; a throw retires the widget, renders `.pf-custom-error`, and records `{key, label, phase, message}` with `phase` in `create | update | event | dispose | state`.
- Version: `package.json` goes from 0.113.0 to **0.114.0** in Task 9 (AGENTS.md "Releasing": the bump rides the PR; publish is automatic on merge).
- Run tests as `npx vitest run <file>`; the whole suite is `npm test`. Run `npm run lint` before the final commit (ESLint + the repo's config).
- Commit after every task with a conventional message; never `git stash`.

---

### Task 1: `isJsonValue` — the one predicate for a custom control's value

**Files:**
- Create: `src/framework/panel/json-value.js`
- Test: `test/framework/panel/json-value.test.js`

**Interfaces:**
- Produces: `isJsonValue(v, {maxBytes?, maxDepth?}) → boolean`, `jsonValueProblem(v, {maxBytes?, maxDepth?}) → string | null` (a sentence fragment starting with a verb, e.g. `is null at tiles[2].h`), constants `CUSTOM_VALUE_MAX_BYTES`, `CUSTOM_VALUE_MAX_DEPTH`.

- [ ] **Step 1: Write the failing test**

```js
// test/framework/panel/json-value.test.js
import { expect, test } from "vitest";
import { isJsonValue, jsonValueProblem, CUSTOM_VALUE_MAX_BYTES, CUSTOM_VALUE_MAX_DEPTH } from "../../../src/framework/panel/json-value.js";

test("primitives, arrays and plain objects of primitives are JSON values", () => {
  for (const v of [0, -1.5, "x", "", true, false, [], {}, [1, "a", [true]], { a: { b: [1, { c: "d" }] } }]) {
    expect(jsonValueProblem(v), JSON.stringify(v)).toBeNull();
    expect(isJsonValue(v)).toBe(true);
  }
});

test("null, non-finite numbers, functions and class instances are refused, with a path", () => {
  expect(jsonValueProblem(null)).toBe("is null");
  expect(jsonValueProblem({ a: [1, null] })).toBe("is null at a[1]");
  expect(jsonValueProblem(NaN)).toBe("is a non-finite number");
  expect(jsonValueProblem({ h: Infinity })).toBe("is a non-finite number at h");
  expect(jsonValueProblem(() => 1)).toBe("is a function");
  expect(jsonValueProblem({ f() {} })).toBe("is a function at f");
  expect(jsonValueProblem(new Date(0))).toBe("is not a plain object");
  expect(jsonValueProblem({ d: new Map() })).toBe("is not a plain object at d");
  expect(jsonValueProblem(10n)).toBe("is a bigint");
  expect(jsonValueProblem(undefined)).toBe("is a undefined");
});

test("the forbidden keys are refused wherever they appear", () => {
  expect(jsonValueProblem(JSON.parse('{"__proto__": 1}'))).toBe('uses the forbidden key "__proto__"');
  expect(jsonValueProblem({ a: { constructor: 1 } })).toBe('uses the forbidden key "constructor" at a');
  expect(jsonValueProblem({ prototype: 1 })).toBe('uses the forbidden key "prototype"');
});

test("depth and size caps", () => {
  expect(CUSTOM_VALUE_MAX_DEPTH).toBe(8);
  expect(CUSTOM_VALUE_MAX_BYTES).toBe(16384);
  let deep = 1;
  for (let i = 0; i < 8; i++) deep = [deep];        // 8 nested arrays: depths 0..7 — allowed
  expect(jsonValueProblem(deep)).toBeNull();
  deep = [deep];                                     // a 9th level
  expect(jsonValueProblem(deep)).toMatch(/^nests deeper than 8 levels/);
  const big = { s: "x".repeat(16384) };
  expect(jsonValueProblem(big)).toMatch(/^is \d+ bytes serialized; the cap is 16384$/);
  expect(jsonValueProblem(big, { maxBytes: Infinity })).toBeNull();
  expect(jsonValueProblem(deep, { maxDepth: 20 })).toBeNull();
});

test("the byte count is UTF-8 bytes, not characters", () => {
  // 5462 three-byte characters serialize past 16384 bytes but under it in chars.
  const v = { s: "€".repeat(5462) };
  expect(JSON.stringify(v).length).toBeLessThan(16384);
  expect(jsonValueProblem(v)).toMatch(/bytes serialized/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/framework/panel/json-value.test.js`
Expected: FAIL — cannot resolve `../../../src/framework/panel/json-value.js`.

- [ ] **Step 3: Write the implementation**

```js
// src/framework/panel/json-value.js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/framework/panel/json-value.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/framework/panel/json-value.js test/framework/panel/json-value.test.js
git commit -m "panel: isJsonValue — the predicate for a custom control's value"
```

---

### Task 2: JSON literals in the defaults scanner, plus the `partforge/panel-values` export

**Files:**
- Modify: `src/framework/lint/source-scan.js` (`readValue` ~line 195; add `readJsonLiteral`, `writeJsonLiteral`; export `decodeStringLiteral` is NOT needed — keep it private)
- Create: `src/panel-values.js`, `types/panel-values.d.ts`
- Modify: `package.json` (`exports`)
- Test: `test/framework/lint/json-literal.test.js` (new), `test/lint-source.test.js` (one added case)

**Interfaces:**
- Produces: `readJsonLiteral(text) → {value} | null` and `writeJsonLiteral(value, {indent = ""}) → string`, exported from `source-scan.js` and re-exported from `partforge/panel-values` beside `isJsonValue`, `jsonValueProblem`, `CUSTOM_VALUE_MAX_BYTES`, `CUSTOM_VALUE_MAX_DEPTH`.
- `defaultsEntriesIn(source)` entries whose value span is a JSON literal now read `readable: true` with the parsed value.

- [ ] **Step 1: Write the failing tests**

```js
// test/framework/lint/json-literal.test.js
import { expect, test } from "vitest";
import { readJsonLiteral, writeJsonLiteral, defaultsEntriesIn } from "../../../src/framework/lint/source-scan.js";

const read = (t) => readJsonLiteral(t)?.value;

test("reads arrays and objects of primitives, bare or quoted keys, trailing commas", () => {
  expect(read("[1, 2, 3]")).toEqual([1, 2, 3]);
  expect(read("[{ q: 0, r: 0, height: 10 }, { q: 1, r: 0, height: 14 },]"))
    .toEqual([{ q: 0, r: 0, height: 10 }, { q: 1, r: 0, height: 14 }]);
  expect(read('{ "north": true, \'south\': "x\\n", n: -1.5e2 }')).toEqual({ north: true, south: "x\n", n: -150 });
  expect(read("{}")).toEqual({});
  expect(read("[]")).toEqual([]);
  expect(read("[\n  [0, 0],\n  [1, 0],\n]")).toEqual([[0, 0], [1, 0]]);
});

test("rejects everything the rewriter could not write back identically", () => {
  for (const bad of [
    "[1, 2 * 3]", "[SIZE]", "{ a: `t` }", "[null]", "{ [k]: 1 }", "{ ...x }",
    "[1, // c\n 2]", "[1 /* c */]", "{ a }", "{ a: 1, a: 2 }".replace("a: 2", "a: () => 1"),
    "[0x10]", "[1_000]", "[1n]", "{ __proto__: 1 }", "[1,,2]", "[1] x", "{ a: 1 } ,",
    '"a string"', "42", "true",   // a primitive is readValue's job, not this reader's
  ]) {
    expect(readJsonLiteral(bad), bad).toBeNull();
  }
});

test("applies the value caps", () => {
  let deep = "1";
  for (let i = 0; i < 9; i++) deep = `[${deep}]`;
  expect(readJsonLiteral(deep)).toBeNull();
  expect(readJsonLiteral(`["${"x".repeat(16384)}"]`)).toBeNull();
});

test("writes compact JSON under 80 chars, indented JSON above it, relative to the entry's indent", () => {
  expect(writeJsonLiteral([1, 2, 3])).toBe("[1,2,3]");
  const long = Array.from({ length: 12 }, (_, i) => ({ q: i, r: 0, height: 10 + i }));
  const out = writeJsonLiteral(long, { indent: "    " });
  expect(out.startsWith("[\n      {")).toBe(true);        // two spaces deeper than the entry
  expect(out.endsWith("\n    ]")).toBe(true);             // the closing bracket sits under the key
  expect(readJsonLiteral(out)?.value).toEqual(long);      // round-trips through the reader
});

test("defaultsEntriesIn reads a JSON-literal entry and still refuses an expression inside one", () => {
  const src = "export default {\n  defaults: {\n    od: 8,\n    tiles: [{ q: 0, h: 10 }],\n    pts: [[0, 0], [1, 2 * 3]],\n  },\n};";
  const entries = defaultsEntriesIn(src);
  expect(entries.find((e) => e.key === "tiles").readable).toBe(true);
  expect(entries.find((e) => e.key === "pts").readable).toBe(false);
});
```

Add to `test/lint-source.test.js`, inside `describe("control-default-not-literal")`:

```js
  it("accepts a JSON literal on a key a custom control owns", () => {
    const part = partWith({ wall: 2 }, ["wall"]);
    part.defaults.tiles = [{ q: 0, h: 10 }];
    part.parameters[0].controls.push({ key: "tiles", type: "custom", label: "Tiles", widget: () => {} });
    const report = lintPart(part, {
      sources: srcWith("{\n    wall: 2,\n    tiles: [{ q: 0, h: 10 }],\n  }"),
    });
    expect(findingsFor(report, "control-default-not-literal")).toHaveLength(0);
  });

  it("still errors on an expression inside a custom control's JSON literal", () => {
    const part = partWith({ wall: 2 }, ["wall"]);
    part.defaults.tiles = [{ q: 0, h: 13 / 3 }];
    part.parameters[0].controls.push({ key: "tiles", type: "custom", label: "Tiles", widget: () => {} });
    const report = lintPart(part, {
      sources: srcWith("{\n    wall: 2,\n    tiles: [{ q: 0, h: 13 / 3 }],\n  }"),
    });
    const found = findingsFor(report, "control-default-not-literal");
    expect(found).toHaveLength(1);
    expect(found[0].path).toBe("defaults.tiles");
  });
```

(These two lint-source cases will pass only after Task 3 registers `custom`; until then `unknown-control-type` fires too but does not affect `findingsFor("control-default-not-literal")`, and `controlBoundKeys` already includes any authored control's key, so run them now anyway — they should pass on the scanner change alone.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/framework/lint/json-literal.test.js test/lint-source.test.js`
Expected: json-literal FAILs on the missing exports; lint-source's new "accepts a JSON literal" case FAILs (the entry is unreadable today).

- [ ] **Step 3: Implement the reader and writer in `source-scan.js`**

Add at the top of the file (after the header comment, before `findDefaultsLiteral`):

```js
import { isJsonValue } from "../panel/json-value.js";
```

Replace `readValue`:

```js
// One value's source text → { value }, or null when it is not a literal this
// module can read AND write back. Primitives first; then the JSON-literal
// grammar a `type: "custom"` control's value is written in.
function readValue(raw) {
  if (raw === "true") return { value: true };
  if (raw === "false") return { value: false };
  if (NUMBER_RE.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) ? { value: n } : null;
  }
  const q = raw[0];
  if (q === '"' || q === "'") {
    const s = decodeStringLiteral(raw);
    return s === null ? null : { value: s };
  }
  if (q === "[" || q === "{") return readJsonLiteral(raw);
  return null;
}
```

Then add, after `readValue`:

```js
// --- JSON literals ----------------------------------------------------------
//
// The grammar a custom control's owned value is spelled in inside `defaults`:
// object and array literals of primitives, nested; bare or quoted keys; JS
// string escapes (the same decoder as above); decimal numbers; true/false;
// trailing commas; whitespace. NOTHING else — no comments inside the span, no
// expressions, identifiers, templates, `null`, computed keys, spreads — so
// every value this reads, writeJsonLiteral can write back and this can read
// again. A parse failure is null, never a throw: the entry simply stays
// unreadable, exactly as an expression does.

class JsonLiteralError extends Error {}

function jsonParser(text) {
  let i = 0;
  const fail = () => { throw new JsonLiteralError(); };
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const value = () => {
    ws();
    const c = text[i];
    if (c === "{") return object();
    if (c === "[") return array();
    if (c === '"' || c === "'") {
      const end = skipQuoted(text, i, text.length);
      const s = decodeStringLiteral(text.slice(i, end));
      if (s === null) fail();
      i = end;
      return s;
    }
    const m = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (m) { i += m[0].length; const n = Number(m[0]); if (!Number.isFinite(n)) fail(); return n; }
    if (text.startsWith("true", i)) { i += 4; return true; }
    if (text.startsWith("false", i)) { i += 5; return false; }
    return fail();
  };
  const array = () => {
    i++; // [
    const out = [];
    for (;;) {
      ws();
      if (text[i] === "]") { i++; return out; }
      if (out.length) { if (text[i] !== ",") fail(); i++; ws(); if (text[i] === "]") { i++; return out; } }
      out.push(value());
    }
  };
  const object = () => {
    i++; // {
    const out = {};
    let n = 0;
    for (;;) {
      ws();
      if (text[i] === "}") { i++; return out; }
      if (n) { if (text[i] !== ",") fail(); i++; ws(); if (text[i] === "}") { i++; return out; } }
      const k = readKey(text, i, text.length);
      if (!k) fail();
      i = k.next;
      ws();
      if (text[i] !== ":") fail();
      i++;
      const v = value();
      Object.defineProperty(out, k.key, { value: v, enumerable: true, writable: true, configurable: true });
      n++;
    }
  };
  return { value, done: () => { ws(); return i === text.length; } };
}

// An array or object literal's source text → { value }, or null. Applies the
// custom-value caps (json-value.js) so a literal lint accepts is one the panel
// would accept too.
export function readJsonLiteral(text) {
  if (typeof text !== "string") return null;
  const first = text.trimStart()[0];
  if (first !== "[" && first !== "{") return null;
  try {
    const p = jsonParser(text);
    const v = p.value();
    if (!p.done()) return null;
    return isJsonValue(v) ? { value: v } : null;
  } catch (e) {
    if (e instanceof JsonLiteralError) return null;
    throw e;
  }
}

// The source text for a JSON value being written into `defaults`: compact
// when it fits on a line, else indented two spaces deeper than the entry's
// own indentation (`indent`, the whitespace before the entry's key) so a large
// layout diffs line by line. Always plain JSON — quoted keys — so the reader
// above accepts it unchanged.
export function writeJsonLiteral(value, { indent = "" } = {}) {
  const compact = JSON.stringify(value);
  if (compact.length <= 80) return compact;
  return JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
}
```

`readKey`, `skipQuoted` and `decodeStringLiteral` already exist in the file above `readValue`; `readJsonLiteral` uses them through hoisting (function declarations) — keep the new code AFTER `readKey`.

- [ ] **Step 4: Add the `partforge/panel-values` export**

```js
// src/panel-values.js
// Public entry for `partforge/panel-values`: the value contract of a
// `type: "custom"` control, for hosts that persist panel settings (partforge-
// cloud rewrites `defaults` with these). Dependency-free, DOM-free, tiny — a
// host imports this without pulling partforge/lint's rule set into its bundle.
export { isJsonValue, jsonValueProblem, CUSTOM_VALUE_MAX_BYTES, CUSTOM_VALUE_MAX_DEPTH } from "./framework/panel/json-value.js";
export { readJsonLiteral, writeJsonLiteral } from "./framework/lint/source-scan.js";
```

```ts
// types/panel-values.d.ts
// partforge/panel-values — the value contract of a `type: "custom"` control.

export const CUSTOM_VALUE_MAX_BYTES: 16384;
export const CUSTOM_VALUE_MAX_DEPTH: 8;

export interface JsonValueLimits { maxBytes?: number; maxDepth?: number }

/** A string, boolean, finite number, or an array / plain object of those. */
export type JsonValue = string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

/** Why `v` is not a JSON value within the caps (a fragment such as `is null at tiles[2].h`), or null. */
export function jsonValueProblem(v: unknown, limits?: JsonValueLimits): string | null;
export function isJsonValue(v: unknown, limits?: JsonValueLimits): v is JsonValue;

/** Parse an array/object literal's source text (bare or quoted keys, trailing commas, JS string escapes). Null on anything else. */
export function readJsonLiteral(text: string): { value: JsonValue } | null;
/** Source text for a value: compact under 80 chars, else indented JSON relative to `indent`. */
export function writeJsonLiteral(value: JsonValue, opts?: { indent?: string }): string;
```

In `package.json` `exports`, after the `"./ingest"` entry:

```json
    "./panel-values": {
      "types": "./types/panel-values.d.ts",
      "default": "./src/panel-values.js"
    },
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/framework/lint/json-literal.test.js test/lint-source.test.js test/lint-purity.test.js`
Expected: PASS. (lint-purity proves `json-value.js` reached from `source-scan.js` imports nothing.)

- [ ] **Step 6: Commit**

```bash
git add src/framework/lint/source-scan.js src/panel-values.js types/panel-values.d.ts package.json test/framework/lint/json-literal.test.js test/lint-source.test.js
git commit -m "lint: JSON literals in the defaults scanner; partforge/panel-values export"
```

---

### Task 3: Register `type: "custom"` (registry, author normalizer, types, one doc row)

**Files:**
- Modify: `src/framework/panel/widget-specs.js` (`WIDGET_SPECS`, `AUTHOR_EXTRAS`)
- Modify: `src/framework/panel/author.js` (`authoredControl`)
- Modify: `src/framework/panel/widgets/index.js` (`WIDGET_FACTORIES`)
- Create: `src/framework/panel/widgets/custom.js` (a STUB in this task; Task 4 fills it)
- Modify: `types/part.d.ts` (`ControlType`, `PanelControlEntry`)
- Modify: `docs/AUTHORING-PARTS.md` (control types table, ~line 736)
- Test: `test/framework/panel/registry.test.js`, `test/framework/panel/author.test.js`

**Interfaces:**
- Produces: a canonical control node `{kind: "control", type: "custom", key, widget, keys, label, description, hidden, when, whenFalse}`; `WIDGET_FACTORIES.custom = makeCustom`.

- [ ] **Step 1: Write the failing tests**

In `test/framework/panel/registry.test.js`, change the first test's expected list to include `"custom"`:

```js
test("the registry covers exactly the types this phase supports", () => {
  expect(WIDGET_TYPES.sort()).toEqual(["checkbox", "custom", "font", "image", "number", "radio", "readout", "select", "slider", "text", "textarea", "vector"]);
});

test("custom accepts widget and keys beside the common fields", () => {
  for (const f of ["key", "type", "label", "description", "hidden", "when", "whenFalse", "widget", "keys"]) {
    expect(fieldsFor("custom"), `custom is missing "${f}"`).toContain(f);
  }
});
```

Append to `test/framework/panel/author.test.js`:

```js
import { authoredSection } from "../../../src/framework/panel/author.js";

test("a custom control keeps its widget function and keys list", () => {
  const widget = () => {};
  const [node] = authoredSection({ title: "T", controls: [
    { key: "tiles", type: "custom", label: "Tiles", widget, keys: ["tileSize"] },
  ] }).children;
  expect(node.kind).toBe("control");
  expect(node.type).toBe("custom");
  expect(node.widget).toBe(widget);
  expect(node.keys).toEqual(["tileSize"]);
});
```

(If `author.test.js` already imports `authoredSection`, drop the duplicate import line.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/framework/panel/registry.test.js test/framework/panel/author.test.js`
Expected: FAIL — `custom` missing from `WIDGET_TYPES`; `node.widget` undefined.

- [ ] **Step 3: Register the type**

`src/framework/panel/widget-specs.js` — in `WIDGET_SPECS`, after the `vector` line:

```js
  { type: "custom", kind: "control", fields: [...AUTHOR_COMMON, "widget", "keys"] },
```

and in `AUTHOR_EXTRAS`, after `vector`:

```js
  custom: ["widget", "keys"],
```

`src/framework/panel/author.js` — in `authoredControl`, after `sourceField: c.sourceField,`:

```js
    // Custom controls (type: "custom"): the author's widget function and the
    // extra scalar keys it may write. Both are on this allow-list for the same
    // reason `allow` is (see above) — a field missing here is silently dropped.
    widget: c.widget,
    keys: c.keys,
```

Create the stub factory so the registry parity test passes now (Task 4 replaces the body):

```js
// src/framework/panel/widgets/custom.js
// A part-authored widget in the rail. Filled in by the custom-control task.
export function makeCustom(node) {
  const el = document.createElement("div");
  el.className = "pf-custom";
  return { el, sync: () => {}, keys: [node.key] };
}
```

`src/framework/panel/widgets/index.js`:

```js
import { makeCustom } from "./custom.js";
```

and in `WIDGET_FACTORIES`, after `vector: makeVector,`:

```js
  custom: makeCustom,
```

`types/part.d.ts`:

```ts
/** Every control type the panel can render. */
export type ControlType = "slider" | "number" | "text" | "textarea" | "checkbox" | "select" | "radio" | "font" | "image" | "vector" | "custom";
```

and in `PanelControlEntry`, after `recommended?`:

```ts
  /**
   * custom: the widget function. Called once per mount with a host object
   * (see `CustomControlHost` in index.d.ts); draws into `host.el`. The key
   * this control owns may hold a JSON value (arrays and plain objects of
   * primitives, ≤16 KB, depth ≤8).
   */
  widget?: (host: import("./index.js").CustomControlHost) => import("./index.js").CustomControlInstance | void;
  /** custom: further scalar params the widget may write besides `key`. */
  keys?: string[];
```

`docs/AUTHORING-PARTS.md` — add a row to the control-types table after the `"vector"` row:

```md
| `"custom"` | a widget the part draws itself — see "Custom controls" below | `widget`, `keys` |
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/framework/panel/registry.test.js test/framework/panel/author.test.js test/framework/docs-coherence.test.js test/lint-schema.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/panel/widget-specs.js src/framework/panel/author.js src/framework/panel/widgets/index.js src/framework/panel/widgets/custom.js types/part.d.ts docs/AUTHORING-PARTS.md test/framework/panel/registry.test.js test/framework/panel/author.test.js
git commit -m "panel: register type: \"custom\" (widget, keys)"
```

---

### Task 4: The custom factory and host: draw, read, write, commit, state, files, errors

**Files:**
- Modify: `src/framework/panel/widgets/custom.js` (replace the stub)
- Modify: `src/framework/panel/render.js` (`buildControls`: custom context, `onCommit(keys)`, per-key syncs, `onDerived`, `errors()`, `getState()`)
- Test: `test/framework/panel/custom.test.js`

**Interfaces:**
- Consumes: `isJsonValue`, `jsonValueProblem` (Task 1); `vectorThumb(doc)`; `attachInfo(label, description, info)`.
- Produces: `makeCustom(node, params, {onChange, onCommit, info, custom})` returning `{el, keys, sync, onDerived, getState, dispose}`; `buildControls` opts gain `files`, `panelState`, `onPanelError`; the panel object gains `errors()` and `getState()`; factories may now call `onCommit(keys)` with an explicit key list (undefined still means `[node.key]`).
- `host.controls` is wired in Task 5; in this task `custom.buildSubPanel` is passed but `host.controls` returns a no-op disposer.

- [ ] **Step 1: Write the failing tests**

```js
// test/framework/panel/custom.test.js
// @vitest-environment happy-dom
import { expect, test, vi } from "vitest";
import { buildControls } from "../../../src/framework/panel/render.js";

const root = () => { document.body.innerHTML = '<div id="root"></div>'; return document.getElementById("root"); };
const sec = (control, extra = []) => [{ id: "s", title: "S", controls: [control, ...extra] }];

test("the widget draws into host.el and the slot is registered like any control", () => {
  const r = root();
  const params = { tiles: [{ q: 0, h: 10 }], od: 8 };
  const widget = vi.fn((host) => { host.el.append(host.h("div", { class: "drawn" }, "hi")); });
  buildControls(r, sec({ key: "tiles", type: "custom", label: "Tiles", widget, when: { od: { gt: 10 } } }), params, () => {});
  expect(widget).toHaveBeenCalledTimes(1);
  const wrap = r.querySelector(".pf-custom");
  expect(wrap.querySelector(".pf-custom-slot .drawn").textContent).toBe("hi");
  expect(wrap.querySelector(".row label").textContent).toBe("Tiles");
  expect(wrap.classList.contains("hidden")).toBe(true);   // `when` applies to the wrapper
});

test("host.get clones; host.set stores a clone, marks dirty and commits the owning key", () => {
  const r = root();
  const params = { tiles: [{ q: 0, h: 10 }] };
  let dirty = 0; const commits = [];
  let host;
  buildControls(r, sec({ key: "tiles", type: "custom", widget: (h) => { host = h; } }), params, () => dirty++, (keys) => commits.push(keys));
  const got = host.get();
  expect(got).toEqual(params.tiles);
  expect(got).not.toBe(params.tiles);
  got[0].h = 99;
  expect(params.tiles[0].h).toBe(10);                     // the clone is the widget's, not the panel's
  const next = [{ q: 0, h: 12 }];
  host.set(next);
  expect(params.tiles).toEqual(next);
  expect(params.tiles).not.toBe(next);
  expect(dirty).toBe(1);
  expect(commits).toEqual([["tiles"]]);
});

test("commit: false defers; host.commit fires once for what changed and is a no-op otherwise", () => {
  const r = root();
  const params = { tiles: [], n: 1 };
  const commits = [];
  let host;
  buildControls(r, sec({ key: "tiles", type: "custom", keys: ["n"], widget: (h) => { host = h; } }), params, () => {}, (keys) => commits.push(keys));
  host.set([{ q: 1 }], { commit: false });
  host.set(2, { key: "n", commit: false });
  expect(commits).toEqual([]);
  host.commit(["tiles", "n"]);
  expect(commits).toEqual([["tiles", "n"]]);
  host.commit();
  expect(commits).toEqual([["tiles", "n"]]);              // nothing pending: no second commit
});

test("host.set refuses keys the control does not own and values outside the contract", () => {
  const r = root();
  const params = { tiles: [], n: 1, other: 3 };
  let host;
  buildControls(r, sec({ key: "tiles", type: "custom", keys: ["n"], widget: (h) => { host = h; } }), params, () => {});
  expect(() => host.set(1, { key: "other" })).toThrow(/may not write "other"/);
  expect(() => host.set(null)).toThrow(/is null/);
  expect(() => host.set({ f() {} })).toThrow(/is a function/);
  expect(() => host.set([1], { key: "n" })).toThrow(/finite number, string or boolean/);
  expect(params).toEqual({ tiles: [], n: 1, other: 3 });
});

test("an external change syncs the widget; a derived change updates it; its own set does not", () => {
  const r = root();
  const params = { tiles: [] };
  const update = vi.fn();
  let host;
  const panel = buildControls(r, sec({ key: "tiles", type: "custom", widget: (h) => { host = h; return { update }; } }), params, () => {});
  host.set([{ q: 1 }]);
  expect(update).not.toHaveBeenCalled();
  params.tiles = [{ q: 2 }];
  panel.syncValues(["tiles"]);
  expect(update).toHaveBeenLastCalledWith({ reason: "sync", disabled: false });
  panel.refresh({ derived: { count: 1 } });
  expect(host.derived).toEqual({ count: 1 });
  expect(update).toHaveBeenLastCalledWith({ reason: "derived", disabled: false });
  panel.refresh({ derived: { count: 1 } });               // unchanged: no update
  expect(update).toHaveBeenCalledTimes(2);
});

test("a widget that throws on create gets an error card, is recorded, and leaves its siblings alive", () => {
  const r = root();
  const params = { tiles: [], od: 8 };
  const errors = [];
  const panel = buildControls(r, sec(
    { key: "tiles", type: "custom", label: "Tiles", widget: () => { throw new Error("boom"); } },
    [{ key: "od", label: "OD", min: 0, max: 20, step: 1 }],
  ), params, () => {}, undefined, { onPanelError: (e) => errors.push(e) });
  const card = r.querySelector(".pf-custom-error");
  expect(card.textContent).toContain("Tiles");
  expect(card.textContent).toContain("boom");
  expect(r.querySelector('input[type="range"]')).not.toBeNull();
  expect(panel.errors()).toEqual([{ key: "tiles", label: "Tiles", phase: "create", message: "boom" }]);
  expect(errors).toEqual(panel.errors());
});

test("a listener installed through host.h that throws retires the widget with phase event", () => {
  const r = root();
  const params = { tiles: [] };
  const update = vi.fn();
  const panel = buildControls(r, sec({ key: "tiles", type: "custom", label: "Tiles", widget: (h) => {
    h.el.append(h.h("button", { onclick: () => { throw new Error("click boom"); } }, "go"));
    return { update };
  } }), params, () => {});
  r.querySelector("button").click();
  expect(panel.errors()[0]).toMatchObject({ phase: "event", message: "click boom" });
  expect(r.querySelector(".pf-custom-error")).not.toBeNull();
  panel.syncValues(["tiles"]);
  expect(update).not.toHaveBeenCalled();                  // retired: no more calls into widget code
});

test("host.h builds SVG in the SVG namespace, passes class/style through, and flattens children", () => {
  const r = root();
  let host;
  buildControls(r, sec({ key: "t", type: "custom", widget: (h) => { host = h; } }), { t: [] }, () => {});
  const svg = host.h("svg", { viewBox: "0 0 10 10", width: "100%", class: "pic" }, [
    host.h("polygon", { points: "0,0 1,1 2,0", class: "pf-hit selected", "data-i": 0 }),
    null, "text",
  ]);
  expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
  expect(svg.getAttribute("class")).toBe("pic");
  expect(svg.firstElementChild.namespaceURI).toBe("http://www.w3.org/2000/svg");
  expect(svg.firstElementChild.getAttribute("data-i")).toBe("0");
  expect(svg.textContent).toBe("text");
  const div = host.h("div", { hidden: true, title: false });
  expect(div.namespaceURI).toBe("http://www.w3.org/1999/xhtml");
  expect(div.hasAttribute("hidden")).toBe(true);
  expect(div.hasAttribute("title")).toBe(false);
});

test("host.svg parses an svg string and refuses anything else; host.svgFromVector renders a document", () => {
  const r = root();
  let host;
  buildControls(r, sec({ key: "t", type: "custom", widget: (h) => { host = h; } }), { t: [] }, () => {});
  const el = host.svg('<svg viewBox="0 0 4 4"><rect id="w1" width="2" height="2"/></svg>');
  expect(el.tagName.toLowerCase()).toBe("svg");
  expect(el.querySelector("#w1")).not.toBeNull();
  expect(host.svg("<div>no</div>")).toBeNull();
  expect(host.svg(42)).toBeNull();
  const doc = { units: "mm", shapes: { a: { role: "add", regions: [{ outer: [[0, 0], [10, 0], [10, 10]], holes: [] }] } } };
  expect(host.svgFromVector(doc)?.tagName.toLowerCase()).toBe("svg");
  expect(host.svgFromVector({})).toBeNull();
});

test("host.file reads the part's own files by path or pfc-tree token, else null", () => {
  const r = root();
  let host;
  const files = { "part.js": "export default {}", "assets/a.svg": "<svg/>" };
  buildControls(r, sec({ key: "t", type: "custom", widget: (h) => { host = h; } }), { t: [] }, () => {}, undefined, { files });
  expect(host.file("assets/a.svg")).toBe("<svg/>");
  expect(host.file("./assets/a.svg")).toBe("<svg/>");
  expect(host.file("pfc-tree://assets/a.svg?v=abc123")).toBe("<svg/>");
  expect(host.file("missing.svg")).toBeNull();
  expect(host.file(3)).toBeNull();
  let noFiles;
  buildControls(root(), sec({ key: "t", type: "custom", widget: (h) => { noFiles = h; } }), { t: [] }, () => {});
  expect(noFiles.file("part.js")).toBeNull();
});

test("panel state restores into host.state, fires update(restore), and reads back through getState", () => {
  const r = root();
  const update = vi.fn();
  let host;
  const panel = buildControls(r, sec({ key: "tiles", type: "custom", widget: (h) => { host = h; return { update }; } }), { tiles: [] }, () => {}, undefined,
    { panelState: { tiles: { selected: 3 }, other: { x: 1 } } });
  expect(host.state).toEqual({ selected: 3 });
  expect(update).toHaveBeenCalledWith({ reason: "restore", disabled: false });
  host.setState({ hover: 1 });
  expect(panel.getState()).toEqual({ tiles: { selected: 3, hover: 1 } });
  expect(panel.getState().tiles).not.toBe(host.state);   // a clone
});

test("getState skips empty state, drops oversize state with a recorded error", () => {
  const r = root();
  let a, b;
  const panel = buildControls(r, [{ id: "s", controls: [
    { key: "a", type: "custom", label: "A", widget: (h) => { a = h; } },
    { key: "b", type: "custom", label: "B", widget: (h) => { b = h; } },
  ] }], { a: [], b: [] }, () => {});
  expect(panel.getState()).toEqual({});
  a.setState({ big: "x".repeat(70000) });
  b.setState({ ok: true });
  expect(panel.getState()).toEqual({ b: { ok: true } });
  expect(panel.errors()).toEqual([{ key: "a", label: "A", phase: "state", message: expect.stringMatching(/exceeds the 65536-byte budget/) }]);
});

test("dispose calls the widget's dispose once and records a throw without propagating", () => {
  const r = root();
  const dispose = vi.fn(() => { throw new Error("bye"); });
  const panel = buildControls(r, sec({ key: "t", type: "custom", label: "T", widget: () => ({ dispose }) }), { t: [] }, () => {});
  expect(() => panel.dispose()).not.toThrow();
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(panel.errors()).toEqual([{ key: "t", label: "T", phase: "dispose", message: "bye" }]);
});

test("a widget that is not a function is a create error, not a crash", () => {
  const r = root();
  const panel = buildControls(r, sec({ key: "t", type: "custom", label: "T", widget: "nope" }), { t: [] }, () => {});
  expect(panel.errors()[0]).toMatchObject({ phase: "create", message: expect.stringMatching(/widget/) });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/framework/panel/custom.test.js`
Expected: FAIL throughout (the stub draws nothing, `panel.errors` is not a function).

- [ ] **Step 3: Write the factory**

Replace `src/framework/panel/widgets/custom.js` with:

```js
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
```

`scopedParams` is written in Task 5; for this task create the module with a minimal export so the import resolves — Task 5 replaces it and tests it:

```js
// src/framework/panel/scoped-params.js
// Filled in by the sub-controls task. See custom.js's host.controls.
export function scopedParams({ read }) {
  return new Proxy({}, { get: (_, key) => (typeof key === "string" ? read()?.[key] : undefined) });
}
```

- [ ] **Step 4: Wire the context, per-key syncs, derived updates, errors and state into `render.js`**

At the top of `render.js` add:

```js
import { isJsonValue } from "./json-value.js";

// The budget every custom control's transient state shares (getState below).
export const PANEL_STATE_MAX_BYTES = 65536;
```

Inside `buildControls`, after `let relevant = null;`, add:

```js
  const panelErrors = [];         // {key, label, phase, message} from custom controls
  const customWidgets = new Map(); // param key -> { label, getState } for custom controls
  // What a custom control's host reaches back into the panel for: the part's
  // own files (host.file), the state a previous mount left (host.state), the
  // error sink, and the sub-panel builder — a re-entry into buildControls with
  // a scoped params view and no section header (opts.bare, Task 5).
  const customCtx = {
    files: opts.files ?? null,
    panelState: opts.panelState ?? null,
    onError: (e) => { panelErrors.push(e); opts.onPanelError?.(e); },
    buildSubPanel: (container, controls, scoped, onSubDirty, onSubCommit) =>
      buildControls(container, [{ controls }], scoped, onSubDirty, onSubCommit,
        { ...opts, bare: true, panelState: null, onPanelError: customCtx.onError }),
  };
```

In `renderNode`, replace the factory call and the lines after it (from `const widget = factory(...)` through the `syncFns.push(...)` block) with:

```js
    const widget = factory(node, params, {
      onChange: () => { markCustom(); onEdit(); },
      // A factory may name the keys it committed (custom controls own several);
      // the built-ins call onCommit() bare and get their own key, as before.
      onCommit: (keys) => commit(Array.isArray(keys) && keys.length ? keys : [node.key]),
      info,
      fontCatalog: opts.fontCatalog,
      imageCatalog: opts.imageCatalog,
      onAssetUpload: opts.onAssetUpload,
      declaredSource: opts.declaredSource,
      custom: customCtx,
    });
    nodeEls.set(node.id, widget.el);
    if (node.key && !keyToId.has(node.key)) keyToId.set(node.key, node.id);
    widgetSyncs.set(node.id, widget.sync);
    if (widget.dispose) disposers.push(widget.dispose);
    // A custom control reads derive() output like a readout does, and keeps
    // transient state the host may carry across a remount.
    if (typeof widget.onDerived === "function") displayUpdates.set(node.id, widget.onDerived);
    if (typeof widget.getState === "function" && node.key) {
      customWidgets.set(node.key, { label: node.label ?? node.key, getState: widget.getState });
    }
    container.append(widget.el);

    // The raw sync is what a PRESET application uses — it must not mark itself
    // Custom (controls.test.js:366). The registered sync is what an external
    // syncValues() uses, and for a preset-section control it does drop the
    // picker to Custom (controls.test.js:350), because a programmatic edit
    // diverges from the preset exactly as a user edit does. A widget that owns
    // several keys (custom's `keys`) registers under each of them.
    if (sectionCtx) rawSyncs.get(sectionCtx.id).push({ key: node.key, sync: widget.sync });
    const ownedKeys = Array.isArray(widget.keys) && widget.keys.length ? widget.keys : [node.key];
    for (const key of ownedKeys) {
      syncFns.push({ key, sync: () => { widget.sync(); markCustom(); } });
    }
```

In the returned panel object, add two members before `dispose`:

```js
    // What custom controls reported failing this mount, in order. A host that
    // remounts per edit (partforge-cloud) reads this after mount and hands it
    // to the agent beside the build's own warnings.
    errors: () => panelErrors.map((e) => ({ ...e })),
    // Every custom control's non-empty transient state, keyed by param, as
    // plain JSON — hand it back as mount({ panelState }) so a selection survives
    // the remount an edit performs. One shared budget: a state that would push
    // the total past it is dropped and recorded (phase "state") rather than
    // silently lost.
    getState: () => {
      const out = {};
      let budget = PANEL_STATE_MAX_BYTES;
      for (const [key, w] of customWidgets) {
        const state = w.getState();
        if (!state || typeof state !== "object" || Object.keys(state).length === 0) continue;
        if (!isJsonValue(state, { maxBytes: Infinity })) {
          customCtx.onError({ key, label: w.label, phase: "state", message: "panel state is not a JSON value; dropped" });
          continue;
        }
        const size = new TextEncoder().encode(JSON.stringify(state)).length;
        if (size > budget) {
          customCtx.onError({ key, label: w.label, phase: "state", message: `panel state (${size} bytes) exceeds the ${PANEL_STATE_MAX_BYTES}-byte budget; dropped` });
          continue;
        }
        budget -= size;
        out[key] = structuredClone(state);
      }
      return out;
    },
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/framework/panel/`
Expected: PASS — the new file and every existing panel test (`render.test.js`, `widgets.test.js`, `reveal.test.js`, `registry.test.js`, …).

- [ ] **Step 6: Commit**

```bash
git add src/framework/panel/widgets/custom.js src/framework/panel/scoped-params.js src/framework/panel/render.js test/framework/panel/custom.test.js
git commit -m "panel: the custom control factory and its host (draw, set/commit, state, files, errors)"
```

---

### Task 5: Sub-controls: `scopedParams` and `host.controls`, `opts.bare` sections

**Files:**
- Modify: `src/framework/panel/scoped-params.js` (replace the stub)
- Modify: `src/framework/panel/render.js` (the section loop: `opts.bare`)
- Test: `test/framework/panel/scoped-params.test.js`, `test/framework/panel/custom-subcontrols.test.js`

**Interfaces:**
- Produces: `scopedParams({read, write, path, onError}) → Proxy` where `read()` returns a fresh clone of the owned value, `write(next)` stores it; `buildControls(..., {bare: true})` renders sections with no header, no disclosure.

- [ ] **Step 1: Write the failing tests**

```js
// test/framework/panel/scoped-params.test.js
import { expect, test } from "vitest";
import { scopedParams } from "../../../src/framework/panel/scoped-params.js";

const store = (initial) => {
  let value = initial;
  const writes = [];
  return {
    read: () => structuredClone(value),
    write: (next) => { writes.push(structuredClone(next)); value = next; },
    current: () => value,
    writes,
  };
};

test("reads and writes at a path inside the value, writing the whole value back", () => {
  const s = store([{ q: 0, h: 10 }, { q: 1, h: 14 }]);
  const p = scopedParams({ read: s.read, write: s.write, path: "1" });
  expect(p.h).toBe(14);
  expect("h" in p).toBe(true);
  expect(Object.keys(p)).toEqual(["q", "h"]);
  p.h = 20;
  expect(s.current()).toEqual([{ q: 0, h: 10 }, { q: 1, h: 20 }]);
  expect(s.writes).toHaveLength(1);
});

test("an empty path scopes to the root; a dotted path walks objects", () => {
  const s = store({ walls: { north: true, south: false } });
  const root = scopedParams({ read: s.read, write: s.write, path: "" });
  expect(Object.keys(root)).toEqual(["walls"]);
  const walls = scopedParams({ read: s.read, write: s.write, path: "walls" });
  walls.south = true;
  expect(s.current().walls.south).toBe(true);
});

test("a write whose parent does not exist is refused and reported, never thrown", () => {
  const s = store([{ q: 0 }]);
  const errors = [];
  const p = scopedParams({ read: s.read, write: s.write, path: "7", onError: (m) => errors.push(m) });
  expect(p.h).toBeUndefined();
  expect(() => { p.h = 1; }).not.toThrow();
  expect(s.writes).toHaveLength(0);
  expect(errors[0]).toMatch(/no value at path "7"/);
});

test("Object.assign (a preset bundle) writes each key through the proxy", () => {
  const s = store([{ q: 0, h: 1 }]);
  const p = scopedParams({ read: s.read, write: s.write, path: "0" });
  Object.assign(p, { q: 5, h: 6 });
  expect(s.current()).toEqual([{ q: 5, h: 6 }]);
});
```

```js
// test/framework/panel/custom-subcontrols.test.js
// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { buildControls } from "../../../src/framework/panel/render.js";

const root = () => { document.body.innerHTML = '<div id="root"></div>'; return document.getElementById("root"); };

test("host.controls mounts a built-in slider bound inside the owned value; edits commit the owning key", () => {
  const r = root();
  const params = { tiles: [{ q: 0, height: 10 }, { q: 1, height: 14 }] };
  let dirty = 0; const commits = [];
  let host;
  buildControls(r, [{ id: "s", controls: [{ key: "tiles", type: "custom", widget: (h) => { host = h; } }] }],
    params, () => dirty++, (keys) => commits.push(keys));
  const box = document.createElement("div");
  host.el.append(box);
  const stop = host.controls(box, [{ key: "height", label: "Height", min: 0, max: 30, step: 1 }], { path: "1" });
  expect(box.querySelector(".section .sec-header")).toBeNull();      // bare: no header
  expect(box.querySelector(".row label").textContent).toBe("Height");
  const slider = box.querySelector('input[type="range"]');
  expect(slider.value).toBe("14");
  slider.value = "20"; slider.dispatchEvent(new Event("input"));
  expect(params.tiles[1].height).toBe(20);
  expect(params.tiles[0].height).toBe(10);
  expect(dirty).toBeGreaterThan(0);
  expect(commits).toEqual([]);
  slider.dispatchEvent(new Event("change"));
  expect(commits).toEqual([["tiles"]]);
  stop();
  expect(box.querySelector('input[type="range"]')).toBeNull();
});

test("`when` inside a sub-panel evaluates against the scoped values", () => {
  const r = root();
  const params = { tiles: [{ kind: "flat", height: 3 }] };
  let host;
  buildControls(r, [{ id: "s", controls: [{ key: "tiles", type: "custom", widget: (h) => { host = h; } }] }], params, () => {});
  const box = document.createElement("div");
  host.controls(box, [
    { key: "kind", type: "radio", options: ["flat", "tall"] },
    { key: "height", label: "H", min: 0, max: 30, step: 1, when: { kind: "tall" } },
  ], { path: "0" });
  const heightWrap = box.querySelector(".slider");
  expect(heightWrap.classList.contains("hidden")).toBe(true);
  box.querySelectorAll(".seg button")[1].click();
  expect(params.tiles[0].kind).toBe("tall");
  expect(heightWrap.classList.contains("hidden")).toBe(false);
});

test("a custom control inside host.controls is dropped and reported; sub-panels die with the widget", () => {
  const r = root();
  const params = { tiles: [{ h: 1 }] };
  let host;
  const panel = buildControls(r, [{ id: "s", controls: [{ key: "tiles", type: "custom", label: "Tiles", widget: (h) => { host = h; } }] }], params, () => {});
  const box = document.createElement("div");
  host.el.append(box);
  host.controls(box, [
    { key: "h", label: "H", min: 0, max: 9, step: 1 },
    { key: "inner", type: "custom", widget: () => {} },
  ], { path: "0" });
  expect(box.querySelectorAll('input[type="range"]')).toHaveLength(1);
  expect(box.querySelector(".pf-custom")).toBeNull();
  expect(panel.errors()).toEqual([{ key: "tiles", label: "Tiles", phase: "create", message: 'custom control "inner" cannot be nested inside "tiles"' }]);
  panel.dispose();
  expect(box.querySelector('input[type="range"]')).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/framework/panel/scoped-params.test.js test/framework/panel/custom-subcontrols.test.js`
Expected: FAIL (stub proxy has no `set`; sections still render headers).

- [ ] **Step 3: Implement `scopedParams`**

Replace `src/framework/panel/scoped-params.js`:

```js
// A params-shaped view INTO a custom control's owned value, so the built-in
// control factories — which read and write `params[node.key]` and nothing
// else — can edit `tiles[3].height` without knowing they are inside a JSON
// value. Every read clones the owned value (read()) and every write hands a
// whole new value back (write(next)): the stored value is never mutated in
// place, which is what keeps the worker's cache keys and the relevance
// recorder honest.
//
// `path` is dotted from the owned value's root: "" (the root itself), "3"
// (the fourth array element), "walls.north". A write whose parent does not
// exist is refused and reported through onError, never thrown — a throwing
// params write inside a slider's input handler would take the panel down.
export function scopedParams({ read, write, path = "", onError }) {
  const segs = path === "" ? [] : String(path).split(".");
  const parentOf = (root) => {
    let cur = root;
    for (const s of segs) {
      if (cur === null || typeof cur !== "object") return null;
      cur = cur[s];
    }
    return cur !== null && typeof cur === "object" ? cur : null;
  };
  return new Proxy({}, {
    get(_, key) {
      if (typeof key !== "string") return undefined;
      const p = parentOf(read());
      return p ? p[key] : undefined;
    },
    has(_, key) {
      const p = parentOf(read());
      return typeof key === "string" && !!p && Object.hasOwn(p, key);
    },
    ownKeys() {
      const p = parentOf(read());
      return p ? Object.keys(p) : [];
    },
    getOwnPropertyDescriptor(_, key) {
      const p = parentOf(read());
      if (!p || typeof key !== "string" || !Object.hasOwn(p, key)) return undefined;
      return { value: p[key], enumerable: true, configurable: true, writable: true };
    },
    set(_, key, value) {
      if (typeof key !== "string") return false;
      const root = read();
      const p = parentOf(root);
      if (!p) { onError?.(`no value at path "${path}" to write "${key}" into`); return true; }
      p[key] = value;
      write(root);
      return true;
    },
  });
}
```

- [ ] **Step 4: Add `opts.bare` to the section loop in `render.js`**

Replace the `for (const section of tree) { … }` loop with:

```js
  for (const section of tree) {
    groupIds.add(section.id);
    const secEl = el("div", "section");
    nodeEls.set(section.id, secEl);
    const body = el("div", "sec-body");
    body.id = `pf-sec-${section.id.replaceAll("/", "-")}`;

    if (opts.bare) {
      // A sub-panel inside a custom control (host.controls): controls only,
      // no header row and no disclosure — the widget owns the framing.
      secEl.classList.add("bare");
      secEl.append(body);
    } else {
      const header = el("div", "sec-header");
      const title = el("button", "sec-title");
      title.type = "button";
      // The chev span carries NO text — its glyph comes from CSS (::before) —
      // because sectionByTitle-style lookups match `.sec-title` by exact
      // textContent === title (controls.test.js:210), and a text chevron here
      // would break that match.
      title.append(el("span", "sec-name", section.title ?? ""));
      header.append(title);
      // Row order: title (flex:1), then ⓘ, then the chevron on the far right.
      // The ⓘ is a SIBLING of the button, never a child: attachInfo appends a
      // <button>, and a button nested in a button is invalid HTML that never
      // receives clicks.
      attachInfo(header, section.description, info);
      header.append(el("span", "chev"));
      secEl.append(header);
      title.setAttribute("aria-controls", body.id);
      secEl.append(body);

      // The whole header row toggles: the title button's own click bubbles up
      // here, the chevron and the empty row space hit it directly, and the ⓘ
      // stops propagation in attachInfo. aria state stays on the title button.
      header.addEventListener("click", () => {
        const nowHidden = body.classList.toggle("hidden");
        title.setAttribute("aria-expanded", String(!nowHidden));
        secEl.classList.toggle("collapsed", nowHidden);
      });
      disclosures.set(section.id, { body, button: title, el: secEl });
    }

    // `preset` is filled in when a preset node renders. Controls read it late, so
    // one appearing after them in the children array still works.
    const ctx = { id: section.id, preset: null };
    rawSyncs.set(section.id, []);

    for (const child of section.children) renderNode(child, body, ctx);
    root.append(secEl);
  }
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/framework/panel/ test/framework/controls.test.js test/framework/rail.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/framework/panel/scoped-params.js src/framework/panel/render.js test/framework/panel/scoped-params.test.js test/framework/panel/custom-subcontrols.test.js
git commit -m "panel: host.controls — built-in controls scoped inside a custom value"
```

---

### Task 6: `mount({files, panelState})` and `runtime.getPanelState()` / `getPanelErrors()`

**Files:**
- Modify: `src/framework/mount.js` (`makeHandle` ~line 66; the `mount()` signature ~line 329; the option-docs comment block ~line 301; the `buildControls` call ~line 1010; the `makeHandle({...})` call ~line 1189)
- Modify: `types/index.d.ts` (`MountOptions`, the runtime handle; new `PanelError`, `CustomControlHost`, `CustomControlInstance`)
- Test: `test/framework/mount.test.js` (one added test)

**Interfaces:**
- Consumes: `panel.getState()`, `panel.errors()` (Task 4).
- Produces: `mount(part, {files?, panelState?, …})`; `runtime.getPanelState() → {[key]: state}`; `runtime.getPanelErrors() → PanelError[]`.

- [ ] **Step 1: Write the failing test**

Append to `test/framework/mount.test.js` (it already imports `mount`, `makeWorkers`, `makeElements`, `makePart`; `makePart` returns a part with `defaults: { h: 4, tilt: 0 }` — extend a copy of it here):

```js
test("mount carries files and panelState into custom controls and reads state/errors back", () => {
  const { workers, createWorker } = makeWorkers();
  const part = makePart();
  part.defaults.tiles = [{ q: 0 }];
  let host;
  part.parameters = [{ id: "t", title: "Tiles", controls: [
    { key: "tiles", type: "custom", label: "Tiles", widget: (h) => { host = h; } },
    { key: "bad", type: "custom", label: "Bad", widget: () => { throw new Error("nope"); } },
  ] }];
  part.defaults.bad = [];
  const runtime = mount(part, {
    createWorker, elements: makeElements(),
    files: { "assets/a.svg": "<svg/>" },
    panelState: { tiles: { selected: 2 } },
  });
  finishFirstBuild(workers);
  expect(host.file("assets/a.svg")).toBe("<svg/>");
  expect(host.state).toEqual({ selected: 2 });
  host.setState({ selected: 4 });
  expect(runtime.getPanelState()).toEqual({ tiles: { selected: 4 } });
  expect(runtime.getPanelErrors()).toEqual([{ key: "bad", label: "Bad", phase: "create", message: "nope" }]);
  runtime.dispose();
});

test("makeHandle defaults getPanelState/getPanelErrors when a mount resolves no panel", () => {
  const h = makeHandle({ ready: Promise.resolve(), dispose() {}, viewer: {}, setParams() {} });
  expect(h.getPanelState()).toEqual({});
  expect(h.getPanelErrors()).toEqual([]);
});
```

(`finishFirstBuild` is the file's existing helper that answers the fake workers' first build; use it exactly as the "ready resolves" test does. If `makePart` freezes its return, build a fresh object literal with the same fields instead of mutating.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/framework/mount.test.js -t "panelState"`
Expected: FAIL — `runtime.getPanelState is not a function`.

- [ ] **Step 3: Thread the options through `mount.js`**

`makeHandle` signature: add `getPanelState, getPanelErrors` to the destructured parameters, and in the returned object after `getViewerState`:

```js
    // Every custom control's transient state (selection, a scroll position),
    // keyed by param, as plain JSON — the panel's twin of getViewerState. Hand
    // it back as mount()'s `panelState` and a remount comes up with the same
    // tile selected. {} when the mount resolved no panel.
    getPanelState: getPanelState ?? (() => ({})),
    // What custom controls reported failing this mount ({key, label, phase,
    // message}), for a host to relay to whoever authored the part.
    getPanelErrors: getPanelErrors ?? (() => []),
```

`mount()` signature: add `files, panelState,` after `viewerState,`.

The option-docs comment block: after the `viewerState` entry add:

```js
// panelState: PanelState                 // a previous mount's runtime.getPanelState(): the transient
//                                         // state of the part's custom controls (a selected tile), keyed
//                                         // by param. Same remount story as viewerState; omit on a first
//                                         // mount. Never persisted by partforge.
// files: { [path]: string }              // the part's own source tree as text, for custom controls'
//                                         // host.file(path) — an SVG or a vector document that lives
//                                         // beside the code. Omit and host.file answers null.
```

The `buildControls` call: extend its opts object:

```js
      { fontCatalog, imageCatalog, onAssetUpload,
        declaredSource: declaredSourceLookup(part, params),
        files, panelState });
```

The `makeHandle({...})` call: add after `captureView,`:

```js
      getPanelState: () => panelRef?.getState() ?? {},
      getPanelErrors: () => panelRef?.errors() ?? [],
```

- [ ] **Step 4: Types**

`types/index.d.ts` — in `MountOptions` after `viewerState?`:

```ts
  /**
   * A previous mount's `runtime.getPanelState()`: the transient state of the
   * part's custom controls (a selected tile), keyed by param. Same remount
   * story as `viewerState`; omit on a first mount. Never persisted by partforge.
   */
  panelState?: PanelState | null;
  /**
   * The part's own source tree as text, for custom controls' `host.file(path)`.
   * Omit and `host.file` answers null.
   */
  files?: Record<string, string>;
```

On the runtime handle after `getViewerState()`:

```ts
  /** Every custom control's non-empty transient state, keyed by param. Hand back as `panelState`. */
  getPanelState(): PanelState;
  /** What custom controls reported failing this mount, in order. */
  getPanelErrors(): PanelError[];
```

New declarations beside `ViewerState`:

```ts
/** Custom controls' transient state, keyed by the param each control owns. Plain JSON. */
export type PanelState = Record<string, Record<string, unknown>>;

export interface PanelError {
  /** The param the failing control owns. */
  key: string;
  label: string;
  phase: "create" | "update" | "event" | "dispose" | "state";
  message: string;
}

/** What a `type: "custom"` control's `widget(host)` receives. */
export interface CustomControlHost {
  /** The slot to draw into, inside the rail. */
  el: HTMLElement;
  doc: Document;
  /** The param this control owns. */
  key: string;
  /** A structured clone of the current value of `key` (default: the owned key). */
  get(key?: string): unknown;
  /**
   * Replace a value. Refused (throws TypeError) for a key the control does not
   * own or a value outside the contract (owned key: a JSON value; `keys`: a
   * scalar). Stores a clone, schedules a rebuild, and commits unless
   * `commit: false` — then call `commit()` when the gesture ends.
   */
  set(value: unknown, opts?: { key?: string; commit?: boolean }): void;
  commit(keys?: string[]): void;
  /** The latest `derive()` output. */
  derived: Record<string, unknown>;
  /** Transient JSON state that survives a remount; never a param. */
  state: Record<string, unknown>;
  setState(patch: Record<string, unknown>): void;
  /** Mount built-in controls bound at `path` inside the owned value. Returns a disposer. */
  controls(container: HTMLElement, controls: import("./part.js").PanelEntry[], opts?: { path?: string }): () => void;
  /** Element builder; SVG tags get the SVG namespace, `on*` attrs become listeners. */
  h(tag: string, attrs?: Record<string, unknown>, ...children: unknown[]): Element;
  /** Parse an SVG string to its root element, or null. */
  svg(text: string): SVGSVGElement | null;
  /** Render a partforge-vector document to an inline `<svg>`, or null. */
  svgFromVector(doc: unknown): SVGSVGElement | null;
  /** Text of one of the part's own files, by path or `pfc-tree://` token, or null. */
  file(pathOrToken: string): string | null;
  readonly disabled: boolean;
}

export interface CustomControlInstance {
  update?(ctx: { reason: "sync" | "derived" | "restore"; disabled: boolean }): void;
  dispose?(): void;
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/framework/mount.test.js test/framework/mount-capture-view.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/framework/mount.js types/index.d.ts test/framework/mount.test.js
git commit -m "mount: files + panelState in, getPanelState/getPanelErrors out"
```

---

### Task 7: Lint rules for custom controls

**Files:**
- Modify: `src/framework/lint/rules-schema.js` (`control-default-not-primitive`; three new rules)
- Modify: `docs/AUTHORING-PARTS.md` (Rule catalog, "Parameter schema" paragraph ~line 2789)
- Test: `test/lint-schema.test.js`

**Interfaces:**
- Produces rule ids `custom-control-widget-not-function` (error), `custom-default-not-json` (error), `custom-keys-not-in-defaults` (error). `control-default-not-primitive` no longer fires on a `custom` control's own key.

- [ ] **Step 1: Write the failing tests**

Append to `test/lint-schema.test.js`:

```js
// `size` is bound to a slider so `default-not-exposed` stays quiet; it is the
// key the `keys` test below lists.
const customPart = (over = {}) => ({
  meta: { title: "Test", units: "mm" },
  parameters: [{ id: "t", title: "Tiles", controls: [
    { key: "tiles", type: "custom", label: "Tiles", widget: () => {}, ...over },
    { key: "size", label: "Size", min: 1, max: 40, step: 1 },
  ] }],
  defaults: { tiles: [{ q: 0, h: 10 }], size: 20 },
  parts: { body: { views: ["main"], build: (k) => k.box({ size: [1, 1, 1] }) } },
  views: { main: { label: "Main" } },
});

test("a custom control over a JSON default is clean — no primitive finding", () => {
  const r = lintPart(customPart());
  expect(ids(r.errors)).toEqual([]);
  expect(ids(r.warnings)).toEqual([]);
});

test("a custom control whose widget is not a function is an error", () => {
  const r = lintPart(customPart({ widget: "hexPicker" }));
  expect(ids(r.errors)).toContain("custom-control-widget-not-function");
  expect(find(r, "custom-control-widget-not-function").path).toBe("parameters[0].controls[0].widget");
  const missing = customPart(); delete missing.parameters[0].controls[0].widget;
  expect(ids(lintPart(missing).errors)).toContain("custom-control-widget-not-function");
});

test("a custom default outside the JSON contract is custom-default-not-json, with the reason", () => {
  const part = customPart(); part.defaults.tiles = [{ q: 0, h: null }];
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("custom-default-not-json");
  expect(ids(r.errors)).not.toContain("control-default-not-primitive");
  expect(find(r, "custom-default-not-json").message).toContain("is null at [0].h");
  expect(find(r, "custom-default-not-json").path).toBe("defaults.tiles");
  const fn = customPart(); fn.defaults.tiles = { f() {} };
  expect(ids(lintPart(fn).errors)).toContain("custom-default-not-json");
});

test("a scalar default on a custom control is fine, and a slider over an array still errs", () => {
  const scalar = customPart(); scalar.defaults.tiles = 3;
  expect(ids(lintPart(scalar).errors)).toEqual([]);
  const slider = customPart(); slider.parameters[0].controls[0] = { key: "tiles", label: "T", min: 0, max: 9, step: 1 };
  expect(ids(lintPart(slider).errors)).toContain("control-default-not-primitive");
});

test("keys a custom control may write must exist in defaults", () => {
  const r = lintPart(customPart({ keys: ["size", "missing"] }));
  expect(ids(r.errors)).toContain("custom-keys-not-in-defaults");
  expect(find(r, "custom-keys-not-in-defaults").message).toContain('"missing"');
  expect(find(r, "custom-keys-not-in-defaults").path).toBe("parameters[0].controls[0].keys[1]");
  expect(ids(lintPart(customPart({ keys: ["size"] })).errors)).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lint-schema.test.js`
Expected: the first custom test FAILs on `control-default-not-primitive`; the others on missing rule ids.

- [ ] **Step 3: Implement**

In `rules-schema.js`, add the import:

```js
import { jsonValueProblem } from "../panel/json-value.js";
```

In the `control-default-not-primitive` rule, add one filter after `.filter(({ container }) => !container)`:

```js
        // A custom control's OWN key may hold a JSON value; custom-default-not-json
        // (below) is its rule. Its `keys` stay under this one via their own controls.
        .filter(({ d }) => d.type !== "custom")
```

Append three rules to `SCHEMA_RULES` (before the closing `];`):

```js
  {
    // The whole feature is the function: a missing or non-function `widget`
    // renders the error card in the rail and nothing else, every time.
    id: "custom-control-widget-not-function",
    run: ({ part }) => collectDescriptors(part)
      .filter(({ container, authored, d }) => authored && !container && d.type === "custom" && typeof d.widget !== "function")
      .map(({ d, path }) => err("custom-control-widget-not-function",
        `custom control "${d.key}" has no \`widget\` function`,
        "Set `widget` to a function `(host) => …` — usually imported from a sibling file of the part — that draws into `host.el`. See \"Custom controls\" in AUTHORING-PARTS.md.",
        `${path}.widget`)),
  },
  {
    // The one relaxation of control-default-not-primitive: a custom control's
    // key may hold a JSON value (json-value.js), and nothing else — a host that
    // persists panel settings writes it back as a JSON literal.
    id: "custom-default-not-json",
    run: ({ part }) => {
      if (!isPlainObject(part?.defaults)) return [];
      const defaults = part.defaults;
      return collectDescriptors(part)
        .filter(({ container, authored, d }) => authored && !container && d.type === "custom")
        .filter(({ d }) => typeof d.key === "string" && Object.hasOwn(defaults, d.key))
        .map(({ d }) => ({ d, problem: jsonValueProblem(defaults[d.key]) }))
        .filter(({ problem }) => problem !== null)
        .map(({ d, problem }) => err("custom-default-not-json",
          `\`defaults.${d.key}\` ${problem}`,
          `Give "${d.key}" a JSON value: numbers, strings, booleans, arrays and plain objects of those, at most 16 KB and 8 levels deep, with no null. A custom control stores and persists its value as JSON, so anything else is silently lost on reload.`,
          `defaults.${d.key}`));
    },
  },
  {
    // `keys` are params the widget writes besides its own; each needs a
    // default or the write lands on a key the build never reads.
    id: "custom-keys-not-in-defaults",
    run: ({ part }) => {
      if (!isPlainObject(part?.defaults)) return [];
      const known = defaultKeys(part);
      const out = [];
      for (const { d, path, container, authored } of collectDescriptors(part)) {
        if (!authored || container || d.type !== "custom" || !Array.isArray(d.keys)) continue;
        d.keys.forEach((k, i) => {
          if (typeof k === "string" && known.has(k)) return;
          const hint = typeof k === "string" ? suggest(k, [...known]) : null;
          out.push(err("custom-keys-not-in-defaults",
            `custom control "${d.key}" lists key "${k}", which is not in \`defaults\``,
            `Add "${k}" to \`defaults\`${hint ? `, or correct it to "${hint}"` : ""} — a key the widget writes must exist for the build to read it.`,
            `${path}.keys[${i}]`));
        });
      }
      return out;
    },
  },
```

`docs/AUTHORING-PARTS.md` Rule catalog, the **Parameter schema** paragraph: add the three ids to the errors list, after `unknown-control-type`:

```md
`when-key-not-in-defaults`, `when-unknown-operator`, `unknown-control-type`,
`custom-control-widget-not-function`, `custom-default-not-json`,
`custom-keys-not-in-defaults` (errors);
```

and after the `mixed-section-shape` paragraph add:

```md
`custom-default-not-json` is `control-default-not-primitive`'s counterpart for a
`type: "custom"` control, whose key may hold a JSON value (see "Custom controls"):
it names the first member that is not one — `null`, a function, a class instance,
a forbidden key, or a value past the 16 KB / depth-8 caps.
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/lint-schema.test.js test/lint-source.test.js test/lint-purity.test.js test/error-patterns.test.js`
Expected: PASS. (`error-patterns.test.js` checks findings' `pattern` ids; the new rules carry none, which is allowed.)

- [ ] **Step 5: Commit**

```bash
git add src/framework/lint/rules-schema.js docs/AUTHORING-PARTS.md test/lint-schema.test.js
git commit -m "lint: custom-control-widget-not-function, custom-default-not-json, custom-keys-not-in-defaults"
```

---

### Task 8: Rail styles for custom controls

**Files:**
- Modify: `src/framework/app.css` (after the `button.ghost` rules, ~line 383)

- [ ] **Step 1: Add the rules**

Append after `button.action:disabled { … }`:

```css
/* Custom controls (type: "custom"): a part-authored widget in the rail. The
   slot inherits the rail's cascade (font, colours, --pf-* tokens); these rules
   give BARE elements the built-in controls' look so a widget written with
   plain <button>/<input>/<select> still reads as native, and provide two
   opt-in classes for SVG: .pf-hit (a clickable region) and .pf-drag (a
   dragged one — touch-action: none is what lets a finger drag it on a phone
   instead of scrolling the sheet). */
.pf-custom { margin: 9px 0; }
.pf-custom.hidden { display: none; }
.pf-custom-slot { display: flow-root; }
.pf-custom svg { display: block; max-width: 100%; height: auto; }
.pf-custom button {
  font: inherit; font-size: 12px; padding: 5px 9px; cursor: pointer;
  background: transparent; border: 1px solid var(--pf-border); color: var(--pf-text-2);
  border-radius: var(--pf-radius-control);
}
.pf-custom button:hover:not(:disabled) { background: var(--pf-surface-2); }
.pf-custom button:disabled { opacity: .5; cursor: default; }
.pf-custom input:not([type="range"]):not([type="checkbox"]):not([type="radio"]),
.pf-custom select {
  font: 12px/1.4 var(--pf-mono);
  background: var(--pf-input-bg); color: var(--pf-text-strong);
  border: 1px solid var(--pf-border); border-radius: var(--pf-radius-control); padding: 6px 8px;
}
.pf-custom input:focus, .pf-custom select:focus, .pf-custom button:focus-visible {
  outline: none; border-color: var(--pf-accent);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--pf-accent) 35%, transparent);
}
.pf-custom .pf-hit { cursor: pointer; }
.pf-custom .pf-hit:hover { fill: color-mix(in oklab, var(--pf-accent) 25%, transparent); }
.pf-custom .pf-hit.selected { fill: color-mix(in oklab, var(--pf-accent) 45%, transparent); stroke: var(--pf-accent); }
.pf-custom .pf-drag { touch-action: none; }
.pf-custom-error {
  margin: 4px 0; padding: 6px 8px; border: 1px solid var(--pf-err); border-radius: var(--pf-radius-control);
  color: var(--pf-err); font-family: var(--pf-mono); font-size: 11px; line-height: 1.4; word-break: break-word;
}
.pf-custom-error-title { font-weight: 600; margin-bottom: 2px; }
/* A sub-panel inside a custom control (host.controls): no header, no indent. */
.section.bare > .sec-body { padding: 0; }
```

- [ ] **Step 2: Check the build and the demo**

Run: `npm run build`
Expected: succeeds. Then `npm run dev`, open `/demo.html`, confirm the existing rail renders unchanged (no custom controls yet — this is a no-regression eyeball).

- [ ] **Step 3: Commit**

```bash
git add src/framework/app.css
git commit -m "css: rail styles for custom controls, error card, bare sub-panels"
```

---

### Task 9: Authoring docs, AGENTS.md, version bump, full suite

**Files:**
- Modify: `docs/AUTHORING-PARTS.md` (new `### Custom controls` after "Presets" ~line 945 and before "Legacy section shapes"; one paragraph under "Choosing a control" ~line 1145)
- Modify: `AGENTS.md` (the Architecture list mentions the panel modules — add one line)
- Modify: `package.json`, `package-lock.json` (version 0.114.0)

- [ ] **Step 1: Write the docs section**

Insert before `### Legacy section shapes (still supported)`:

````md
### Custom controls

A `type: "custom"` control renders a widget the part draws itself — a clickable hex
grid, an organizer whose walls toggle on click, a picture of the part's own outline
with hot regions. Reach for it when the user configures **many similar things
individually**, or makes a **spatial choice** no slider or select can express.
Never for a value an existing control already covers: a slider is still a slider.

```js
// part.js
import { tilePicker } from "./tile-picker.js";

export default {
  defaults: {
    tileSize: 20,
    tiles: [{ q: 0, r: 0, height: 10 }, { q: 1, r: 0, height: 14 }],
  },
  parameters: [{
    title: "Tiles",
    controls: [
      { type: "slider", key: "tileSize", min: 10, max: 40 },
      { type: "custom", key: "tiles", label: "Tile layout", widget: tilePicker,
        description: "Click a tile to select it. Drag to move it." },
    ],
  }],
  parts: { tiles: { build: (k, p) => /* p.tiles is the array */ } },
};
```

- `key` names the param the widget owns. It may hold a **JSON value**: numbers,
  strings, booleans, arrays and plain objects of those, at most 16 KB serialized and
  8 levels deep, never `null` (`custom-default-not-json`). `build()` reads it like any
  other param. This is the one place the "a control writes one scalar" rule is relaxed.
- `keys` (optional) lists further scalar params the widget may also write.
- `widget` is a function `(host) => …`, normally imported from a sibling file so
  `part.js` stays readable (`custom-control-widget-not-function`).
- `label`, `description`, `hidden`, `when` and `whenFalse` behave as on any control.

**The widget function.** It runs once per mount and draws into `host.el` with plain
DOM and SVG. It may return `{ update, dispose }`.

```js
// tile-picker.js
export function tilePicker(host) {
  const svg = host.h("svg", { viewBox: "0 0 200 160", width: "100%" });
  const detail = host.h("div");
  host.el.append(svg, detail);
  let stopDetail = null;

  function draw() {
    const tiles = host.get();                 // a fresh clone of the owned value
    const sel = host.state.selected ?? null;  // survives the remount an edit performs
    svg.replaceChildren(...tiles.map((t, i) => host.h("polygon", {
      points: hexPoints(t.q, t.r), class: i === sel ? "pf-hit selected" : "pf-hit",
      onpointerdown: () => { host.setState({ selected: i }); draw(); },
    })));
    stopDetail?.();
    stopDetail = sel === null ? null : host.controls(detail, [
      { type: "slider", key: "height", label: "Height", min: 4, max: 30 },
    ], { path: `${sel}` });
  }
  draw();
  return { update: draw, dispose: () => stopDetail?.() };
}
```

**The host.**

| Member | Meaning |
|---|---|
| `host.el`, `host.doc` | The slot to draw into, and its document. |
| `host.get(key?)` | A clone of the current value (default: the owned key). Any param is readable. |
| `host.set(value, {key?, commit?})` | Replace a value with a **new** one — never mutate what `get` returned. Schedules the rebuild and commits, unless `commit: false`; then call `host.commit()` when the gesture ends (a drag). Throws for a key you do not own or a value outside the contract. |
| `host.commit(keys?)` | Ends a deferred gesture. A no-op when nothing changed. |
| `host.derived` | The latest `derive()` output, the same object readouts show. |
| `host.state`, `host.setState(patch)` | Transient JSON (a selection, an open panel). Not a param, never persisted, but it **survives a remount**, which every edit performs. |
| `host.controls(container, controls, {path})` | Mount ordinary built-in controls bound *inside* the owned value at a dotted `path` (`"3"`, `"walls.north"`). Their edits commit the owning key. Returns a disposer. One level: no custom control inside. |
| `host.h(tag, attrs, ...children)` | Element builder. SVG tags get the SVG namespace; `on<event>` attrs become listeners; `class` and `style` pass through. |
| `host.svg(text)` | Parse an SVG string to an element you can append and wire up. |
| `host.svgFromVector(doc)` | A partforge-vector document → inline `<svg>` (the same renderer the `vector` control uses). |
| `host.file(pathOrToken)` | Text of one of the part's own files, by path or a `pfc-tree://` token, or null. |
| `host.disabled` | Whether a `when`/`whenFalse: "disable"` currently disables this control. |

`update({reason, disabled})` is called when your key changes from outside the widget
(`reason: "sync"` — a preset, undo, `setParams`), when `derived` changes
(`"derived"`), and once after `host.state` was restored on mount (`"restore"`). It is
**not** called for your own `set`. `dispose()` runs on teardown.

**Rules that keep it working.**

1. Size SVG with `viewBox` plus `width: 100%`. The rail is 288px wide by default and
   narrower on a phone, where it is the bottom sheet.
2. Use pointer events, not mouse events, and put `class="pf-drag"` (or
   `touch-action: none`) on anything dragged — otherwise a finger scrolls the sheet.
3. Keep selection and similar state in `host.state`, not in a closure: every edit
   remounts the part and your function runs again.
4. Hand `set` a new value. `get` returns a clone precisely so the stored value is never
   edited in place.
5. A throw anywhere in your code — creation, `update`, a listener, `dispose` —
   replaces the widget with an error card and reports it (a hosting agent sees it in
   the apply result as `panelErrors`). Other controls keep working.

**Looking native.** The slot inherits the rail's font, colours and light/dark theme.
Bare `<button>`, `<input>` and `<select>` elements pick up the built-in looks
automatically; the built-in classes are available by name for the exact thing:
`row`, `seg` (a segmented row of buttons), `action`, `ghost`, `num`, `text-input`,
`select-input`; and for SVG, `pf-hit` (clickable, with a `selected` state) and
`pf-drag`. Sub-controls mounted through `host.controls` *are* the built-in widgets.

**Reading the part's own files.** Artwork can live beside the code (the tree is text,
so an SVG, a `partforge-vector` JSON document or a JSON data file — not a PNG).
Two routes: store the SVG as a string in a JS module (`assets/emblem.svg.js` exporting
a template literal) and import it like any sibling file — no framework support
needed; or read it with `host.file("assets/emblem.svg")` and inline it with
`host.svg(text)`. Give regions ids and wire `pointerdown` on `#wall-3` to toggle
`walls[3]` in the owned value.

**What a widget cannot do.** No `fetch` (the hosted sandbox has no network), no
imports beyond the part's own files, nothing outside `host.el`, and no reading of
`params` except through `host`.
````

Under `### Choosing a control`, append a bullet:

```md
- **Many similar things configured individually, or a spatial choice** (which tiles
  exist and how tall each is; which walls of an organizer are present) →
  `"custom"`: a widget the part draws, holding one JSON value. See "Custom controls"
  above; use it only when no built-in control expresses the choice.
```

- [ ] **Step 2: AGENTS.md**

In `AGENTS.md`, append this bullet at the end of the `### Non-obvious invariants` section (the list that ends just before `### Wiring a part into an app`):

```md
- `type: "custom"` controls (`panel/widgets/custom.js`, `panel/scoped-params.js`,
  `panel/json-value.js`) run PART-AUTHORED functions in the panel's realm. The value
  contract is `isJsonValue`, shared with hosts through `partforge/panel-values`; a
  widget throw becomes an error card + `runtime.getPanelErrors()`, never a panel
  crash; `runtime.getPanelState()` / `mount({panelState})` is the panel twin of
  `viewerState`. Spec: `docs/superpowers/specs/2026-09-14-custom-panel-controls-design.md`.
```

- [ ] **Step 3: Bump the version**

Run:

```bash
npm pkg set version=0.114.0 && npm install --package-lock-only --ignore-scripts && git diff --stat package.json package-lock.json
```

Expected: both files show the version line changed and nothing else.

- [ ] **Step 4: Run everything**

Run: `npm test` then `npm run lint`
Expected: the whole vitest suite passes (`docs-coherence` sees `"custom"`; `lint-purity` still green; `registry` parity green) and ESLint is clean.

- [ ] **Step 5: Commit**

```bash
git add docs/AUTHORING-PARTS.md AGENTS.md package.json package-lock.json
git commit -m "docs: custom controls authoring section; 0.114.0"
```

Then open the PR from `claude/custom-panel-controls` against `main` with a reader-friendly description (what a custom control is, the two examples, the JSON-value relaxation, the new `partforge/panel-values` export, and that partforge-cloud's pin bump follows the publish).
