// eslint.config.js — correctness linting for the framework, the bin CLI, the
// dev scripts and the test suite.
//
// SCOPE, deliberately narrow. partforge had no linter, so the temptation is to
// switch everything on and spend a week on the fallout. What is enabled here
// is the set that finds BUGS: unreachable code, duplicate object keys, dead
// locals, promise mistakes. Style is not linted at all — there is no formatter
// in this repo and imposing one would rewrite every file and bury the next
// real finding in the diff.
//
// Rules of engagement for adding one: it must fail on code that is wrong, not
// on code that is unfashionable. If a rule would need more than a handful of
// inline disables to go green, it is the wrong rule for this codebase.
//
// The shipped declarations under types/ are NOT linted here — they are
// TypeScript, and `npm run typecheck` is what proves them (plus
// test/types-surface.test.js for their agreement with the runtime exports).
// Their existing @typescript-eslint directives are left alone for whenever a
// TS-aware config is added.
//
// Run: `npm run lint`.
import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "dist/**",
      "render/**",
      // Nested git worktrees live under .claude/, each with its own build
      // output. Bundled code trips every correctness rule there is — linting
      // it produced 9,605 of the first 9,635 findings.
      ".claude/**",
      "**/dist/**",
      "node_modules/**",
      "types/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },

  js.configs.recommended,

  {
    languageOptions: {
      // "latest", not a pinned year: src/parts/emblem.js imports its vector
      // asset with `with { type: "json" }`, and an older ecmaVersion fails to
      // PARSE that file rather than reporting anything useful about it.
      ecmaVersion: "latest",
      sourceType: "module",
      // Browser and Node together: the framework runs in a document, the CLI
      // and the dev scripts in Node, and a handful of modules are imported by
      // both.
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // An unused parameter is usually deliberate (a callback that must accept
      // an argument it ignores), so only unused LOCALS are errors.
      //
      // ignoreRestSiblings is a correctness setting, not a nicety: `const { a,
      // ...rest } = obj` names `a` precisely to EXCLUDE it from the spread, and
      // without this the rule calls it dead and the obvious fix leaks the
      // omitted field back into the result.
      "no-unused-vars": ["error", {
        args: "none",
        varsIgnorePattern: "^_",
        ignoreRestSiblings: true,
        caughtErrors: "all",
        caughtErrorsIgnorePattern: "^_",
      }],
      // `catch {}` is a real idiom — best-effort paths that deliberately
      // swallow and say so in a comment.
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-constant-binary-expression": "error",
      "no-self-compare": "error",
      "no-unused-private-class-members": "error",

      // Off for the same reasons as in partforge-cloud, kept in step on
      // purpose so a rule means the same thing in both repos:
      // control-character regexes are real work here, `no-useless-escape`
      // recommends unsafe edits inside regexes, and `no-useless-assignment`
      // fires on the `let x = null; try { x = … } catch { … }` idiom.
      // A WARNING rather than off. Nine rethrows in src/ would genuinely read
      // better carrying `{ cause }`, but turning a symptom error into a
      // cause-carrying one changes what callers see — a behaviour change that
      // belongs in its own change, not in the commit that installs the linter.
      // Visible, not blocking.
      "preserve-caught-error": "warn",

      "no-control-regex": "off",
      "no-useless-escape": "off",
      "no-useless-assignment": "off",
    },
  },

  // The kernel worker: a different global object, and `self` rather than
  // `window`. Without this every DOM-free worker module reports no-undef.
  {
    files: ["src/framework/worker.js", "src/framework/**/*worker*.js"],
    languageOptions: { globals: { ...globals.worker, ...globals.node } },
  },

  // Tests import describe/it/expect explicitly (vitest globals are not
  // injected), so only the environment differs.
  {
    files: ["test/**/*.js"],
    languageOptions: { globals: { ...globals.browser, ...globals.node, ...globals.vitest } },
  },
];
