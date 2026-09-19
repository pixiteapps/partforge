import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(`../src/framework/${rel}`, import.meta.url)), "utf8");

// Every rule block in a sheet, as { selector, body } with comments stripped —
// enough to ask "which file declares this property for this selector?", which is
// the only question the placement/appearance split can be tested by.
const rules = (css) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, body]) => ({ selector: selector.trim(), body }));

test("tokens.css defines the core palette custom properties in both themes", () => {
  const css = read("tokens.css");
  for (const v of ["--pf-bg", "--pf-text", "--pf-accent", "--pf-mono", "--pf-surface", "--pf-border", "--pf-muted"])
    expect(css, `tokens.css must define ${v}`).toContain(`${v}:`);
  expect(css).toMatch(/:root\s*\{/);                       // default (dark) block
  expect(css).toMatch(/:root\[data-theme="light"\]\s*\{/); // light overrides
  expect(css).toContain("color-scheme: dark");
  expect(css).toContain("color-scheme: light");
});

test("app.css imports tokens.css and no longer defines the palette itself", () => {
  const css = read("app.css");
  // @import present, and it precedes the first real rule (only comments/whitespace before it).
  expect(css).toContain('@import "./tokens.css";');
  const beforeImport = css.slice(0, css.indexOf('@import "./tokens.css";'));
  expect(beforeImport.replace(/\/\*[\s\S]*?\*\//g, "").trim()).toBe("");
  // The palette moved out — app.css must NOT still hard-define it (guards against a leftover copy).
  expect(css).not.toContain("--pf-bg:");
  expect(css).not.toContain('data-theme="light"');
});

test("tokens.css defines the layout, shape, and type tokens the rail needs", () => {
  const css = read("tokens.css");
  for (const v of [
    "--pf-sans", "--pf-rail-w", "--pf-rail-pad",
    "--pf-radius-control", "--pf-radius-pill",
    "--pf-shadow-float", "--pf-shadow-rail",
  ]) expect(css, `tokens.css must define ${v}`).toContain(`${v}:`);
  // Geist first, system fallbacks retained, in both stacks.
  expect(css).toMatch(/--pf-sans:\s*"Geist Variable"/);
  expect(css).toContain("system-ui");
  expect(css).toMatch(/--pf-mono:\s*"Geist Mono Variable"/);
  expect(css).toContain("ui-monospace");
  // The rail shadow is INSET (the viewer casts onto the rail — see spec §2.4).
  expect(css).toMatch(/--pf-shadow-rail:\s*inset/);
});

test("tokens.css re-tunes the rail shadow for the light theme", () => {
  const css = read("tokens.css");
  const light = css.slice(css.indexOf('[data-theme="light"]'));
  expect(light, "light theme must override --pf-shadow-rail").toContain("--pf-shadow-rail:");
});

test("app.css sets the body font from the --pf-sans token, not a literal stack", () => {
  const css = read("app.css");
  expect(css).toContain("var(--pf-sans)");
  expect(css).not.toContain("-apple-system, system-ui, sans-serif");
});

test("chrome.css is exported and stays id-free so any host can reuse the layout", () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  expect(pkg.exports["./chrome.css"]).toBe("./src/framework/chrome.css");
  // The whole class-based design rests on this: an id-keyed sheet could never be
  // reused by a host that builds its own DOM (partforge-cloud uses #viewer /
  // #pfc-controls), so an id selector sneaking in silently breaks the contract.
  const css = read("chrome.css").replace(/\/\*[\s\S]*?\*\//g, "");
  expect(css).not.toMatch(/#[a-zA-Z]/);
});

// The rail foot's shared button chrome, so a host that drops a button in the
// foot gets the same treatment a built-in one has — the counterpart to
// app.css's `#viewbar button`. Every rule below was duplicated in at least two
// hosts before it moved here.
test("chrome.css gives rail-foot buttons shared chrome, with primary and icon variants", () => {
  const css = read("chrome.css");
  expect(css).toMatch(/\.pf-rail-foot button\s*\{/);
  expect(css).toMatch(/\.pf-rail-foot button\.pf-primary\s*\{/);
  expect(css).toMatch(/\.pf-rail-foot button\.pf-icon\s*\{/);
});

// The bug this whole rule set exists to make unreachable: a disabled button
// that still lights up under the pointer. The two bars reach that guarantee by
// different routes, and both are legitimate — the foot writes
// `:hover:not(:disabled)` on every rule, while the viewbar lets a plain
// `button:hover` stand and neutralizes it with a higher-specificity
// `button:disabled:hover` reset. What must never happen is a bar with hover
// rules and NEITHER protection, which is exactly the state partforge-cloud's
// hand-rolled copy of the foot was in.
test("no hover state in the rail foot or viewbar can fire on a disabled button", () => {
  const css = ["chrome.css", "app.css"]
    .map((f) => read(f).replace(/\/\*[\s\S]*?\*\//g, "")).join("\n");
  for (const bar of ["pf-rail-foot", "viewbar"]) {
    const hovers = [...css.matchAll(new RegExp(`^\\s*([^{}]*${bar}[^{}]*:hover[^{}]*)\\{`, "gm"))]
      .map(([, selector]) => selector.trim());
    expect(hovers.length, `${bar} should have hover rules to check`).toBeGreaterThan(0);
    const neutralized = hovers.some((s) => /:disabled:hover/.test(s));
    const guarded = hovers.every((s) => /:hover:not\(:disabled\)|:disabled:hover/.test(s));
    expect(neutralized || guarded,
      `${bar}: hover rules must either all exclude :disabled or be neutralized by a `
      + `:disabled:hover reset. Found:\n  ${hovers.join("\n  ")}`).toBe(true);
  }
});

// The rail toggle floats at the stage's TOP RIGHT, on its own, rather than
// riding in #viewbar's pill (2026-08-20). Same file split as every other piece
// of floating chrome: chrome.css says where it sits, app.css says what it looks
// like, so partforge-cloud can re-anchor it and still inherit its appearance.
test("chrome.css places the floating rail toggle without restating the stage margin", () => {
  const css = read("chrome.css");
  const own = rules(css).filter((r) => r.selector === ".pf-float-rail-toggle");
  expect(css, "chrome.css must place .pf-float-rail-toggle").toContain(".pf-float-rail-toggle");
  // The insets come from declarations SHARED with .pf-float-tabs (top: 12px) and
  // .pf-float-viewbar (right: 12px) — the top-right and bottom-right corners of
  // one stage, off one margin. A solo rule here would be a second copy of that
  // margin, free to drift away from the corner it is supposed to mirror.
  for (const rule of own) {
    expect(rule.body, `.pf-float-rail-toggle must not restate its own insets: ${rule.body.trim()}`)
      .not.toMatch(/\b(top|right|bottom|left)\s*:/);
  }
  const shares = (prop) => rules(css).some((r) =>
    r.selector.includes(".pf-float-rail-toggle") && new RegExp(`\\b${prop}\\s*:\\s*12px`).test(r.body));
  expect(shares("top"), "the toggle must take top: 12px from a shared rule").toBe(true);
  expect(shares("right"), "the toggle must take right: 12px from a shared rule").toBe(true);
  expect(rules(css).some((r) =>
    r.selector.includes(".pf-float-rail-toggle") && /position\s*:\s*absolute/.test(r.body)),
  "the toggle must be absolutely positioned within the stage").toBe(true);
});

test("app.css gives the floating rail toggle its appearance, and only that", () => {
  const css = read("app.css");
  const own = rules(css).filter((r) => r.selector === ".pf-float-rail-toggle");
  expect(own.length, "app.css must style .pf-float-rail-toggle").toBe(1);
  const [{ body }] = own;
  // The centred view selector's MEASURED height (#topbar .seg renders 38px on
  // every page). Both sit at top: 12px, so matching that height is what puts
  // the two on one line — and it sizes the hover chip to the selector too.
  expect(body).toMatch(/width\s*:\s*38px/);
  expect(body).toMatch(/height\s*:\s*38px/);
  // A bare floating icon at rest: no card of any kind.
  expect(body).toMatch(/background\s*:\s*transparent/);
  expect(body).toMatch(/border\s*:\s*0/);
  expect(body).toMatch(/box-shadow\s*:\s*none/);
  // A rounded rect, NOT the projection toggle's circle — two different controls.
  expect(body).toMatch(/border-radius\s*:\s*var\(--pf-radius-control\)/);
  expect(body).not.toMatch(/border-radius\s*:\s*50%/);
  // Placement stays in chrome.css.
  expect(body, "placement belongs in chrome.css").not.toMatch(/\bposition\s*:/);
  expect(body, "placement belongs in chrome.css").not.toMatch(/\b(top|right|bottom|left)\s*:/);
  // The card appears on hover only.
  expect(rules(css).some((r) =>
    r.selector === ".pf-float-rail-toggle:hover" && /background\s*:/.test(r.body)),
  "a hover background is the whole affordance").toBe(true);
});

// Both bare floating buttons read GREY in either state (2026-08-20). Each has an
// `.on` class its JS still toggles — rail.js on collapse, viewcube-controls.js
// on orthographic — and each used to take the accent colour with it. The state
// is carried by the icon instead (the rail toggle's chevron flips, the
// projection toggle's glyph changes) plus aria-expanded / aria-pressed, so an
// accent tint was a third signal that only made a bare icon over the model look
// like a stray blob. Any `.on` rule for either one is a regression.
test("no accent tint on the floating rail toggle or the projection toggle", () => {
  const css = read("app.css");
  for (const base of [".pf-float-rail-toggle", ".pf-viewcube-toggle"]) {
    const tinted = rules(css)
      .filter((r) => r.selector.includes(`${base}.on`))
      .map((r) => `${r.selector} {${r.body.trim()}}`);
    expect(tinted, `${base}.on must not restyle the button`).toEqual([]);
  }
});

// The trap `#viewbar button[hidden]` already guards against, inherited: this
// button's author-origin `display: flex` (it centres an icon) outranks the UA's
// `[hidden] { display: none }`, so rail.js's `toggle.hidden = narrow` would
// leave it fully visible below the narrow breakpoint — where the pane tab bar
// owns pane selection and a second collapse affordance must not compete.
test("app.css keeps the floating rail toggle hideable via the hidden property", () => {
  const css = read("app.css");
  expect(rules(css).some((r) =>
    r.selector === ".pf-float-rail-toggle[hidden]" && /display\s*:\s*none/.test(r.body)),
  ".pf-float-rail-toggle[hidden] must be display: none").toBe(true);
});

// All fourteen of the framework's own pages carry this markup by hand, so they
// can silently disagree — one page left with the button inside the pill would
// look like a bug in the CSS rather than in that page.
test("every part page floats the rail toggle outside #viewbar", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const pages = readdirSync(root).filter((f) => f.endsWith(".html"))
    .map((f) => [f, readFileSync(`${root}${f}`, "utf8")])
    .filter(([, html]) => html.includes('id="rail-toggle"'));
  expect(pages.length, "expected the framework's part pages to carry #rail-toggle").toBeGreaterThanOrEqual(14);
  for (const [name, html] of pages) {
    const bar = html.slice(html.indexOf('id="viewbar"'));
    const viewbar = bar.slice(0, bar.indexOf("</div>"));
    expect(viewbar, `${name}: #rail-toggle must not sit inside #viewbar`).not.toContain('id="rail-toggle"');
    expect(html, `${name}: #rail-toggle needs the .pf-float-rail-toggle class`)
      .toContain('<button id="rail-toggle" class="pf-float-rail-toggle"');
  }
});

// A host's dock lease (setRailLayout) hands over two lengths: --pf-rail-inset,
// the whole region its bottom sheet covers, and --pf-rail-dock-h, the slice of
// that region below the host's opaque strip. The stage must clear the WHOLE
// inset in both panes. An earlier pane=rail rule zeroed the shell's padding and
// stacked the rail under the stage in flow, so the stage ran the strip's height
// under the host's chrome — the viewbar, cube and transport bar behind it on
// every rail-pane sheet position. The rail is placed absolutely into the
// padding instead, so nothing in this pane can move the stage's bottom edge.
test("a docked rail pane keeps the shell's inset padding and overlays the rail into it", () => {
  const dockRail = rules(read("chrome.css"))
    .filter((r) => r.selector.includes('[data-pf-rail-layout="dock"][data-pf-pane="rail"]'));
  expect(dockRail.length, "expected dock+rail rules").toBeGreaterThan(0);
  for (const r of dockRail) {
    expect(r.body, `${r.selector} must not touch the shell's inset padding`).not.toMatch(/padding-bottom/);
  }
  const rail = dockRail.find((r) => /\.pf-rail\s*$/.test(r.selector));
  expect(rail, "the dock+rail .pf-rail rule").toBeTruthy();
  expect(rail.body).toMatch(/position:\s*absolute/);
  expect(rail.body).toMatch(/bottom:\s*0/);
  expect(rail.body).toMatch(/height:\s*var\(--pf-rail-dock-h/);
});

// A custom control draws its own SVG, and SVG's initial fill is BLACK — invisible
// on the dark theme and a heavy slab on the light one. So the rail supplies a
// token FLOOR (on the <svg>, where `fill` inherits, leaving an author's own
// fill="…" to win) and a resting look for the one clickable class, which
// otherwise had only :hover and .selected and so was unstyled at rest. This is
// not a cosmetic default: without it a widget that follows the guide exactly
// still renders unreadable, which is how it reached a user.
test("a custom control's SVG gets a themed floor, and .pf-hit reads as a control at rest", () => {
  const all = rules(read("app.css"));
  const find = (sel) => all.find((r) => r.selector === sel);

  const svg = find(":where(.pf-custom) :where(svg)");
  expect(svg, "the custom-control svg default must exist").toBeTruthy();
  expect(svg.body, "an unfilled shape or <text> must inherit a themed fill").toMatch(/fill:\s*var\(--pf-text-2\)/);

  const hit = find(":where(.pf-custom) :where(.pf-hit)");
  expect(hit, ".pf-hit needs a RESTING rule, not only hover/selected").toBeTruthy();
  expect(hit.body, "a clickable region must be filled at rest").toMatch(/fill:\s*var\(--pf-surface-2\)/);
  expect(hit.body, "a clickable region must be outlined at rest").toMatch(/stroke:\s*var\(--pf-border\)/);

  // A label nested in the region must stay readable through all three states.
  // Its fill would otherwise INHERIT the region's own — grey on grey at rest,
  // accent on accent once selected.
  const hitText = find(":where(.pf-custom) :where(.pf-hit) text");
  expect(hitText, "a label inside a region needs its own fill").toBeTruthy();
  expect(hitText.body, "a resting region's label must not inherit the region's fill").toMatch(
    /fill:\s*var\(--pf-text-2\)/,
  );
  // `stroke` inherits too, and the region's outline colour painted around every
  // glyph is most of the glyph at label sizes — pale ghosts of the numbers.
  expect(hitText.body, "a label must not inherit the region's stroke").toMatch(/stroke:\s*none/);

  // Selected must be the SOLID accent: a translucent one lands on a different
  // value per theme, so no single label colour reads on both.
  const selected = find(".pf-custom .pf-hit.selected");
  expect(selected.body, "selected must be a solid accent fill").toMatch(/fill:\s*var\(--pf-accent\)\s*;/);
  const selectedText = find(".pf-custom .pf-hit.selected text");
  expect(selectedText, "a label over the selected accent needs on-accent").toBeTruthy();
  expect(selectedText.body, "a label over the accent must use --pf-on-accent").toMatch(
    /fill:\s*var\(--pf-on-accent\)/,
  );

  // A literal cannot flip with the theme, which is the whole point of these rules.
  for (const r of [svg, hit, hitText, selected, selectedText])
    expect(r.body, `${r.selector} must not hardcode a colour`).not.toMatch(/#[0-9a-f]{3,8}\b/i);
});
