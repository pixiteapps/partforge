// File names inside the kit, shared by every section: a path segment from an author
// string, the first free name in definition order, merging of equal items, the README's
// RENAMED FILES record, and the progress phase cap.
import { safeName } from "../../safe-name.js";

// A path segment from an author string. safeName already lowercases, collapses runs and
// refuses a leading dot or dash; folding every run of dots on top means no entry name
// can ever carry "..". safeName keeps a leading underscore, which the entry patterns
// (kit/entries.js, copied by the cloud) refuse, so it comes off here too — a sub-part
// keyed `_left` is `left`, never a kit that fails at its last step — and a name that was
// nothing but separators falls back to "part".
export const kitName = (s) => safeName(s, "part").replace(/\.{2,}/g, ".").replace(/^[._-]+/, "") || "part";

// The first of base, base-2, base-3, … whose files are all free, claimed in `taken`.
// `filesOf(name)` lists every path a name produces — a piece's cut file and its -marks
// file — so a name is free only when all of them are, and "front" ×2 can never land on
// the file of a piece literally named "front-x2". Called in definition order, so a
// forge always gets the same names.
export function uniqueName(base, taken, filesOf = (name) => [name]) {
  let name = base;
  for (let i = 2; filesOf(name).some((f) => taken.has(f)); i++) name = `${base}-${i}`;
  for (const f of filesOf(name)) taken.add(f);
  return name;
}

// One section's names. `claim(base, filesOf, labels)` hands out a unique name; a name
// that was taken moves to name-2, and `renamed` gets the README's RENAMED FILES line
// saying which file it was and who held the name (spec D.10).
export function namer() {
  const taken = new Set();
  const owners = new Map();
  const renamed = [];
  const claim = (base, filesOf, labels) => {
    const name = uniqueName(base, taken, filesOf);
    const file = filesOf(name)[0];
    if (name !== base) {
      const holder = filesOf(base).map((f) => owners.get(f)).find(Boolean);
      renamed.push(`${file}: ${labels.join(", ")}${holder ? ` (renamed: ${holder.file} is ${holder.labels.join(", ")})` : ""}`);
    }
    for (const f of filesOf(name)) owners.set(f, { file, labels });
    return name;
  };
  return { claim, renamed };
}

// Merge equal items, first-seen order kept. `hashOf` only NOMINATES candidates — the kit
// hashes with solid-hash.js's 32-bit FNV, which can collide — and `same(a, b)` confirms.
// Returns [{ item, members }], `item` being the first member.
export function dedupe(items, hashOf, same) {
  const groups = [];
  const byHash = new Map();
  for (const item of items) {
    const key = hashOf(item);
    const candidates = byHash.get(key) ?? [];
    const hit = candidates.find((g) => same(g.item, item));
    if (hit) { hit.members.push(item); continue; }
    const group = { item, members: [item] };
    candidates.push(group);
    byHash.set(key, candidates);
    groups.push(group);
  }
  return groups;
}

// cl:src/sandbox/protocol.js clips a progress phase at 120 characters; the kit keeps
// its own phases under that, so a long label is cut here, once, with an ellipsis.
const PHASE_MAX = 120;
export const clipPhase = (s) => (s.length > PHASE_MAX ? `${s.slice(0, PHASE_MAX - 1)}…` : s);

// Entry bytes as a Uint8Array, whatever the writer returned.
export const bytesOf = (data) => (data instanceof Uint8Array ? data
  : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data));
