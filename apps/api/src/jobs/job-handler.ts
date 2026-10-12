/**
 * What a unit of queued work looks like to the consumer.
 *
 * The consumer owns everything that is the same for every job — ownership verification,
 * deduplication, the lease, the fence, classification, backoff, the dead letter. A handler
 * owns only the work. That split is deliberate: every one of those shared concerns is a place
 * where a mistake produces a screening result that states something untrue, and a per-handler
 * copy of any of them is a per-handler opportunity to get it wrong.
 *
 * A handler therefore has exactly two obligations:
 *
 * 1. **Name its stage deterministically.** `stageKeyFor` must derive the key from the work
 *    itself, never from a clock, a random value or the delivery. A key that differs between
 *    two deliveries of the same message creates two stages, and the uniqueness guarantee that
 *    makes redelivery safe (FI-07) is then worth nothing.
 * 2. **Describe its failures in the FR-06 vocabulary.** Throw `JobFailure` carrying a
 *    `FailureSignal` — a status code, a syscall name, a content-type — not a message string.
 *    The consumer classifies; the handler observes.
 */

import type { FailureSignal } from '@adverse-search/domain';

import type { JobEnvelope } from './queue.port.js';

export interface JobContext {
  /** From the persisted record, never from the envelope (SEC-01). */
  readonly tenantId: string;
  readonly envelope: JobEnvelope;
  readonly runId: string;
  readonly stageKey: string;
  /** 1-based. The first attempt is attempt 1. */
  readonly attempt: number;
  /**
   * Extend the lease. Returns `false` when the lease is gone or the execution deadline has
   * passed — at which point the handler must stop, because anything it writes afterwards will
   * be refused by the fence anyway and the work is being redone elsewhere.
   */
  readonly heartbeat: () => Promise<boolean>;
}

/**
 * A failure the handler can describe.
 *
 * Deliberately carries a signal rather than a class: classification is a single table in
 * `packages/domain` (FR-06), and a handler that picked its own class would be a second
 * taxonomy — which is how "never retry a hard block" becomes advice instead of a rule.
 */
export class JobFailure extends Error {
  constructor(
    readonly signal: FailureSignal,
    message: string,
  ) {
    super(message);
    this.name = 'JobFailure';
  }
}

export interface JobHandler {
  /** The `eventType` this handler consumes. One handler per type, per consumer. */
  readonly eventType: string;
  /** Deterministic in the work, not in the delivery. See the note above. */
  stageKeyFor(envelope: JobEnvelope): string;
  execute(context: JobContext): Promise<void>;
}
