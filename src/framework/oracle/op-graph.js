// Which operation FIRST produced a different result between two builds. The hash
// graph comes from solid-hash.js's recorder; a hash absent from the previous build
// is a changed op, and a changed op whose inputs are all unchanged is a ROOT —
// everything downstream changed only because a root did. Pure; no kernel.

export function ancestry(record, finalHash) {
  const seen = new Set();
  const stack = [finalHash];
  while (stack.length) {
    const k = stack.pop();
    if (seen.has(k)) continue;
    seen.add(k);
    for (const i of record.get(k)?.inputs ?? []) stack.push(i);
  }
  return seen;
}

export function changedRoots(record, finalHash, baselineHashes, { max = 5 } = {}) {
  const anc = ancestry(record, finalHash);
  const isNew = (k) => record.has(k) && !baselineHashes.has(k);
  // Forward edges inside this sub-part's ancestry, for the label search.
  const consumers = new Map();
  for (const k of anc) for (const i of record.get(k)?.inputs ?? []) {
    if (!consumers.has(i)) consumers.set(i, []);
    consumers.get(i).push(k);
  }
  const labelFor = (k) => {
    const queue = [k];
    const seen = new Set();
    while (queue.length) {
      const c = queue.shift();
      if (seen.has(c)) continue;
      seen.add(c);
      const e = record.get(c);
      if (e?.op === "label" && e.label) return e.label;
      for (const n of consumers.get(c) ?? []) queue.push(n);
    }
    return null;
  };
  const out = [];
  for (const [k, e] of record) {
    if (out.length >= max) break;
    if (!anc.has(k) || !isNew(k)) continue;
    if (e.inputs.some(isNew)) continue;
    const label = labelFor(k);
    out.push(label ? { op: e.op ?? "op", label } : { op: e.op ?? "op" });
  }
  return out;
}
