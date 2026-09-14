# Custom panel controls: part-authored widgets in the rail

**Date:** 2026-09-14
**Status:** design, approved in brainstorm; implementation plans to follow
(one per repo)
**Repos:** partforge (core: registry entry, host API, lint, docs) and
partforge-cloud (persistence, wire, remount carry-over, agent feedback,
corpus regeneration)

## Summary

A part may declare a control of `type: "custom"` whose `widget` is a plain
JavaScript function. The panel calls that function once per mount with a slot
element and a small host object, and the widget draws whatever it wants into
the slot with DOM and SVG: a clickable hex grid, an organizer whose walls
toggle on click, a picture of the part's own outline with hot regions. The
control owns one param that may hold a bounded JSON value, so a layout of
many similar things persists as one entry in `defaults` and `build()` reads it
like any other param. Inside its slot the widget can mount ordinary built-in
controls bound to a path within that value, so "select a tile, then adjust its
height below" is composed from the sliders the rail already has. Ephemeral
widget state such as the current selection survives the remount every edit
performs, riding the same path the viewer's camera already does.

The brief was open-ended: a control style nobody has thought of yet must be
expressible. So the core is a function and an element, not a scene language.
The framework's job is to make that function safe to run (errors land on a
card, not the panel), cheap to persist (JSON in `defaults`), and honest to the
agent (a widget that throws is reported in the apply result the same turn).

## Goals

- A part author, human or model, writes a widget as a function in a sibling
  file of the part tree and registers it with one schema entry.
- The widget's own elements match the rail: tokens inherit, and the built-in
  control classes are available by name.
- Sub-controls inside a widget are the real built-in widgets, not lookalikes.
- A widget's value persists through the existing panel-settings save, as one
  key, with the existing undo, reset and chat-marker behaviour.
- Selection and similar transient state survive a remount.
- A broken widget never takes the panel down, and the model hears about it.
- Nothing changes for a part that declares no custom control.

## Non-goals (v1)

- Routing viewport picks into widgets. The pick hook is designed as a seam
  (see "Deferred") but not wired; it has to be reconciled with pick-to-chat
  first.
- A rail screenshot for the agent. Error reporting is the feedback loop.
- Raster images from Storage reaching the panel (`host.asset`). Tree files
  (text) are covered; rasters are a follow-up.
- A declarative scene language. Helpers may grow on top of the function
  contract later; the contract itself stays a function.
- A visual sandbox around the slot. A widget is part code and holds the same
  trust position `build()` does (see "Security").

## Background: what exists and what constrains the design

- **Controls are a closed registry.** `src/framework/panel/widget-specs.js`
  (`WIDGET_SPECS`) is the single source of truth for control types and their
  accepted fields; `src/framework/panel/widgets/index.js` (`WIDGET_FACTORIES`)
  holds the DOM factory per type. `render.js`'s `renderNode` looks a factory
  up by `node.type` and silently skips unknown types (lint reports them via
  `unknown-control-type`). A factory is called as
  `factory(node, params, {onChange, onCommit, info, fontCatalog, imageCatalog,
  onAssetUpload, declaredSource})` and returns `{el, sync, dispose?}`.
- **The part module and the rail share a realm.** `mount()` receives the
  imported part object directly and passes `part.parameters` to
  `buildControls` with no serialization; geometry runs in a separate import of
  the same file inside a Worker, and only `params` cross to it by
  `postMessage`. A function on a control descriptor is therefore callable by
  the panel and never reaches the worker.
- **`params` is one mutable object** (`mount.js`, `const params = {...part.defaults}`)
  that the built-in factories read and write as `params[node.key]`.
  `onDirty` → `onParamChange()` → `regen-loop` (180 ms debounce) → worker
  `generate`. Commit is separate: `onCommit` → `commit([node.key])` →
  `onParamsCommit({changed, params})`, never fired by `setParams()`.
- **Visibility, dimming and disabling** are one pure pass:
  `panel-state.js`'s `computeState(tree, {params, relevant})` applied by
  `render.js`'s `applyState` to every element registered in `nodeEls`.
- **The value contract is scalar.** Lint `control-default-not-primitive`
  (`rules-schema.js`, `isEditableValue`) requires a bound key's default to be
  a string, boolean or finite number; the source rule
  `control-default-not-literal` (`rules-source.js`) requires it to be spelled
  as a literal. In partforge-cloud, `src/parts/partDefaults.js` reads and
  writes only those spellings; `scanEntries` already spans nested `[]`/`{}`
  values (`scanValueEnd` is bracket-aware) but marks them unreadable.
- **The wire drops non-primitives.** partforge-cloud's
  `src/sandbox/protocol.js` `sanitizeParamsMap` silently drops any value that
  is not a primitive, in both `pfc-params-commit` (up) and `SET_PARAMS`
  (down). Caps: 256 keys, 64-char keys, 1024-char strings.
- **Every edit is a full remount in partforge-cloud**, a settings commit
  included (`mountManager.apply`: teardown, fresh scaffold, `mount()`), and
  `runtime.getViewerState()` is read before teardown and handed back as
  `mount({viewerState})` so the camera survives.
- **Tree files are text**, 32 files, 256 KB each, 2 MB total
  (`src/parts/partTree.js`). Vector artwork lives as a tree file named by a
  `pfc-tree://<path>?v=<hash>` token (`src/parts/treeTokens.js`), delivered
  to the geometry worker by `mountManager.syncTreeSources`; the panel has no
  route to tree bytes today, and a `data:` module has no base URL, so
  `new URL("./x.svg", import.meta.url)` does not work in the sandbox.
- **`vectorThumb(doc)`** (`src/framework/panel/widgets/vector-thumb.js`)
  renders a partforge-vector document to inline SVG on the main thread without
  the contour-ops chain.
- **Rail styles are class-based**: `.row label`, `.seg button`,
  `button.action`, `button.ghost`, `.num`, `.text-input`,
  `select.select-input`; only `input[type=range]` is styled at element level
  (`app.css`).
- **The agent corpus** (`prompts/authoring.md` in partforge-cloud) is
  generated from `docs/AUTHORING-PARTS.md` by `##` heading; "Parameters: the
  control-panel schema" is already a required section.

## 1. Authoring contract (partforge)

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

- `type: "custom"` joins `WIDGET_SPECS` as `kind: "control"` with fields
  `[...AUTHOR_COMMON, "widget", "keys"]`, and `AUTHOR_EXTRAS.custom =
  ["widget", "keys"]`. `author.js` already normalizes any control entry into
  `{kind: "control", type, key, ...}`; no change there.
- `key` (required) names the param the widget owns. It is the key `when`
  conditions, `revealParam` and relevance dimming address.
- `keys` (optional) lists further params the widget may write, for a widget
  that also drives ordinary scalars. Each must exist in `defaults`.
- `widget` (required) is a function `(host) => WidgetInstance | void`.
- The owned key's default may be a **JSON value**: string, boolean, finite
  number, array, or plain object, recursively; no `null`, no functions, no
  `__proto__`/`constructor`/`prototype` keys; at most 16 KB serialized and
  depth 8. Constants `CUSTOM_VALUE_MAX_BYTES = 16384` and
  `CUSTOM_VALUE_MAX_DEPTH = 8` live in a dependency-free module
  (`src/framework/panel/json-value.js`, exporting `isJsonValue(v)` and
  `jsonValueProblem(v)` for messages) so lint, the panel and the cloud can
  import the same predicate. Keys named in `keys` keep the scalar rule.
- `label`, `description`, `hidden`, `when`, `whenFalse` behave as on any
  control. The slot element is registered in `nodeEls` under the node id, so
  `applyState` toggles `hidden`, `irrelevant` and `disabled` on it exactly as
  for a slider.
- `build()`, `derive()`, `probes`, presets and animations are untouched. A
  preset may write a JSON value to a custom key.

## 2. Host API and lifecycle (partforge)

`WIDGET_FACTORIES.custom = makeCustom` (`src/framework/panel/widgets/custom.js`).
The factory builds a slot `<div class="pf-custom">`, constructs the host,
calls `node.widget(host)` inside a try/catch, and returns
`{el, sync, dispose}` like every other factory. `sync` is the factory's
external-change hook (called by `panel.syncValues` after `setParams`, presets,
undo) and it calls the widget's `update`.

### The host object

| Member | Meaning |
| --- | --- |
| `host.el` | The slot element inside the rail. Full width of the rail body. |
| `host.doc` | The document the slot lives in (`host.el.ownerDocument`). |
| `host.key` | The owned param key. |
| `host.get(key = host.key)` | A structured clone of the current value of `key`. Readable for the owned key, every key in `keys`, and any other param (read-only). |
| `host.set(value, {key = host.key, commit = true} = {})` | Replace a value. Refused (throws a `TypeError` naming the key) when `key` is neither the owned key nor in `keys`, or when the value fails `isJsonValue` (owned key) / the scalar rule (`keys`). Stores a clone, calls the factory's `onChange` (marks the panel dirty, debounced rebuild), and when `commit` is true calls `host.commit([key])`. |
| `host.commit(keys = [host.key])` | Ends a gesture: calls the factory's `onCommit` for each key so `onParamsCommit({changed, params})` fires. Idempotent; a commit with no prior `set` since the last commit is a no-op. |
| `host.derived` | The latest `derive()` output object, the same one readouts render from; updated before each `update` call. |
| `host.state` | Ephemeral JSON object, initially `{}` or the restored state (section 4). Never a param. |
| `host.setState(patch)` | Shallow-merges `patch` into `host.state`. Does not call `update`; the widget re-renders itself. |
| `host.controls(container, controls, {path} = {})` | Mount built-in controls bound inside the owned value at `path` (section 5). Returns a dispose function. |
| `host.h(tag, attrs = {}, ...children)` | Element builder. SVG tags (`svg`, `g`, `path`, `polygon`, `circle`, `rect`, `line`, `text`, `use`, `defs`, `clipPath`, ...) get the SVG namespace; everything else HTML. `on<event>` attrs become listeners; `class`, `style` (string) and every other attr are set verbatim; children may be nodes or strings. |
| `host.svg(text)` | Parse an SVG string (DOMParser, `image/svg+xml`) and return its root `<svg>` element, or `null` on a parse error. |
| `host.svgFromVector(doc)` | `vectorThumb(doc)`: a partforge-vector document to an inline `<svg>`, or `null`. |
| `host.file(pathOrToken)` | Text of a part tree file, or `null`. Accepts a bare path or a `pfc-tree://` token (prefix and `?v=` stamp stripped). Backed by the new `mount({files})` option; a host that passes none gets `null` for everything. |
| `host.disabled` | Boolean, mirrors the slot's `disabled` state; also passed to `update`. |

`host.get` always clones and `host.set` always stores a clone, so the value
the worker hashes and the relevance recorder reads is never mutated in place.
The doc states the rule plainly: hand `set` a new value; never edit what
`get` returned and expect it to stick.

### The widget instance

`widget(host)` returns `undefined` or `{update?, dispose?}`.

- `update({reason, disabled})` runs when an owned key (or one in `keys`)
  changes from outside the widget (`reason: "sync"`), when `derived` changes
  (`"derived"`), and once after state restore on mount (`"restore"`). It is
  NOT called for the widget's own `set` (the widget knows) nor for unrelated
  params.
- `dispose()` runs on `panel.dispose()`, after the widget's sub-control
  panels are disposed and before the slot is emptied.

### Error handling

Creation, `update`, `dispose` and every host callback into widget code
(`on<event>` listeners installed through `host.h` are wrapped too) run inside
a try/catch. On a throw:

- the slot's children are replaced with an error card (`<div class="pf-custom-error">`)
  showing the control's label and the error message, in the rail's existing
  warning style;
- the widget is retired for this mount (further `update`/listener calls are
  no-ops);
- the failure is recorded as `{key, label, phase, message}` with `phase` one
  of `create | update | event | dispose`, readable through `panel.errors()`
  and `runtime.getPanelErrors()`.

A throw in `dispose` is recorded and swallowed. Other controls are unaffected.

### Styling

- The slot inherits the rail cascade: font, text colors, `--pf-*` tokens,
  light/dark.
- `chrome.css` gains scoped defaults so bare elements look native inside a
  slot: `.pf-custom button` takes the `button.ghost` look, `.pf-custom
  input:not([type=range])` the `.text-input` look, `.pf-custom select` the
  `select.select-input` look. `.pf-custom svg` is `display: block; max-width:
  100%`. `.pf-custom .pf-hit` gets `cursor: pointer` and a hover/`.selected`
  fill and stroke from `--pf-accent`, and `touch-action: none` on `.pf-drag`.
- The doc names the class vocabulary a widget may use for the exact built-in
  look: `row`, `seg`, `action`, `ghost`, `num`, `text-input`, `select-input`,
  plus `pf-hit`, `pf-drag`, `pf-custom-error`.
- Mobile rules the doc states: size SVG with `viewBox` and `width: 100%`;
  use pointer events; put `pf-drag` (or `touch-action: none`) on anything
  dragged; keep selection in `host.state`.

### `mount({files})`

A new optional `mount()` option: `files: {[path]: string}`, the part's own
tree as text. It feeds `host.file` only. partforge-cloud passes
`sourceFiles.files` (already in hand for lint). The embedding-contract comment
block in `mount.js` documents it beside `viewerState`.

## 3. Structured values end to end

### partforge

- `isJsonValue` (section 1) is the one predicate.
- Lint: `control-default-not-primitive` exempts keys owned by a `custom`
  control (`ownedCustomKeys(part)` in `rules-schema.js`, derived from
  `collectDescriptors`); a new error rule `custom-default-not-json` reports an
  owned default that fails `isJsonValue`, with `jsonValueProblem`'s reason
  (size, depth, a forbidden key, a non-JSON member). A key listed in `keys`
  stays under the scalar rule.
- Source rule `control-default-not-literal`: for owned custom keys, a value
  span is acceptable when `readJsonLiteral(raw)` (below) reads it; an
  expression still errs. The reader lives in a dependency-free module so the
  cloud imports the same one (`src/framework/panel/json-literal.js`,
  exporting `readJsonLiteral(text) → {value} | null` and
  `writeJsonLiteral(value, {indent}) → string`).
- `readJsonLiteral` accepts: object and array literals, nested; bare
  identifier keys or quoted keys; string literals in single or double quotes
  (JS escapes, via the same decoding rule `partDefaults.js` uses today);
  decimal numbers (including negative and exponent forms); `true`/`false`;
  trailing commas; whitespace. It rejects anything else (comments inside the
  span, expressions, template literals, identifiers as values, `null`,
  computed keys, spreads), returning `null` so the entry reads as unreadable
  exactly as today.
- `writeJsonLiteral` emits compact JSON when the result fits in 80
  characters, else indented multi-line JSON (two spaces, relative to the
  entry's own indentation, passed in by the caller), so revision diffs of a
  large layout stay line-oriented. Keys are quoted (plain JSON) so the
  output is always readable by the same reader.
- Runtime: params already cross to the worker by structured clone and are
  hashed with `byteAwareReplacer`; a JSON value needs nothing new. The
  relevance recorder records top-level keys only, which is correct.

### partforge-cloud: the wire

`sanitizeParamValue` (`src/sandbox/protocol.js`) accepts a JSON value under
the same predicate (import `isJsonValue` from partforge, or a mirrored copy
if the package export is not yet pinned, with a test asserting parity). Caps:
16 KB serialized, depth 8, finite numbers, no forbidden keys; strings inside
keep the 1024-char cap. Applies to `sanitizeParamsMap` and therefore to both
`pfc-params-commit` and `SET_PARAMS`. `MAX_PARAM_KEYS` and `MAX_PARAM_KEY`
are unchanged. The sanitizer rebuilds the value (walks and copies) rather
than passing the received object through, matching the file's stance.

### partforge-cloud: persistence

`src/parts/partDefaults.js`:

- `readValue(raw)` tries the primitive spellings first, then
  `readJsonLiteral(raw)`. An entry whose value is a JSON literal is now
  `readable`.
- `serializeValue(value, indent)` uses `writeJsonLiteral` for arrays and
  objects. The entry's indentation is measured from the source (the column of
  the key) so a multi-line value nests correctly.
- `rewriteDefaults`: the `bad-value` check accepts `isJsonValue`; the
  self-verify step compares readable values by deep equality
  (`JSON.stringify` of the read value against the wanted value, both produced
  by the same reader so key order is stable). The splice model, the
  `no-known-keys` scoping and the outside-the-literal identity check are
  unchanged.
- `readDefaults` returns JSON values for readable entries, so
  `initialParams`, the Reset baseline and the authored-baseline walk see
  them.

`src/parts/settingsSession.js`: `known[k]` vs `params[k]` comparisons and the
`net` diff use a `sameValue(a, b)` helper (`Object.is` for primitives,
`JSON.stringify` equality for objects). Undo entries store clones.

`src/chat/messages.js` `makeSettingsMarker`: a non-primitive `before`/`after`
prints as compact JSON truncated to 120 characters with `…`, so the model sees
`tiles: [{"q":0,"r":0,"height":10},…] → […]`, never `[object Object]`.

`src/chat/defaultsWarning.js` `settingsSaveWarning`: an entry readable by
the extended `readValue` is savable; no warning.

## 4. Ephemeral panel state across remounts

- partforge: `runtime.getPanelState()` returns `{[key]: state}` for every
  custom control whose `host.state` is non-empty, each state passed through
  `isJsonValue` with a 64 KB total cap (a state over the cap is dropped, and
  the drop is recorded as a panel error with `phase: "state"` so it is not
  silent). `mount({panelState})` seeds `host.state` for matching keys before
  the widget function runs; the widget sees the restored state on creation
  and then receives `update({reason: "restore"})` once.
- partforge-cloud `mountManager.apply`: read `runtime?.getPanelState?.()`
  beside `getViewerState()` before `teardown()`, pass it as `panelState`
  beside `viewerState` on the next `mount()`. Null on the first apply and
  after `showEmpty()`, both correct. Optional-chained, so a partforge below
  the pinned floor loses only the carry-over.
- Nothing about `panelState` is persisted or sent to the app; it stays in the
  sandbox for the life of the page.

## 5. Sub-controls: `host.controls`

`host.controls(container, controls, {path})` mounts built-in controls whose
`key`s are paths inside the owned value.

- `path` is a dotted path from the owned value's root (`"3"`, `"walls.north"`);
  each control's `key` is appended to it. An empty `path` means the root.
- Implementation: a scoped params object, `scopedParams(host, path)`, a
  `Proxy` whose `get(key)` reads the current owned value at `path + key` and
  whose `set(key, v)` clones the owned value, writes `v` at that location
  (creating intermediate objects only when the parent exists; a write whose
  parent does not exist is refused and recorded as a panel error), and calls
  `host.set(next, {commit: false})`. The factory's `onCommit` for the
  sub-control calls `host.commit()`, so the commit names the OWNING key.
- The built-in factories only ever touch `params[node.key]` (verified for
  numeric, checkbox, select, radio, text), and `computeState` evaluates
  `when` against the same proxy, so `when` inside a sub-panel reads the
  scoped values.
- The call re-enters `buildControls(container, [{controls}], scoped,
  onDirty, onCommit, opts)` with a single untitled section, the factory's
  own `onChange`/`onCommit` as the callbacks, and the outer `opts`
  (`fontCatalog`, `imageCatalog`, `onAssetUpload`, `declaredSource`) passed
  through. `custom` inside a sub-panel is refused (one level; a nested
  custom control is a lint warning `custom-control-nested` and a runtime
  panel error).
- The returned dispose tears the sub-panel down; every open sub-panel is
  disposed automatically before the widget's own `dispose`.
- Sub-control `key` paths are not part registry keys, so
  `control-key-not-in-defaults` does not apply to them; a bad path fails at
  runtime as a panel error naming the path.

## 6. Errors, lint and what the agent hears

- Lint (partforge, all in `rules-schema.js` unless noted):
  - `custom-control-widget-not-function` (error): `widget` is missing or not
    a function.
  - `custom-default-not-json` (error): the owned default fails `isJsonValue`.
  - `control-default-not-primitive`: exempts owned custom keys.
  - `control-default-not-literal` (`rules-source.js`): accepts
    `readJsonLiteral` spellings for owned custom keys.
  - `custom-control-nested` (warning): a `custom` entry inside
    `host.controls` cannot be linted statically; this rule covers the static
    case of a `custom` control listed inside a `group` nested under another
    custom control's declared sub-controls, which does not exist in the
    schema, so in practice the rule is the runtime panel error above. Keep
    only the runtime check; drop this bullet if it has no static case at
    plan time.
  - `unknown-control-field` / `unknown-control-type` need no change beyond
    the registry entry.
- Runtime: `panel.errors()` → `runtime.getPanelErrors()` as in section 2.
- partforge-cloud: `mountManager.apply` reads `runtime?.getPanelErrors?.()`
  after mount and returns it as `panelErrors` on the apply result beside
  `lint` and `buildWarnings`; `sanitizeResult` in `protocol.js` allowlists
  the shape (array of `{key, label, phase, message}` with bounded strings,
  at most 32 entries). `src/chat/toolCall.js`'s apply-result text adds one
  line per entry: `custom control "tiles" (Tile layout) threw during render:
  TypeError: …`. The `apply_part_changes` tool description mentions
  `panelErrors` in one sentence. Neither `ok` nor the tree hash is affected:
  a widget error is a warning class, since the geometry built.

## 7. Documentation and the agent corpus

`docs/AUTHORING-PARTS.md` gains `### Custom controls` inside "Parameters: the
control-panel schema", after "Control types", covering in order:

1. When to use one: many similar things configured individually, or a spatial
   choice a slider or select cannot express. Never for a value an existing
   control already covers.
2. The schema entry and the JSON value rule (with the size and depth caps).
3. The host API table and the widget instance contract.
4. One complete example: a tile picker with a selected tile's slider mounted
   through `host.controls`, using `host.state` for the selection.
5. The four mobile rules, the immutability rule, the class vocabulary.
6. Reading the part's own files: the string-module route
   (`assets/emblem.svg.js` exporting a template literal, imported like any
   sibling file) and `host.file` for `.svg` / `.vector.json` / `.json` files,
   with `host.svg` and `host.svgFromVector`.
7. What a widget cannot do: no `fetch`, no imports beyond the part's files,
   no reaching outside `host.el`, no reading `params` except through `host`.

"Choosing a control" (under "Designing the control panel") gains one
paragraph pointing at the section. The control-types table gains a `custom`
row.

The corpus picks the subsection up on the next `npm run docs:generate && npm
run prompt:generate` in partforge-cloud because its parent `##` section is
already required. The cloud plan must check that the compact and focused
prompt variants keep the subsection, and add it to their selection if they
trim by `###`.

## 8. Testing

partforge (`test/framework/panel/`), under happy-dom:

- registry parity (existing test) covers the new type;
- `custom.test.js`: creation renders into the slot; `sync` calls `update`
  with `reason: "sync"`; `host.set` marks dirty and commits the owning key;
  `commit: false` plus `host.commit()` produces one commit; refused writes
  throw and record nothing; a throwing widget yields the error card, a
  recorded `{phase: "create"}` entry and an intact sibling control; a
  throwing listener installed through `host.h` retires the widget;
  `dispose` order (sub-panels first);
- `scoped-params.test.js`: reads and writes at a path, refusal of a missing
  parent, `when` evaluated against scoped values, commit names the owning
  key;
- `panel-state.test.js`: `getPanelState` round-trips through
  `mount({panelState})`, the cap drops and records;
- `json-value.test.js` and `json-literal.test.js`: the predicate and the
  reader/writer, including every rejection listed in section 3;
- lint rule tests for the three new or changed rules;
- `mount({files})` feeding `host.file`, path and token forms.

partforge-cloud:

- `part-defaults.test.js`: JSON entries read; rewrite splices only the value
  span and preserves comments and other entries byte-for-byte; compact vs
  multi-line output; self-verify passes on deep-equal values and refuses on
  a mis-bounded scan;
- `protocol.test.js`: JSON values pass the sanitizer within caps and are
  rebuilt, not passed through; over-cap and forbidden-key values drop;
- `settings-session.test.js`: object diffs, undo clones, marker text;
- `mount-manager.test.js`: `panelState` carried across `apply`, `panelErrors`
  on the result;
- `tool-call` text test for the error line;
- one Playwright sandbox smoke (`tests/smoke/custom-control.spec.js`): a
  fixture part with a custom control mounts, a click commits the owning key
  with a JSON value, an apply remounts and the selection survives.

## 9. Rollout and versioning

1. partforge PR on `claude/custom-panel-controls`: registry, factory, host,
   scoped params, panel state, lint, CSS, docs, tests; version 0.114.0 in the
   same PR (minor: new public surface). Publish happens on merge.
2. partforge-cloud PR: pin `partforge` ≥ 0.114.0; `npm run docs:generate &&
   npm run prompt:generate` and read the prompt diff; `partDefaults.js`,
   `protocol.js`, `settingsSession.js`, marker, `defaultsWarning.js`,
   `mountManager.js` (`files`, `panelState`, `panelErrors`), `toolCall.js`
   text, tests, the sandbox smoke. AGENTS.md's viewer section gains the
   version floor line and `docs/agents/viewer-and-sandbox.md` the narrative.
3. No migration, no environment variable, no behaviour change for existing
   parts. Every new runtime hop in the cloud is optional-chained, so a cloud
   deployment ahead of the pin loses only the carry-over and the error
   report.

## 10. Security and accepted risks

- A widget runs the author's code, for every visitor of a public forge,
  inside the null-origin sandbox iframe. That is the trust position `build()`
  already holds; the iframe boundary and `host.js`'s parent-window sender
  check are unchanged, and nothing new crosses to the app except the
  sanitized commit and the allowlisted `panelErrors`. Accepted: a widget can
  draw anything into the rail, including misleading UI. No visual sandbox is
  added.
- JSON values now cross the wire and land in `defaults`. Caps (16 KB, depth
  8, forbidden keys) bound the cost on both sides, and the source writer
  emits plain JSON so a value can never smuggle code into the literal.
- `host.svg` parses author-supplied SVG into the iframe DOM, scripts and all.
  Since the same author's module already executes there, no sanitizer is
  added; the doc says so.
- `host.file` exposes the part's own tree to the part's own code, which
  `read_part_files` already exposes to the agent and Storage exposes to the
  owner. No new information flow.

## 11. Deferred and follow-ups

- **Viewport picks into widgets.** Seam: a future
  `host.onPick(listener)` fed from `mount({onPick})`'s structured `Selection`
  (`selection/resolve.js`), gated on a part-level opt-in so pick-to-chat is
  not silently hijacked. Requires deciding how a pick that a widget consumes
  interacts with the chat chip. Not in v1.
- **`host.asset(token)`** returning a blob URL for `pfc-asset://` rasters the
  sticky assets channel already carries into the sandbox.
- **A rail capture** for the agent (DOM-to-image inside the iframe) if error
  reporting proves insufficient.
- **A helper kit** (`hexGrid`, `gridCells`, canned pickers) on top of the
  function contract, once two or three real widgets show the shared shapes.
- **Compact prompt variants** may need an explicit selection for the
  subsection (checked in the cloud plan).

## 12. Open checks for the implementation plans

- Confirm nothing in partforge-cloud structured-clones or JSON-serializes
  `part.parameters` (the `list-parts` RPC returns sub-parts only; `sanitizeResult`
  never sees the schema). A function-valued `widget` must never hit a clone.
- Confirm partforge's `test/lint-purity.test.js` accepts `json-value.js` and
  `json-literal.js` as lint imports (both must import nothing).
- Confirm the built-in `font`, `image` and `vector` factories also only
  touch `params[node.key]`, or exclude them from `host.controls` with a clear
  error if they read the whole map.
- Decide whether partforge exports `isJsonValue`/`readJsonLiteral` from a
  public entry (`partforge/panel`) for the cloud to import, or the cloud
  mirrors them with a parity test. Prefer the export.
