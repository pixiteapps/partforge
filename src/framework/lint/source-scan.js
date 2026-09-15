// Source-text scanning for partforge/lint's SOURCE_RULES. The scanner is a
// verbatim port of the READ half of partforge-cloud's
// src/parts/partDefaults.js — the module that persists panel settings by
// rewriting the defaults literal. THE READABILITY PREDICATE MUST MATCH THAT
// REWRITER EXACTLY: a value this scanner passes but the rewriter refuses is a
// silent regression of the incident the control-default-not-literal rule
// exists to prevent (a `13 / 3` default that builds green and loses the
// user's panel edits). partforge-cloud carries a parity test against a shared
// fixture corpus; change the predicate only in both places together.
//
// Zero dependencies, no AST: this file must stay inside lint's pure import
// closure (test/lint-purity.test.js) so lintPart keeps running in Node, the
// browser sandbox iframe, and Deno.
//
// The one exception is json-value.js, which itself imports nothing — the
// shared predicate for a `type: "custom"` control's value.
//
// KNOWN BLIND SPOT — regex literals are not tokenized: a `/[/*]/` or `/x\/y/`
// reads as a comment opener and can blank the rest of the file, and a regex
// containing a quote can likewise derail string skipping.
// It is parity-correct (the cloud rewriter has the same gap) and fails toward
// FALSE NEGATIVES — a derailed scan finds no defaults literal and no tokens,
// so a rule says nothing rather than something wrong.

import { isJsonValue } from "../panel/json-value.js";

// Span of the object literal after the first `defaults:` key (indices into
// `source`, end exclusive, covering `{...}`). String- and comment-aware so a
// "defaults: {" inside a string or comment can't fool the scan.
export function findDefaultsLiteral(source) {
  if (typeof source !== "string") return null;
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < source.length && source[i] !== quote) i += source[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") { while (i < source.length && source[i] !== "\n") i++; continue; }
    if (c === "/" && source[i + 1] === "*") { const j = source.indexOf("*/", i + 2); if (j === -1) return null; i = j + 2; continue; }
    const m = /^defaults\s*:\s*\{/.exec(source.slice(i));
    if (m && (i === 0 || /[\s{,]/.test(source[i - 1]))) {
      const start = i + m[0].length - 1; // the "{"
      let depth = 0;
      let k = start;
      while (k < source.length) {
        const ch = source[k];
        if (ch === '"' || ch === "'" || ch === "`") {
          const quote = ch;
          k++;
          while (k < source.length && source[k] !== quote) k += source[k] === "\\" ? 2 : 1;
          k++;
          continue;
        }
        if (ch === "/" && source[k + 1] === "/") { while (k < source.length && source[k] !== "\n") k++; continue; }
        if (ch === "/" && source[k + 1] === "*") { const j = source.indexOf("*/", k + 2); if (j === -1) return null; k = j + 2; continue; }
        if (ch === "{") depth++;
        else if (ch === "}") { depth--; if (depth === 0) return { start, end: k + 1 }; }
        k++;
      }
      return null;
    }
    i++;
  }
  return null;
}

// --- entry scanning -------------------------------------------------------
//
// Every helper here takes an explicit `end` bound and reports an index back,
// so a run it cannot terminate (an unclosed string, a runaway comment) stops
// at the bound instead of walking off the literal.

// Whitespace and comments from `i`.
function skipTrivia(text, i, end) {
  for (;;) {
    while (i < end && /\s/.test(text[i])) i++;
    if (text[i] === "/" && text[i + 1] === "/") { while (i < end && text[i] !== "\n") i++; continue; }
    if (text[i] === "/" && text[i + 1] === "*") {
      const j = text.indexOf("*/", i + 2);
      if (j === -1 || j >= end) return end;
      i = j + 2;
      continue;
    }
    return i;
  }
}

// Index just past a '…' / "…" run starting at its own quote.
function skipQuoted(text, i, end) {
  const quote = text[i];
  i++;
  while (i < end && text[i] !== quote) i += text[i] === "\\" ? 2 : 1;
  return Math.min(i + 1, end);
}

// Index just past a `…` run, stepping over ${…} interpolations so a comma or
// brace inside one cannot end the value early.
function skipTemplate(text, i, end) {
  i++;
  while (i < end) {
    const c = text[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "`") return i + 1;
    if (c === "$" && text[i + 1] === "{") { i = skipInterpolation(text, i + 2, end); continue; }
    i++;
  }
  return end;
}

function skipInterpolation(text, i, end) {
  let depth = 1;
  while (i < end) {
    const c = text[i];
    if (c === '"' || c === "'") { i = skipQuoted(text, i, end); continue; }
    if (c === "`") { i = skipTemplate(text, i, end); continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
    i++;
  }
  return end;
}

// The end of one value: the next top-level `,` or the literal's own `}`.
// Bracket-, string- and comment-aware, so an expression, an array or a nested
// object is spanned WHOLE even though it will not be read.
function scanValueEnd(text, i, end) {
  let depth = 0;
  while (i < end) {
    const c = text[i];
    if (c === '"' || c === "'") { i = skipQuoted(text, i, end); continue; }
    if (c === "`") { i = skipTemplate(text, i, end); continue; }
    if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) { i = skipTrivia(text, i, end); continue; }
    if (c === "(" || c === "[" || c === "{") { depth++; i++; continue; }
    if (c === ")" || c === "]" || c === "}") { if (depth === 0) return i; depth--; i++; continue; }
    if (c === "," && depth === 0) return i;
    i++;
  }
  return end;
}

// JS's own single-character escapes. An escape outside this set is the
// character itself (`\a` is "a"), which is JS's rule rather than a guess;
// the sequences that are NOT decodable that way — legacy octal, a malformed
// \x/\u — return null and leave the key un-editable.
const SIMPLE_ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };

// A quoted literal (quotes included) → its string value, or null when it is
// not exactly one complete string.
function decodeStringLiteral(raw) {
  const quote = raw[0];
  if ((quote !== '"' && quote !== "'") || raw.length < 2 || raw[raw.length - 1] !== quote) return null;
  let out = "";
  for (let i = 1; i < raw.length - 1; i++) {
    const c = raw[i];
    if (c === quote) return null;                // closed early: this is not one string
    if (c === "\n" || c === "\r") return null;    // an unescaped newline is a syntax error
    if (c !== "\\") { out += c; continue; }
    const e = raw[++i];
    if (e === undefined) return null;
    if (e === "\n" || e === "\u2028" || e === "\u2029") continue;          // line continuation
    if (e === "\r") { if (raw[i + 1] === "\n") i++; continue; }
    if (e === "x") {
      const h = raw.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(h)) return null;
      out += String.fromCharCode(Number.parseInt(h, 16));
      i += 2;
      continue;
    }
    if (e === "u") {
      if (raw[i + 1] === "{") {
        const close = raw.indexOf("}", i + 2);
        const h = close === -1 ? "" : raw.slice(i + 2, close);
        if (!/^[0-9a-fA-F]{1,6}$/.test(h) || Number.parseInt(h, 16) > 0x10ffff) return null;
        out += String.fromCodePoint(Number.parseInt(h, 16));
        i = close;
        continue;
      }
      const h = raw.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(h)) return null;
      out += String.fromCharCode(Number.parseInt(h, 16));
      i += 4;
      continue;
    }
    if (/[1-9]/.test(e) || (e === "0" && /\d/.test(raw[i + 1] ?? ""))) return null; // legacy octal
    out += Object.hasOwn(SIMPLE_ESCAPES, e) ? SIMPLE_ESCAPES[e] : e;
  }
  return out;
}

// Numeric literals JS accepts and this module can round-trip. Deliberately not
// hex, separators or bigint: those stay un-editable rather than being rewritten
// into a different spelling of themselves.
const NUMBER_RE = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

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

// A key at `i`: identifier or quoted string. → { key, next } or null.
function readKey(text, i, end) {
  const q = text[i];
  if (q === '"' || q === "'") {
    const next = skipQuoted(text, i, end);
    const key = decodeStringLiteral(text.slice(i, next));
    return key === null ? null : { key, next };
  }
  const m = /^[A-Za-z_$][\w$]*/.exec(text.slice(i, end));
  return m ? { key: m[0], next: i + m[0].length } : null;
}

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

// Split `{ … }` into entries in source order. `readable` says whether the
// value was interpreted; `raw` is its exact source text either way, and
// valueStart/valueEnd are its span (indices into `text`), which is what a
// rewrite splices. An entry that is not a `key: value` pair at all — a spread,
// a computed key, a method — is spanned and kept as an unreadable, unnamed
// entry so the rest of the literal still reads.
//
// Null ONLY when `text` is not a braced object; an object whose every entry is
// unreadable is a valid scan of zero readable keys.
function scanEntries(text) {
  const open = skipTrivia(text, 0, text.length);
  if (text[open] !== "{") return null;
  let close = text.length;
  while (close > open && /\s/.test(text[close - 1])) close--;
  if (text[close - 1] !== "}") return null;
  const end = close - 1; // the closing brace
  const entries = [];
  let i = open + 1;
  for (;;) {
    i = skipTrivia(text, i, end);
    if (i >= end) return entries;
    const start = i;
    const k = readKey(text, i, end);
    let entry = null;
    if (k) {
      const afterKey = skipTrivia(text, k.next, end);
      if (text[afterKey] === ":") {
        const valueStart = skipTrivia(text, afterKey + 1, end);
        let valueEnd = scanValueEnd(text, valueStart, end);
        while (valueEnd > valueStart && /\s/.test(text[valueEnd - 1])) valueEnd--;
        const raw = text.slice(valueStart, valueEnd);
        const read = readValue(raw);
        entry = { key: k.key, valueStart, valueEnd, raw, readable: !!read, value: read?.value };
        i = valueEnd;
      }
    }
    if (!entry) {
      const stop = scanValueEnd(text, start, end);
      entry = { key: null, valueStart: start, valueEnd: stop, raw: text.slice(start, stop), readable: false };
      i = stop;
    }
    entries.push(entry);
    i = skipTrivia(text, i, end);
    if (text[i] !== ",") return entries; // no separator: nothing further can be read
    i++;
  }
}

// The literal's entries with ABSOLUTE value offsets into `source`, so a rule
// can report file + line. Null when there is no defaults literal (or it is
// unscannable) — a rule treats that as "nothing to say", never an error.
export function defaultsEntriesIn(source) {
  if (typeof source !== "string") return null;
  const span = findDefaultsLiteral(source);
  if (!span) return null;
  const entries = scanEntries(source.slice(span.start, span.end));
  if (!entries) return null;
  return entries.map((e) => ({
    key: e.key, raw: e.raw, readable: e.readable, index: span.start + e.valueStart,
  }));
}

// Which file the settings session would write — same preference order as the
// cloud rewriter's findDefaultsFile/readDefaultsEntries: entrypoint first, then
// any file whose literal has a readable entry. The third tier — falling back
// to the first literal found anywhere, even wholly unreadable — is a
// DELIBERATE divergence from cloud's findDefaultsFile, which returns null
// there: a lint rule still needs to name the right file for a part whose only
// defaults literal has no readable entry at all.
export function pickDefaultsFile(files, entrypoint) {
  if (!files || typeof files !== "object") return null;
  const paths = [entrypoint, ...Object.keys(files).filter((p) => p !== entrypoint)]
    .filter((p) => typeof p === "string" && typeof files[p] === "string");
  let firstFound = null;
  for (const path of paths) {
    const entries = defaultsEntriesIn(files[path]);
    if (!entries) continue;
    const found = { path, source: files[path], entries };
    if (entries.some((e) => e.readable)) return found;
    firstFound ??= found;
  }
  return firstFound;
}

// `source` with every string, template and comment interior blanked to
// spaces — same length, newlines preserved — so a token scan over the result
// can never match inside a string or comment and lineOf stays accurate.
export function stripNonCode(source) {
  if (typeof source !== "string") return "";
  const out = source.split("");
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '"' || c === "'") { const end = skipQuoted(source, i, source.length); blank(i + 1, end - 1); i = end; continue; }
    if (c === "`") { const end = skipTemplate(source, i, source.length); blank(i + 1, end - 1); i = end; continue; }
    if (c === "/" && source[i + 1] === "/") { let j = i + 2; while (j < source.length && source[j] !== "\n") j++; blank(i, j); i = j; continue; }
    if (c === "/" && source[i + 1] === "*") { const j = source.indexOf("*/", i + 2); const end = j === -1 ? source.length : j + 2; blank(i, end); i = end; continue; }
    i++;
  }
  return out.join("");
}

export function lineOf(text, index) {
  if (typeof text !== "string") return 1;
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") n++;
  return n;
}
