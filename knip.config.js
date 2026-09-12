// knip.config.js — dead-code detection for the framework, the CLI and the
// demo harness.
//
// partforge is a PUBLISHED package, which changes what "reachable" means here
// versus in an app: the nine subpath exports in package.json are the public
// API, so anything they reach is live by definition even if nothing in this
// repo calls it. knip reads those exports itself; what it cannot infer is the
// demo harness, which is a pile of root-level HTML pages, and the smoke check,
// which drives several pages that are NOT in vite's build input.
//
// Run: `npm run lint:dead`.
export default {
  // The demo pages reach their app module through `<script type="module"
  // src="/src/app-demo.js">` and nothing else imports it, so without this
  // knip calls all nineteen app modules — and, transitively, their workers
  // and reference parts — unused files. The src is root-absolute, so the
  // leading slash comes off before it can resolve against the HTML file.
  compilers: {
    html: (text) =>
      [...text.matchAll(/<script[^>]+src="([^"]+)"/g)]
        .map(([, src]) => `import ${JSON.stringify(src.replace(/^\//, "./"))};`)
        .join("\n"),
  },

  entry: [
    // Every root HTML page is an entry, not just the twelve in vite.config.js's
    // rollup input: scripts/check-app.mjs boots text-smoke.html,
    // mixed-smoke.html, propeller.html, import-demo.html, lofted-bottle.html
    // and relief.html in CI, and none of those is in the build.
    "*.html",
    "scripts/*.mjs",
    "test/**/*.test.js",
    "test/setup/*.js",

    // Two subsystem barrels, treated as entry points because that is what
    // they are: each declares its module's public surface in a header comment
    // and has a test asserting it (selection-index.test.js, pick-index.test.js
    // — both `import * as`, which is why knip cannot attribute the individual
    // names and reports them all as unused).
    //
    // The trade-off is real and worth stating: their re-exports are no longer
    // checked. Nine of them are in fact reached by nobody — every consumer
    // imports the concrete module instead (measure-mode takes raycastViewer
    // from ../selection/raycast.js, not from here), so both barrels are wider
    // than their one real caller, mount.js, needs. Whether to narrow them or
    // to route consumers through them is a design call, not dead code.
    "src/framework/selection/index.js",
    "src/framework/pick-request/index.js",
  ],
  project: [
    "src/**/*.js",
    "bin/**/*.js",
    "scripts/**/*.mjs",
    "*.html",
  ],
  // Build output, nested worktrees and spike/ are already gitignored, and
  // knip honours that — no ignore list is needed.

  // `export const isPathContour = isArcContour` in geometry/profile.js is a
  // deliberate preferred-name alias mid-rename, not a copy-paste slip, and it
  // is the only duplicate in the tree.
  rules: { duplicates: "off" },
  // The house convention here is the same as partforge-cloud's: a helper is
  // exported so its own test can reach it. Reporting every one of those buries
  // the handful that matter, so this asks the narrower question — what is
  // referenced NOWHERE, including by its own module.
  ignoreExportsUsedInFile: true,
  // The package's own subpath exports are the public API; their exports are
  // the product, not dead code.
  includeEntryExports: false,
};
