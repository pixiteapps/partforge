// @vitest-environment happy-dom
import { expect, test, vi } from "vitest";
import { openFontPicker, VARIANT_FACE_BUDGET } from "../../../src/framework/panel/font-picker.js";
import { buildControls } from "../../../src/framework/panel/render.js";

const fam = (family, variants, over = {}) => ({
  id: family, family, category: "sans", menuUrl: `https://fonts.gstatic.com/menu/${family}.ttf`,
  variants: variants.map((v) => ({ variant: v, label: v, url: `https://fonts.gstatic.com/s/${family}/v1/${v}.ttf`, bytes: 100 })),
  ...over,
});

const CATALOG = [fam("Anton", ["400"]), fam("Montserrat", ["400", "700"]), fam("Roboto", ["400", "700"])];
const catalog = { search: vi.fn(async (q) => CATALOG.filter((f) => !q || f.family.toLowerCase().includes(q.toLowerCase()))) };

function open(over = {}) {
  document.body.innerHTML = '<div id="anchor"></div>';
  const params = { face: CATALOG[2].variants[0].url };
  const handle = openFontPicker({
    node: { key: "face" }, params, allow: ["https"], fontCatalog: catalog,
    anchor: document.getElementById("anchor"), onPicked: () => {}, ...over,
  });
  return { handle, params };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

test("a single-variant family picks on row click without opening variants", async () => {
  const { params } = open();
  await flush();
  const row = [...document.querySelectorAll(".pk-row")].find((r) => r.textContent.startsWith("Anton"));
  row.click();
  await flush();
  expect(params.face).toBe("https://fonts.gstatic.com/s/Anton/v1/400.ttf");
  expect(document.querySelector(".picker").classList.contains("at-variants")).toBe(false);
});

test("a multi-variant family opens the variants pane", async () => {
  const { params } = open();
  await flush();
  [...document.querySelectorAll(".pk-row")].find((r) => r.textContent.startsWith("Montserrat")).click();
  await flush();
  expect(document.querySelector(".picker").classList.contains("at-variants")).toBe(true);
  expect(document.querySelectorAll(".vrow").length).toBe(2);
  expect(params.face).toContain("/Montserrat/");        // default variant already committed
});

test("picking a weight picks and STAYS in the variants pane", async () => {
  const { params } = open();
  await flush();
  [...document.querySelectorAll(".pk-row")].find((r) => r.textContent.startsWith("Montserrat")).click();
  await flush();
  [...document.querySelectorAll(".vrow")].find((b) => b.dataset.v === "700").click();
  await flush();
  expect(params.face).toBe("https://fonts.gstatic.com/s/Montserrat/v1/700.ttf");
  expect(document.querySelector(".picker").classList.contains("at-variants")).toBe(true);
  expect(document.querySelector(".vrow.on").dataset.v).toBe("700");
});

test("Done closes the picker; the last pick stands", async () => {
  const { handle, params } = open();
  await flush();
  [...document.querySelectorAll(".pk-row")].find((r) => r.textContent.startsWith("Anton")).click();
  await flush();
  document.querySelector(".pk-done").click();
  expect(document.querySelector(".picker")).toBeNull();
  expect(params.face).toContain("/Anton/");
  handle.close();                                       // idempotent
});

test("Escape steps back from variants before it closes", async () => {
  open();
  await flush();
  [...document.querySelectorAll(".pk-row")].find((r) => r.textContent.startsWith("Roboto")).click();
  await flush();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(document.querySelector(".picker").classList.contains("at-variants")).toBe(false);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(document.querySelector(".picker")).toBeNull();
});

test("search filters, and rows do not go stale at a reused index", async () => {
  open();
  await flush();
  const first = () => document.querySelector(".pk-row .pk-face").textContent;
  expect(first()).toBe("Anton");
  const search = document.querySelector(".pk-search");
  search.value = "montse"; search.dispatchEvent(new Event("input"));
  await flush();
  expect(first()).toBe("Montserrat");                   // index 0 re-rendered, not reused
});

test("an empty result shows an empty state, not a blank pane", async () => {
  open();
  await flush();
  const search = document.querySelector(".pk-search");
  search.value = "zzzznope"; search.dispatchEvent(new Event("input"));
  await flush();
  expect(document.querySelector(".pk-empty").hidden).toBe(false);
  expect(document.querySelectorAll(".pk-row").length).toBe(0);
});

test("a family whose url fails `allow` is not offered", async () => {
  const evil = { search: async () => [fam("Bad", ["400"], { variants: [{ variant: "400", label: "400", url: "http://evil.test/x.ttf", bytes: 1 }] })] };
  open({ fontCatalog: evil, allow: ["gstatic"] });
  await flush();
  expect(document.querySelectorAll(".pk-row").length).toBe(0);
  expect(document.querySelector(".pk-empty").hidden).toBe(false);
});

// ── the caption, the reserved height, and the wiring ────────────────────────

test("the row caption pluralizes: `1 style`, never `1 styles`", async () => {
  open();
  await flush();
  const caption = (name) => [...document.querySelectorAll(".pk-row")]
    .find((r) => r.textContent.startsWith(name)).querySelector(".pk-sub").textContent;
  expect(caption("Anton")).toBe("1 style · sans");
  expect(caption("Montserrat")).toBe("2 styles · sans");
});

// Height is reserved by the virtualizer BEFORE the face loads, which is what
// keeps a late-arriving face from shifting the list under the pointer.
test("rows reserve the 44px comfortable height and stack by index", async () => {
  open();
  await flush();
  const rows = [...document.querySelectorAll(".pk-row")];
  expect(rows.map((r) => r.style.height)).toEqual(["44px", "44px", "44px"]);
  expect(rows.map((r) => r.style.transform))
    .toEqual(["translateY(0px)", "translateY(44px)", "translateY(88px)"]);
});

test("the font control's button opens the picker — registration is wired", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { face: CATALOG[2].variants[0].url };
  buildControls(root, [{ id: "s", title: "S", controls: [{ key: "face", type: "font", label: "Typeface" }] }],
    params, () => {}, () => {}, { fontCatalog: catalog });
  expect(document.querySelector(".picker")).toBeNull();
  root.querySelector("button.font-btn").click();
  await flush();
  expect(document.querySelector(".picker")).toBeTruthy();
  document.querySelector(".pk-done").click();
  expect(document.querySelector(".picker")).toBeNull();
});

// ── faces ──────────────────────────────────────────────────────────────────
// happy-dom implements neither FontFace nor document.fonts, so every test above
// runs the degraded path — un-styled rows, no throw. These two stub the pair in
// to exercise the path a browser actually takes.

function withFontFace(load) {
  const seen = [];
  const prev = globalThis.FontFace;
  globalThis.FontFace = class {
    constructor(family, src) { this.family = family; this.src = src; seen.push({ family, src }); }
    load() { return load(this); }
  };
  Object.defineProperty(document, "fonts", { value: { add() {} }, configurable: true });
  return { seen, restore() { globalThis.FontFace = prev; delete document.fonts; } };
}

test("each family's menu face is loaded once, and only from an allowed host", async () => {
  const ff = withFontFace((f) => Promise.resolve(f));
  try {
    open({ allow: ["gstatic"], fontCatalog: { search: async () => [
      ...CATALOG,
      fam("Sketchy", ["400"], { menuUrl: "http://evil.test/menu.ttf" }),
    ] } });
    await flush();
    const search = document.querySelector(".pk-search");
    search.value = ""; search.dispatchEvent(new Event("input"));   // re-render the same rows
    await flush();
    expect(ff.seen.map((s) => s.family)).toEqual(["Anton", "Montserrat", "Roboto"]);
    expect(ff.seen.every((s) => s.src.includes("fonts.gstatic.com"))).toBe(true);
  } finally { ff.restore(); }
});

test("closing the picker deletes the faces it added, except the selected family's menu face", async () => {
  const ff = withFontFace((f) => Promise.resolve(f));
  const deleted = [];
  document.fonts.delete = (face) => { deleted.push(face.family); return true; };
  try {
    const { handle } = open();                     // params.face is a Roboto variant
    await flush(); await flush();
    handle.close();
    expect(deleted).toContain("Anton");
    expect(deleted).toContain("Montserrat");
    expect(deleted).not.toContain("Roboto");      // the widget label renders in it
  } finally { ff.restore(); }
});

test("opening a many-weight family loads the selected weight plus at most VARIANT_FACE_BUDGET others", async () => {
  const weights = ["100", "200", "300", "400", "500", "600", "700", "800", "900", "100i", "400i", "700i"];
  const big = fam("Big", weights);
  const ff = withFontFace((f) => Promise.resolve(f));
  try {
    const cat = { search: vi.fn(async () => [big]) };
    open({ fontCatalog: cat });
    await flush();
    document.querySelector(".pk-row").click();
    await flush();
    const variantLoads = ff.seen.filter((f) => f.family.startsWith("Big "));
    expect(variantLoads.length).toBe(1 + VARIANT_FACE_BUDGET);
    expect(variantLoads[0].family).toBe("Big 400");                    // the selected/default weight first
  } finally { ff.restore(); }
});

// A face is dimmed while it is PENDING. A 404 is settled, not pending, so the
// row must come back to full strength in the panel font rather than sitting at
// 38% forever — and the rejection must not escape as an unhandled error.
test("a menu face that fails to load settles the row instead of dimming it forever", async () => {
  const rejects = [];
  const ff = withFontFace(() => new Promise((_, r) => rejects.push(r)));
  try {
    open();
    await flush();
    expect(document.querySelector(".pk-row").classList.contains("loading")).toBe(true);
    for (const r of rejects) r(new Error("404"));
    await flush();
    expect(document.querySelectorAll(".pk-row").length).toBe(3);
    expect(document.querySelector(".pk-row").classList.contains("loading")).toBe(false);
  } finally { ff.restore(); }
});

test("with no FontFace at all the rows render un-styled rather than dimmed", async () => {
  open();                                              // happy-dom has no FontFace
  await flush();
  expect([...document.querySelectorAll(".pk-row")].some((r) => r.classList.contains("loading"))).toBe(false);
});

// ── superseding an open picker ─────────────────────────────────────────────
// The Escape handler lives on `document`, so detaching the element is NOT
// closing it: the listener (and the whole closure, up to 200 admitted families)
// survives, one more on every re-open. Asserting "there is only one .picker in
// the DOM" does not pin this — the leaking version satisfied that too. So count
// the live `keydown` registrations instead.
function trackKeydown() {
  const add = document.addEventListener.bind(document);
  const remove = document.removeEventListener.bind(document);
  let live = 0;
  document.addEventListener = (type, fn, opts) => { if (type === "keydown") live += 1; return add(type, fn, opts); };
  document.removeEventListener = (type, fn, opts) => { if (type === "keydown") live -= 1; return remove(type, fn, opts); };
  return {
    count: () => live,
    restore() { document.addEventListener = add; document.removeEventListener = remove; },
  };
}

test("re-opening supersedes the first picker instead of leaking its Escape handler", async () => {
  open().handle.close();                           // drain any picker an earlier test left open
  const keydown = trackKeydown();
  try {
    const first = open().handle;
    await flush();
    expect(keydown.count()).toBe(1);
    const second = open().handle;                  // no close() in between
    await flush();
    expect(keydown.count()).toBe(1);               // the first instance really closed

    first.close();                                 // already closed — a no-op…
    expect(keydown.count()).toBe(1);               // …and it must not unhook the LIVE one
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".picker")).toBeNull();
    expect(keydown.count()).toBe(0);
    second.close();
    expect(keydown.count()).toBe(0);
  } finally { keydown.restore(); }
});

// The catalog's answer for "montse" may be fuzzier than a substring test —
// second-guessing it drops real hits. `resultsQuery` holds the TRIMMED query,
// so comparing it against the raw box value would never match once a trailing
// space is typed, and the list would stay stuck on the client-side narrowing.
test("a trailing space still yields the catalog's own answer, not a re-filtered one", async () => {
  const fuzzy = { search: async (q) => (q ? [fam("Montserrat", ["400"]), fam("Alegreya", ["400"])] : CATALOG) };
  open({ fontCatalog: fuzzy });
  await flush();
  const search = document.querySelector(".pk-search");
  search.value = "montse "; search.dispatchEvent(new Event("input"));
  await new Promise((r) => setTimeout(r, 220));         // past the 120ms debounce
  expect([...document.querySelectorAll(".pk-face")].map((e) => e.textContent))
    .toEqual(["Montserrat", "Alegreya"]);
});

test("a new query scrolls back to the top of the results", async () => {
  open();
  await flush();
  const list = document.querySelector(".pk-list");
  list.scrollTop = 120;
  const search = document.querySelector(".pk-search");
  search.value = "o"; search.dispatchEvent(new Event("input"));
  expect(list.scrollTop).toBe(0);
});

// ── the author's `preview` string ──────────────────────────────────────────
// `preview` was accepted by the registry and documented for a while before
// anything read it — an author set it, lint stayed silent, and the picker went
// on showing the generic specimen. These two pin both halves.

test("the control's `preview` is what the weight samples render", async () => {
  open({ node: { key: "face", preview: "0123456789" } });
  await flush();
  [...document.querySelectorAll(".pk-row")].find((r) => r.textContent.startsWith("Montserrat")).click();
  await flush();
  expect([...document.querySelectorAll(".vsample")].map((v) => v.textContent))
    .toEqual(["0123456789", "0123456789"]);
});

test("with no `preview` the weight samples keep the default specimen", async () => {
  open();
  await flush();
  [...document.querySelectorAll(".pk-row")].find((r) => r.textContent.startsWith("Montserrat")).click();
  await flush();
  expect([...document.querySelectorAll(".vsample")].map((v) => v.textContent))
    .toEqual(["Hamburgefonstiv 0123", "Hamburgefonstiv 0123"]);
});

// ── disposing the panel ────────────────────────────────────────────────────
// The picker is a takeover: it appends itself to the RAIL, outside the panel
// root, so buildControls' root.replaceChildren() never reaches it. As with the
// supersede case above, "no .picker in the DOM" is not the pin — the document
// keydown registration is, since that is what holds the closure (and its stale
// `params`) alive.
test("dispose() closes an open picker instead of leaking its Escape handler", async () => {
  open().handle.close();                          // drain anything an earlier test left open
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const keydown = trackKeydown();
  try {
    const panel = buildControls(root, [{ id: "s", title: "S", controls: [{ key: "face", type: "font", label: "Typeface" }] }],
      { face: CATALOG[2].variants[0].url }, () => {}, () => {}, { fontCatalog: catalog });
    const withPanel = keydown.count();            // info.js's own Escape handler
    root.querySelector("button.font-btn").click();
    await flush();
    expect(keydown.count()).toBe(withPanel + 1);  // …plus the picker's
    panel.dispose();
    expect(document.querySelector(".picker")).toBeNull();
    expect(keydown.count(), "the picker's document listener must be unhooked too").toBe(0);
  } finally { keydown.restore(); }
});

test("onClose fires exactly once, after the picker leaves the DOM", async () => {
  const onClose = vi.fn(() => expect(document.querySelector(".picker")).toBeNull());
  const { handle } = open({ onClose });
  await flush();
  handle.close();
  handle.close();
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("a superseded picker still reports its close", async () => {
  const first = vi.fn();
  open({ onClose: first });
  await flush();
  const { handle } = open({ onClose: vi.fn() });   // re-open supersedes the first
  expect(first).toHaveBeenCalledTimes(1);
  handle.close();
});
