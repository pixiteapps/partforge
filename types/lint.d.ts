// partforge/lint — static PartDefinition validation.
//
// Zero runtime dependencies: it never imports a geometry kernel or the DOM
// viewer, so it runs unchanged in Node, a Web Worker, a sandboxed iframe, and
// Deno.

import type { Derived, PartDefinition, ResolvedParams } from "./part.js";

/**
 * `error` = the part is provably broken (it cannot behave as authored, whether
 * or not that surfaces as a throw). `warning` = suspicious or lossy, but the
 * part behaves as authored; a warning never blocks anything. `note` = neither
 * broken nor suspicious — informational context for an authoring agent (e.g.
 * "this animated track rebuilds geometry"); notes never gate `measure` or
 * `--strict`.
 */
export type FindingSeverity = "error" | "warning" | "note";

export interface Finding {
  /** The rule id, e.g. `"features-requires-sliders"`. */
  rule: string;
  severity: FindingSeverity;
  message: string;
  /** One self-contained corrective sentence. Always present. */
  hint: string;
  /**
   * A JS accessor path rooted at the PartDefinition —
   * `parameters[1].features[0]`, `defaults.bore`, `parts.spacer.views[0]`.
   * `""` for findings about the definition as a whole. For navigation only.
   */
  path: string;
  /**
   * Present on source-rule findings: the tree path of the file the finding was
   * read from, as keyed in `sources.files`.
   */
  file?: string;
  /**
   * Present on source-rule findings: the 1-indexed line of the offending source
   * within `file`.
   */
  line?: number;
  /**
   * A stable ERROR-PATTERNS.md entry id, when one applies — or `"sheet-parts"`,
   * the authoring guide's "Sheet parts" section, on a sheet-part finding.
   */
  pattern?: string;
}

export interface LintReport {
  /** True when there are no `error` findings. Warnings do not affect it. */
  ok: boolean;
  errors: Finding[];
  warnings: Finding[];
  /** Informational findings. Never affect `ok`, `measure`, or `--strict`. */
  notes: Finding[];
}

/**
 * The part's own source text, keyed by tree path — `entrypoint` names the file
 * holding the `PartDefinition` (the first key when omitted). Handing this over
 * unlocks the source rules, which read the text the evaluated definition has
 * already erased.
 */
export interface LintSources {
  files: Record<string, string>;
  entrypoint?: string;
}

/**
 * Lint a PartDefinition. NEVER throws — a rule that throws yields an
 * `internal-rule-error` warning and the run continues.
 *
 * @param part - the default-exported PartDefinition (deliberately `unknown`:
 *   lint's whole job is to be handed something that may not be one).
 * @param opts - `params` are layered over `part.defaults` for the probe pass;
 *   `sources` is the part's own source text. Omitting `sources` (or handing
 *   over a malformed one) makes the source rules a silent no-op — they are
 *   never a reason for lint to fail.
 */
export function lintPart(
  part: unknown,
  opts?: { params?: ResolvedParams; sources?: LintSources } | null,
): LintReport;

/** The shared context a rule reads. */
export interface LintContext {
  part: unknown;
  /** `{ ...part.defaults, ...params }`, or `{}` if building it threw. */
  p: ResolvedParams;
  /** `resolveDerived(part, p)`, or `{}` if it threw. */
  d: Derived;
  /** The message from a throwing `defaults`/`params` read, else `null`. */
  pError: string | null;
  /** The message from a throwing `derive()`, else `null`. */
  deriveError: string | null;
  /** A memoized geometry-free probe run of every `build`. */
  probe(): unknown;
  /** A second, un-memoized probe run — for the determinism diff. */
  probeAgain(): unknown;
  /** `verify.expect` resolved once per lint pass. */
  resolveExpectOnce(): unknown;
  /**
   * The normalized `opts.sources`, or `null` when none was handed over (or none
   * survived normalization). The source rules return no findings when it is
   * `null`. Optional: `lintContext` builds the context without it, and the
   * field is assigned separately by `lintPart`.
   */
  sources?: LintSources | null;
}

export interface LintRule {
  id: string;
  run(ctx: LintContext): Finding[];
}

/**
 * The rule registry — one rule object per finding id, so it doubles as the
 * documented rule catalog.
 */
export const RULES: LintRule[];

/**
 * The ids of the rules that read SOURCE rather than the evaluated part. A host
 * that gates rendering on lint errors uses this to keep source findings
 * REPORTED but non-blocking: a persistence defect is not a reason to refuse to
 * render a part that builds.
 */
export const SOURCE_RULE_IDS: ReadonlySet<string>;

export type { PartDefinition };
