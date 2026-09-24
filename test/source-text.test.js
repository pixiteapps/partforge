// This package ships PLAIN ESM SOURCE and prose — the published files are the
// artifact, and every tool a reader reaches for treats them as text. A single
// stray control character breaks that quietly and completely: git marks the file
// binary and prints "Binary files … differ" instead of a diff (so the file is
// invisible in every review, local and on GitHub), `grep` skips it, and `file`
// reports `data`.
//
// That is not hypothetical. src/framework/lint/rules-vector.js shipped two raw
// NUL bytes as a dedup-key separator, and the whole module went unreviewed on its
// branch because no diff ever rendered it. Nothing in the suite noticed, because
// the RUNTIME behaviour was fine. So assert the property that actually matters:
// what we publish is text.
//
// Scope comes from package.json's `files` — the definition of "shipped" — rather
// than a hand-kept list here, so a new published path is covered the day it is
// added. That covers docs/ and README.md too, which are as much of the product as
// src/: AUTHORING-PARTS.md and VECTOR-FORMAT.md are what an authoring agent reads.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const read = (rel) => readFileSync(`${ROOT}/${rel}`, "utf8");
const pkg = JSON.parse(read("package.json"));

// Every extension under `files` must be classified. A file type that is neither
// is a failure, not a silent skip — the point is that nothing published escapes
// the question "is this text?".
const TEXT = new Set([".js", ".mjs", ".cjs", ".ts", ".css", ".md", ".json", ".svg", ".html", ".txt"]);
const BINARY = new Set([".stl", ".ttf", ".woff", ".woff2", ".png", ".wasm", ".jpg"]);

function* shipped(rel) {
  const full = `${ROOT}/${rel}`;
  const st = statSync(full, { throwIfNoEntry: false });
  if (!st) return;                                   // a `files` entry may be a glob or absent
  if (!st.isDirectory()) { yield rel; return; }
  for (const entry of readdirSync(full)) yield* shipped(`${rel}/${entry}`);
}

const all = [...new Set(pkg.files.flatMap((f) => [...shipped(f)]))];
const extOf = (rel) => (rel.includes(".") ? rel.slice(rel.lastIndexOf(".")) : "");

test("package.json `files` resolves to real published paths", () => {
  expect(all.length).toBeGreaterThan(50);
});

test("every shipped file's type is classified as text or binary", () => {
  const unknown = [...new Set(all.map(extOf))].filter((e) => !TEXT.has(e) && !BINARY.has(e));
  expect(unknown, [
    "These published file types are neither in TEXT nor BINARY above, so nothing",
    "checked whether they are readable as text. Classify them:",
    ...unknown.map((e) => `  ${e || "(no extension)"}`),
  ].join("\n")).toEqual([]);
});

// Tab, newline and carriage return are the only control characters a text file
// has any business containing. Everything else in C0 (plus DEL) is what makes git
// call the file binary.
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

test("no shipped text file contains a control character", () => {
  const bad = [];
  for (const rel of all) {
    if (!TEXT.has(extOf(rel))) continue;
    const m = FORBIDDEN.exec(read(rel));
    if (m) bad.push(`${rel} (U+${m[0].codePointAt(0).toString(16).padStart(4, "0").toUpperCase()} at offset ${m.index})`);
  }
  expect(bad, [
    "These published files contain a control character, so git treats them as",
    "binary and they will not render in any diff. Write the byte as an escape, or",
    "pick a printable separator (JSON.stringify of a tuple is one honest option):",
    ...bad.map((b) => `  ${b}`),
  ].join("\n")).toEqual([]);
});
