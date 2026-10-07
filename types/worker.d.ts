// partforge/worker — the geometry Web Worker runtime shared by every part.
//
// The host spawns this entry twice, named "manifold" (preview + STL + 3MF) and
// "occt" (STEP), via the Worker `name` option. Each instance lazily imports only
// its own backend.

import type { PartDefinition } from "./part.js";
export type { CoreStatus, CoreFallback, CoreFallbackReason } from "./testing.js";
export { coreStatus, onCoreFallback, CORE_FALLBACK_REASONS } from "./testing.js";

/** The rebind handle `runWorker` returns. */
export interface WorkerHandle {
  /**
   * Swap the part this worker builds, cancelling stale builds, sweeping idle
   * cache partitions and re-posting `ready` — so a remounting host gates its
   * first generate exactly as on a fresh worker, without losing the warm kernel.
   * The rebind contract is normative in docs/KERNEL-CONTRACT.md.
   */
  setPart(newPart: PartDefinition): void;
}

/**
 * A host-registered job handler (`runWorker`'s `opts.jobs`): receives the live
 * kernel, the part current when the message arrived, the message itself, the
 * poster for results (`post(msg, transferables?)`), and a context with `isStale`
 * (set for jobs that can be superseded by a rebind). A throw is posted as the
 * ordinary `{type: "error", message, jobId}`.
 */
export type HostJob = (
  kernel: unknown,
  part: PartDefinition,
  msg: { type: string; jobId?: number; [key: string]: unknown },
  post: (msg: object, transfer?: Transferable[]) => void,
  ctx: { isStale?: () => boolean },
) => void | Promise<void>;

/**
 * Run the worker job loop for `part`. Call once, at worker module top level.
 * `opts.jobs` registers host job types by message `type`: a message no built-in
 * job claims is handed to the matching handler; built-ins are not overridable and
 * a type with no handler is ignored. This is how a host adds capabilities the open
 * framework does not ship.
 */
export function runWorker(
  part: PartDefinition,
  opts?: { jobs?: Record<string, HostJob> },
): WorkerHandle;
