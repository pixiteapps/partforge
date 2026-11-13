import { zipSync } from "fflate";
import { safeName } from "./safe-name.js";
import { KIT_KINDS, MODEL_KINDS, bareEntry } from "./export/kit/entries.js";

// Browser file-download helpers. Pure DOM/Blob utilities with no app state — the
// worker produces the bytes; these just hand them to the browser as a download.
//
// `sink` is an optional escape hatch for embedders that cannot download from
// their own document — e.g. partforge running inside a null-origin sandboxed
// iframe, where a blob: URL is blob:null and browsers such as WebKit refuse to
// load it. When `sink` is supplied it receives the FINAL bytes and no DOM work
// happens here; the embedder saves them from a context that can.

// Trigger a download of one binary blob under `filename` (or hand it to `sink`).
export function triggerDownload(data, filename, mime, sink) {
  if (typeof sink === "function") { sink({ data, filename, mime }); return; }
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Download a set of built parts: a single part downloads directly; multiple parts
// are bundled into one flat, store-only (level 0) zip named `zipName`. `sink`, if
// given, is forwarded to triggerDownload so it receives the final bytes.
//
// Sub-part names come from the part's `export.name` — untrusted data — and become
// zip entry names, so they go through safeName(): the zip must stay flat, and an
// entry like "../evil.stl" would escape the target directory in naive extractors.
export function downloadParts({ parts, ext, mime }, zipName, sink) {
  if (parts.length === 1) return triggerDownload(parts[0].data, `${safeName(parts[0].name)}.${ext}`, mime, sink);
  const entries = {};
  for (const p of parts) entries[`${safeName(p.name)}.${ext}`] = new Uint8Array(p.data);
  triggerDownload(zipSync(entries, { level: 0 }), zipName, "application/zip", sink);
}

// Hand a built kit — its entries { path, kind, data } and the forge's file base `name` —
// to the host's onKit sink. With no onKit, partforge saves it itself: the one model of a
// kit that has one bare (its README and parts list left out), else every entry zipped as
// `<name>-kit.zip`, through triggerDownload (so onDownload, when given, still gets the
// final bytes). Entry paths were checked against their kind's pattern in the worker
// (assertEntries), so they are safe zip paths, and each entry's data is already a
// Uint8Array. Model files are stored (level 0 — a 3MF is itself a zip, and deflating
// mesh bytes buys little for the time it costs); drawings and text are deflated.
export function deliverKit({ entries, name }, onKit, onDownload) {
  if (typeof onKit === "function") { onKit({ entries, name }); return; }
  const bare = bareEntry(entries);
  if (bare) return triggerDownload(bare.data, bare.path.slice(bare.path.lastIndexOf("/") + 1), KIT_KINDS[bare.kind].mime, onDownload);
  const files = Object.fromEntries(entries.map((e) => [e.path, [e.data, { level: MODEL_KINDS.has(e.kind) ? 0 : 6 }]]));
  triggerDownload(zipSync(files), `${name}-kit.zip`, "application/zip", onDownload);
}
