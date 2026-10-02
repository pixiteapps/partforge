// The `type: "font"` picker: a takeover panel over the rail with two sliding
// panes (families, then that family's weights) and a shared footer.
//
// Main-thread only — it is DOM-heavy and is NOT part of the worker graph.
// It draws list rows in each family's own face by loading Google's name-only
// `menuUrl` subset through a FontFace, which is why a row costs a few KB and
// not the whole family.
//
// Ported from spike/font-picker.html, whose layout and interaction were settled
// against a running build over the real 1,942-family catalog (spec §6). The
// spike's own data path — a bundled catalog.json plus the Google CSS API — does
// NOT come along: here the families arrive from the host's `fontCatalog` and
// every face is a `FontFace` over a URL that catalog handed us.
import { fontLabel, variantLabel, setFontPicker } from "./widgets/font.js";
import { fontSourceAllowed } from "../font-source.js";

const ROW_H = 44;                  // comfortable density (spec §6)
const OVERSCAN = 4;                // rows rendered above/below the viewport
const SEARCH_LIMIT = 200;
const SEARCH_DEBOUNCE_MS = 120;
const SAMPLE = "Hamburgefonstiv 0123";   // the default variant-pane sample; `preview` overrides it
// A variants pane can hold 18 weights; auto-loading every real face for a CJK
// family would be tens of megabytes on one click. Past this, the sample line
// falls back to the panel font with the weight synthesized.
const VARIANT_FACE_MAX_BYTES = 1_500_000;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Family names come from the host and land in a `font-family` declaration, so
// strip the two characters that could end the quoted string early.
const faceStack = (...names) =>
  [...names.map((n) => `"${String(n).replace(/["\\]/g, "")}"`), "var(--pf-sans)"].join(", ");

const kbLabel = (bytes) => (Number.isFinite(bytes) ? `${Math.round(bytes / 1024)}K` : "");

// The face a row advertises, and the one a click lands on when the user has no
// standing weight preference. Kept separate from `pickVariant` so the row's
// size caption does not change under the user as they audition weights.
const listVariant = (f) =>
  f.variants.find((v) => v.variant === "400" || v.variant === "regular") ?? f.variants[0];

// At most one picker is open at a time, and the previous one has to be CLOSED
// rather than merely detached: its `keydown` listener lives on `document`, so
// dropping the element off the DOM leaves the handler — and the whole closure,
// up to 200 admitted families — alive forever, one more on every re-open.
// Only close() unregisters it, so every path that supersedes a picker goes
// through here.
let openPicker = null;

export function openFontPicker({ node, params, allow, fontCatalog, anchor, onPicked, onClose }) {
  // Takeover: the picker covers the rail on desktop and the single visible pane
  // below the narrow breakpoint. One layout for both widths (spec §6).
  const host = anchor?.closest?.(".pf-rail") ?? anchor?.parentElement ?? document.body;
  openPicker?.close();                                  // never two at once

  // ── state ───────────────────────────────────────────────────────────────
  // The author's `preview` string, when they set one. A part lettered in digits,
  // or in a script "Hamburgefonstiv" cannot even render, is auditioned against
  // the wrong glyphs by the generic sample — which is the whole point of the
  // field (spec §1). Blank or non-string falls back to the default.
  const sampleText = typeof node.preview === "string" && node.preview.trim() ? node.preview : SAMPLE;
  let results = [];          // what the catalog last returned…
  let resultsQuery = "";     // …for this query
  let query = "";            // what is in the box right now
  let rows = [];             // what the list is showing
  let closed = false;
  let searchSeq = 0;
  let debounce = null;
  let failed = false;
  // The value alone cannot name a live-picked face (a gstatic filename is a
  // content hash), so start from `fontLabel` and sharpen it the moment the
  // catalog hands us a family whose variant URL is this exact value.
  const initial = fontLabel(params[node.key]);
  let selFamily = initial.family;
  let selVariant = initial.variant ?? "400";
  let selBytes = null;
  let openFamily = null;     // the family the variants pane is showing

  const faceRequested = new Set();   // families whose menu face we have asked for
  // …and the ones we are no longer waiting on: arrived, or definitively failed.
  // A row is dimmed while its face is PENDING; a 404 is settled, not pending,
  // so it goes back to full strength in the panel font rather than staying grey.
  const faceSettled = new Set();
  const variantFaces = new Set();    // variant URLs already loaded

  // ── DOM ─────────────────────────────────────────────────────────────────
  const picker = el("div", "picker");
  const panes = el("div", "pk-panes");

  const browse = el("div", "pk-pane");
  browse.dataset.pane = "browse";
  const head = el("div", "pk-head");
  const titlebar = el("div", "pk-titlebar");
  const closeBtn = el("button", "pk-x", "\u00d7");
  closeBtn.type = "button";
  closeBtn.title = "Close";
  titlebar.append(el("b", "", node.label ?? node.key), closeBtn);
  const search = document.createElement("input");
  search.className = "pk-search";
  search.type = "text";
  search.placeholder = "Search fonts";
  search.autocomplete = "off";
  search.spellcheck = false;
  head.append(titlebar, search);
  const hint = el("div", "pk-hint");
  hint.hidden = true;
  const list = el("div", "pk-list");
  const spacer = el("div", "pk-spacer");
  const empty = el("p", "pk-empty");
  empty.hidden = true;
  list.append(spacer, empty);
  browse.append(head, hint, list);

  const variants = el("div", "pk-pane");
  variants.dataset.pane = "variants";
  const vhead = el("div", "pk-head");
  const back = el("button", "pk-back", "\u2190 all families");
  back.type = "button";
  const vtitlebar = el("div", "pk-titlebar");
  const vtitle = el("b");
  vtitlebar.append(vtitle);
  vhead.append(back, vtitlebar);
  const vlist = el("div", "pk-vlist");
  variants.append(vhead, vlist);

  panes.append(browse, variants);

  // The footer sits BELOW the sliding pane box, not inside it, so Done stays
  // reachable from either pane — picking a weight never has to exit to commit.
  const foot = el("div", "pk-foot");
  const sel = el("span", "pk-sel");
  const done = el("button", "pk-done", "Done");
  done.type = "button";
  foot.append(sel, done);

  picker.append(panes, foot);
  host.append(picker);
  paintSel();
  search.focus?.();

  // ── faces ───────────────────────────────────────────────────────────────
  // happy-dom (and any non-browser host) may not implement FontFace at all; a
  // missing one must degrade to un-styled rows, never throw.
  const canLoadFaces = () => typeof FontFace === "function" && typeof document.fonts?.add === "function";

  function settle(family) {
    faceSettled.add(family);
    if (closed) return;
    for (const row of spacer.children) {
      if (row.dataset.family === family) row.classList.remove("loading");
    }
  }

  function requestFaces(families) {
    if (!canLoadFaces()) return;
    for (const f of families) {
      if (faceRequested.has(f.family)) continue;
      faceRequested.add(f.family);
      // The menu file is fetched, so it goes through the same allowlist as the
      // value itself — a catalog is host-supplied, not trusted.
      if (!f.menuUrl || !fontSourceAllowed(f.menuUrl, allow)) { settle(f.family); continue; }
      let face;
      try { face = new FontFace(f.family, `url(${f.menuUrl})`); } catch { settle(f.family); continue; }
      face.load()
        .then((loaded) => { document.fonts.add(loaded); })
        .catch(() => { /* a family that will not load stays in the panel font */ })
        .then(() => settle(f.family));
    }
  }

  // The variants pane needs the REAL weights — the menu subset carries only the
  // family name's glyphs at one weight, so it cannot show what 700 looks like.
  // Each face is registered under `<family> <variant>` so the weights do not
  // collide with each other or with the menu face.
  function requestVariantFace(family, v) {
    if (!canLoadFaces()) return;
    if (variantFaces.has(v.url) || !fontSourceAllowed(v.url, allow)) return;
    if (Number.isFinite(v.bytes) && v.bytes > VARIANT_FACE_MAX_BYTES) return;
    variantFaces.add(v.url);
    let face;
    try { face = new FontFace(`${family} ${v.variant}`, `url(${v.url})`); } catch { return; }
    face.load().then((loaded) => document.fonts.add(loaded)).catch(() => {});
  }

  // ── the list ────────────────────────────────────────────────────────────
  // Reconcile by (index, family, selected) — index ALONE is wrong: after a
  // search the same index holds a different family, and an index-keyed row
  // keeps rendering the old one. The spike paid a screenshot to find this.
  const rowKey = (i, f) => `${i}|${f.family}|${f.family === selFamily ? 1 : 0}`;

  function rowEl(i, f) {
    const row = el("div", "pk-row" + (f.family === selFamily ? " sel" : ""));
    row.dataset.i = String(i);
    row.dataset.key = rowKey(i, f);
    row.dataset.family = f.family;
    if (canLoadFaces() && !faceSettled.has(f.family)) row.classList.add("loading");
    const main = el("div", "pk-main");
    const face = el("div", "pk-face", f.family);
    face.style.fontFamily = faceStack(f.family);
    const n = f.variants.length;
    main.append(face, el("div", "pk-sub", `${n} style${n === 1 ? "" : "s"} · ${f.category ?? "—"}`));
    row.append(main, el("div", "pk-meta", kbLabel(listVariant(f)?.bytes)));
    row.addEventListener("click", () => choose(f));
    return row;
  }

  function render() {
    if (closed) return;
    spacer.style.height = `${rows.length * ROW_H}px`;
    const top = list.scrollTop || 0;
    const vh = list.clientHeight || 360;
    const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const last = Math.min(rows.length, Math.ceil((top + vh) / ROW_H) + OVERSCAN);

    const wanted = new Map();
    for (let i = first; i < last; i++) wanted.set(i, rows[i]);
    requestFaces([...wanted.values()]);

    for (const node_ of [...spacer.children]) {
      const i = Number(node_.dataset.i);
      if (!wanted.has(i) || node_.dataset.key !== rowKey(i, wanted.get(i))) node_.remove();
      else wanted.delete(i);
    }
    for (const [i, f] of wanted) spacer.append(rowEl(i, f));
    for (const node_ of spacer.children) {
      node_.style.height = `${ROW_H}px`;
      node_.style.transform = `translateY(${Number(node_.dataset.i) * ROW_H}px)`;
    }

    empty.hidden = rows.length > 0;
    if (!rows.length) {
      empty.textContent = failed ? "The font catalog is unavailable."
        : query.trim() ? `No families match "${query.trim()}".`
        : "No families available.";
    }
    hint.hidden = !query.trim() || !rows.length;
    if (!hint.hidden) hint.textContent = `${rows.length.toLocaleString()} match${rows.length === 1 ? "" : "es"}`;
  }

  // Drop variants the allowlist refuses, and drop a family left with none — the
  // UI half of the font-source check. A family we cannot legally write must not
  // be offered, not merely fail on click.
  function admissible(entries) {
    const out = [];
    for (const f of entries ?? []) {
      if (!f || typeof f.family !== "string" || !Array.isArray(f.variants)) continue;
      const ok = f.variants.filter((v) => v && fontSourceAllowed(v.url, allow));
      if (!ok.length) continue;
      out.push({ ...f, variants: ok });
      if (!selBytes) {
        const hit = ok.find((v) => v.url === params[node.key]);
        if (hit) { selFamily = f.family; selVariant = hit.variant; selBytes = hit.bytes; paintSel(); }
      }
    }
    return out;
  }

  // While the user is typing ahead of the catalog, narrow what is already in
  // hand rather than blanking the list; once the catalog has answered for this
  // exact query, show precisely what it returned (its matching may be fuzzier
  // than a substring test, and second-guessing it would drop real hits).
  function recompute() {
    // Compare TRIMMED against trimmed: runSearch stores the trimmed query, so a
    // trailing space would otherwise never match and the list would stay stuck
    // on the client-side narrowing instead of showing the catalog's answer.
    const q = query.trim();
    rows = resultsQuery === q || !q
      ? results
      : results.filter((f) => f.family.toLowerCase().includes(q.toLowerCase()));
    render();
  }

  function runSearch(q) {
    const seq = ++searchSeq;
    Promise.resolve()
      .then(() => fontCatalog.search(q, { limit: SEARCH_LIMIT }))
      .then((entries) => {
        if (closed || seq !== searchSeq) return;         // a newer search already won
        failed = false;
        results = admissible(entries);
        resultsQuery = q;
        recompute();
      })
      .catch(() => {
        if (closed || seq !== searchSeq) return;
        failed = true;
        results = [];
        resultsQuery = q;
        recompute();
      });
  }

  search.addEventListener("input", () => {
    query = search.value;
    list.scrollTop = 0;                                  // a new query starts at the top
    recompute();                                         // instant, from what we hold
    clearTimeout(debounce);
    debounce = setTimeout(() => runSearch(query.trim()), SEARCH_DEBOUNCE_MS);
  });
  list.addEventListener("scroll", render);

  // ── choosing ────────────────────────────────────────────────────────────
  const pickVariant = (f) =>
    f.variants.find((v) => v.variant === selVariant) ?? listVariant(f);

  function choose(f) {
    commit(f, pickVariant(f));
    // 1,036 of the 1,942 catalog families ship a single face. Stepping into a
    // one-row weight list you immediately back out of is pure friction, so for
    // those the row click IS the selection and the list stays put (spec §6).
    if (f.variants.length > 1) openVariants(f);
  }

  function commit(f, v) {
    if (!v) return;
    params[node.key] = v.url;
    selFamily = f.family;
    selVariant = v.variant;
    selBytes = v.bytes;
    onPicked?.();
    paintSel();
    paintVariantRows();
    render();
  }

  function paintSel() {
    sel.textContent = "";
    const strong = el("b", "", selFamily);
    const rest = ` · ${variantLabel(selVariant)}` + (selBytes ? ` · ${kbLabel(selBytes)}` : "");
    sel.append(strong, document.createTextNode(rest));
  }

  function openVariants(f) {
    openFamily = f;
    vtitle.textContent = f.family;
    vlist.textContent = "";
    for (const v of f.variants) {
      const b = el("button", "vrow" + (v.variant === selVariant ? " on" : ""));
      b.type = "button";
      b.dataset.v = v.variant;
      const sample = el("span", "vsample", sampleText);
      sample.style.fontFamily = faceStack(`${f.family} ${v.variant}`, f.family);
      sample.style.fontWeight = String(v.variant).replace(/i$/, "") || "400";
      sample.style.fontStyle = /i$/.test(String(v.variant)) ? "italic" : "normal";
      b.append(sample, el("span", "vlabel", v.label ?? variantLabel(v.variant)));
      // Commit WITHOUT leaving — you audition weights against the live
      // geometry, so committing and navigating are separate actions (spec §6).
      b.addEventListener("click", () => commit(f, v));
      requestVariantFace(f.family, v);
      vlist.append(b);
    }
    vlist.scrollTop = 0;
    picker.classList.add("at-variants");
  }

  // Repaint which weight is current without rebuilding the list — the pane
  // stays put while you audition, so the rows must not be torn down under you.
  function paintVariantRows() {
    if (openFamily?.family !== selFamily) return;
    for (const b of vlist.children) b.classList.toggle("on", b.dataset.v === selVariant);
  }

  const leaveVariants = () => { openFamily = null; picker.classList.remove("at-variants"); render(); };
  back.addEventListener("click", leaveVariants);

  // ── closing ─────────────────────────────────────────────────────────────
  // Named here so close() can clear the module-level handle; `close` is a
  // hoisted function declaration, so this captures it.
  const handle = { close };

  function close() {
    if (closed) return;                                  // idempotent
    closed = true;
    clearTimeout(debounce);
    document.removeEventListener("keydown", onKey);
    picker.remove();
    if (openPicker === handle) openPicker = null;
    // After removal, so a host reacting to the close sees the rail as it will be.
    try { onClose?.(); } catch { /* host's problem, not the picker's */ }
  }
  function onKey(ev) {
    if (ev.key !== "Escape") return;
    ev.stopPropagation();
    if (picker.classList.contains("at-variants")) leaveVariants();
    else close();
  }
  document.addEventListener("keydown", onKey);
  closeBtn.addEventListener("click", close);
  done.addEventListener("click", close);

  runSearch("");
  render();
  openPicker = handle;
  return handle;
}

setFontPicker(openFontPicker);
