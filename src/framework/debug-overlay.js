// src/framework/debug-overlay.js
// A dev-only overlay (shown under ?debug) with a caching on/off toggle and a
// readout of the last build's time + what the cache did. Self-contained: it
// creates its own DOM and knows nothing about geometry — mount.js wires it in.
export function createDebugOverlay({ initialCachingOn = true, onToggle } = {}) {
  const box = document.createElement("div");
  box.id = "pf-debug";
  // Left edge, below the top tab row: #viewbar is bottom-right and
  // #pf-pick/#pf-pick-toast are bottom-left, so the top-left corner has no
  // OTHER fixed element competing for it — but #topbar's tabs are centred in
  // the stage, and the stage starts flush at the window's left edge, so a top
  // offset of 12px (matching the tabs') is not actually free of them: at
  // narrow/medium widths this ~240px-wide box reaches past the stage's
  // horizontal centre and touches the tabs no matter which top corner it
  // anchors to (measured — see .superpowers/sdd/debug-overlay-fix.md).
  // #topbar's pill is a fixed 38px tall regardless of viewport or label width
  // (12px top + 38px), so clearing it VERTICALLY is what's actually
  // width-independent: sit below the tabs instead of racing them
  // horizontally. That also drops any dependency on --pf-rail-w, so no media
  // query is needed for the stacked layout below 720px.
  // Positioned inline (not in chrome.css) because this box is dev-only chrome
  // specific to partforge itself, never exported for a host to skin or reuse.
  Object.assign(box.style, {
    position: "fixed", top: "58px", left: "12px", zIndex: "9999",
    font: "12px ui-monospace, monospace", background: "rgba(0,0,0,0.7)",
    color: "#e6e6e6", padding: "8px 10px", borderRadius: "6px",
    lineHeight: "1.5", whiteSpace: "pre",
  });

  const label = document.createElement("label");
  label.style.cssText = "display:block;cursor:pointer;margin-bottom:4px";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = initialCachingOn;
  cb.style.marginRight = "6px";
  label.append(cb, document.createTextNode("Caching"));

  const readout = document.createElement("div");
  readout.textContent = "build: —";

  box.append(label, readout);
  document.body.appendChild(box);

  cb.addEventListener("change", () => onToggle?.(cb.checked));

  // What's currently on screen. update() MERGES over it, so a caller reporting one
  // figure doesn't blank the others: a pose-only edit ran no build and no L2 ops,
  // and would otherwise wipe the last build's timing back to "—" on its way to
  // showing a posed count.
  const shown = { ms: null, hits: 0, misses: 0, skipped: 0, rebuilt: 0, posed: 0, frame: null };

  return {
    update(counts = {}) {
      Object.assign(shown, counts);
      const { ms, hits, misses, skipped, rebuilt, posed, frame } = shown;
      const l2 = cb.checked ? `${hits} hit / ${misses} miss` : "off";
      readout.textContent =
        `build: ${ms != null ? Math.round(ms) + " ms" : "—"}\n` +
        `L2 ops: ${l2}\n` +
        `L1 parts: ${skipped} skipped / ${rebuilt} rebuilt / ${posed} posed` +
        (frame ? ` · ${frame}` : ""); // delivery frames of the in-view meshes
    },
    detach: () => box.remove(),
  };
}
