/**
 * Phase C step C6 — the one place a queued message becomes work.
 *
 * Everything that makes at-least-once delivery survivable lives here, in one sequence, because
 * each guard only holds if the ones before it ran:
 *
 * ```
 *   parse  →  poison check  →  ownership (SEC-01)  →  receipt (FI-07/FI-09)
 *          →  stage identity (FI-07)  →  lease (FI-11)  →  work
 *          →  fenced write (FI-11/FI-12)  →  acknowledge
 * ```
 *
 * **Handling a message returns a disposition; it does not touch the transport.** The decision
 * — acknowledge, retry after a delay, dead-letter — is computed and returned, and the runtime
 * carries it out. That separation is what makes the interesting cases testable without a
 * queue: "a cancelled run's late completion is discarded and acknowledged" is an assertion
 * about a returned value, not something inferred from which SQS calls were made.
 *
 * **Three rules that are easy to get backwards, stated once:**
 *
 * 1. **A refused fence is never retried.** If the lease moved or the revision changed, this
 *    worker's result is not wanted — by definition, because something else is authoritative
 *    now. Retrying is how a stale worker eventually wins, which is the exact outcome fencing
 *    exists to prevent. The message is acknowledged and the attempt is counted as discarded.
 * 2. **A non-retryable class is terminal on the first failure.** Four of the seven FR-06
 *    classes must never be retried. `shouldRetry` is read from the table, never re-derived.
 * 3. **The external call is not exactly-once, and this file does not pretend otherwise.** A
 *    crash between the outbound request and the acknowledgement repeats the request (FI-08).
 *    What is prevented is a duplicate *committed* stage, and that is done with identity, not
 *    with hope.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { ClientSession } from 'mongodb';

import {
  backoffDelayMs,
  classifyFailure,
  shouldRetry,
  type FailureClass,
  type FailurePolicy,
} from '@erly/adverse-domain';

import {
  InboxReceiptService,
  queueChannel,
  type ReceiptOutcome,
} from '../persistence/inbox-receipt.service.js';
import {
  isTerminal,
  StageExecutionService,
  type Lease,
} from '../persistence/stage-execution.service.js';
import { TransactionRunner } from '../persistence/transaction.runner.js';
import { type DeadLetter, type DeadLetterPort, type DeadLetterReason } from './dead-letter.port.js';
import { verifyJobOwnership, type OwnedAggregate } from './job-ownership.js';
import { JobFailure, type JobHandler } from './job-handler.js';
import type { JobEnvelope, ReceivedMessage } from './queue.port.js';

/**
 * What the runtime should do with the message.
 *
 * `RETRY_LATER` carries the delay rather than sleeping, so the FR-06 backoff is served by the
 * transport's own visibility timeout and survives this process dying.
 */
export type Disposition =
  | { readonly kind: 'ACKNOWLEDGE'; readonly outcome: AckOutcome; readonly detail: string }
  | { readonly kind: 'RETRY_LATER'; readonly delayMs: number; readonly detail: string }
  | {
      readonly kind: 'DEAD_LETTER';
      readonly reason: DeadLetterReason;
      readonly detail: string;
    };

/**
 * Why a message was acknowledged. Every one of these is a distinct operational fact, and
 * collapsing them into "done" would make the two that matter — a discarded result and a
 * refused crossing — indistinguishable from ordinary success in every metric.
 */
export type AckOutcome =
  | 'SUCCEEDED'
  | 'ABANDONED'
  | 'ALREADY_TERMINAL'
  | 'DUPLICATE'
  | 'FENCE_REFUSED'
  | 'STALE_REVISION'
  | 'AGGREGATE_GONE';

export interface JobConsumerOptions {
  /** Identifies this consumer for deduplication and for the lease owner field. */
  readonly consumerName: string;
  readonly leaseMs: number;
  readonly maxExecutionMs: number;
  /** Replay window for the queue receipt. Not the guard — stage identity is (FI-07). */
  readonly receiptTtlMs: number;
  /**
   * Deliveries after which a message is dead-lettered outright.
   *
   * Matches the redrive policy's `maxReceiveCount` in `scripts/bootstrap/aws.mjs`. Deliberately
   * the same number rather than one less: this is not an attempt to beat the backstop to it,
   * only to attach a reason to the message when we get there first.
   */
  readonly maxDeliveries: number;
}

export const DEFAULT_CONSUMER_OPTIONS: Omit<JobConsumerOptions, 'consumerName'> = {
  leaseMs: 60_000,
  maxExecutionMs: 15 * 60_000,
  receiptTtlMs: 24 * 60 * 60_000,
  maxDeliveries: 5,
};

/**
 * The ceiling on attempts recorded against a stage.
 *
 * The FR-06 table gives each failure class its own attempt count, and the class is only known
 * *after* a failure — so the record carries the highest retryable count as its bound, and the
 * class policy applies within it. The two work together: the class stops a rate-limited fetch
 * at three, and this stops a stage whose worker keeps dying before it can classify anything.
 */
export const STAGE_ATTEMPT_CEILING = 5;

/**
 * Attempts allowed for a failure that is **ours**, not a source's.
 *
 * An internal defect is not an FR-06 class and is deliberately not mapped into one. The table
 * classifies what a source did; recording a null-pointer bug as `CONTENT_ERROR` would put our
 * own defect into the coverage statement as a fact about the source, and the source would be
 * reported as a dead lead for a failure it had no part in. So it is recorded with a null class
 * and a plain detail, retried a couple of times in case it was environmental, and then
 * abandoned — visibly, as an internal failure.
 */
export const INTERNAL_ERROR_ATTEMPTS = 3;
const INTERNAL_BACKOFF_BASE_MS = 2_000;

@Injectable()
export class JobConsumer {
  private readonly logger = new Logger('JobConsumer');
  private readonly handlers = new Map<string, JobHandler>();

  constructor(
    private readonly stages: StageExecutionService,
    private readonly receipts: InboxReceiptService,
    private readonly transactions: TransactionRunner,
    private readonly deadLetters: DeadLetterPort,
    /**
     * Loads an aggregate by its own ID, with **no tenant filter**. See `job-ownership.ts`: a
     * loader scoped by the envelope's tenant turns the ownership check into a tautology.
     */
    private readonly loadAggregate: (aggregateId: string) => Promise<OwnedAggregate | null>,
    private readonly options: JobConsumerOptions,
    private readonly random: () => number = Math.random,
  ) {}

  register(handler: JobHandler): void {
    if (this.handlers.has(handler.eventType)) {
      // Two handlers for one type is ambiguous, and resolving it by last-registration-wins
      // means a merge can silently change which code runs for a customer's search.
      throw new Error(`A handler for "${handler.eventType}" is already registered.`);
    }
    this.handlers.set(handler.eventType, handler);
  }

  /**
   * How many handlers are registered.
   *
   * Read by the runtime, which refuses to start at zero. A worker with no handlers is not an
   * idle worker: it receives every queued search and dead-letters it as unroutable, so a
   * process that looks healthy would be emptying the queue into the DLQ. Failing to start is
   * the honest behaviour — see `worker-main.ts`.
   */
  handlerCount(): number {
    return this.handlers.size;
  }

  /**
   * Handle one message. Returns what the runtime should do with it; performs no transport call.
   */
  async handle(message: ReceivedMessage, now: Date): Promise<Disposition> {
    if (message.envelope === null) {
      // It will not parse on the next delivery either. Retrying it costs four more deliveries
      // and tells the eventual operator nothing about what was wrong.
      return deadLetter('MALFORMED_ENVELOPE', 'The message body is not a valid job envelope.');
    }

    const envelope = message.envelope;

    if (message.approximateReceiveCount >= this.options.maxDeliveries) {
      return deadLetter(
        'POISON_MESSAGE',
        `Delivered ${String(message.approximateReceiveCount)} times without completing. ` +
          `event=${envelope.eventId} type=${envelope.eventType}`,
      );
    }

    const handler = this.handlers.get(envelope.eventType);
    if (handler === undefined) {
      // Not an error to retry: no amount of redelivery registers a handler. A deployment that
      // genuinely lags its producer is a real situation, and it is one an operator must see
      // rather than one the queue silently absorbs.
      return deadLetter(
        'UNROUTABLE',
        `No handler for event type "${envelope.eventType}" in consumer ` +
          `"${this.options.consumerName}".`,
      );
    }

    // SEC-01. The tenant comes from the record; the envelope's claim is only ever compared.
    const verdict = await verifyJobOwnership({ envelope, load: this.loadAggregate });

    switch (verdict.kind) {
      case 'NOT_FOUND':
        // A replay of something deleted, or a forged identity. Nothing to do either way, and
        // nothing to retry: the aggregate is not coming back.
        this.logger.warn(`Discarding delivery for a missing aggregate: ${verdict.detail}`);
        return acknowledge('AGGREGATE_GONE', verdict.detail);

      case 'TENANT_MISMATCH':
        // A security event, not a routing correction. It is never repaired by preferring the
        // record and carrying on quietly — the only ways to produce one are a producer bug and
        // an attack, and both need a human to see them.
        this.logger.error(`SEC-01: ${verdict.detail} claimed=${verdict.claimed}`);
        return deadLetter('TENANT_MISMATCH', verdict.detail);

      case 'STALE_REVISION':
        // REL-03 / T31. Applying it would overwrite newer state with older.
        return acknowledge(
          'STALE_REVISION',
          `Delivery at revision ${String(envelope.aggregateRevision)} is older than the ` +
            `current ${String(verdict.currentRevision)}.`,
        );

      case 'OWNED':
        return this.handleOwned({ message, envelope, handler, tenantId: verdict.tenantId, now });
    }
  }

  /** The path for a message that is genuinely ours to act on. */
  private async handleOwned(input: {
    readonly message: ReceivedMessage;
    readonly envelope: JobEnvelope;
    readonly handler: JobHandler;
    readonly tenantId: string;
    readonly now: Date;
  }): Promise<Disposition> {
    const { envelope, handler, tenantId, now } = input;
    const channel = queueChannel(this.options.consumerName);
    const stageKey = handler.stageKeyFor(envelope);

    // Layer one of FI-07: the receipt. Cheap, and it expires.
    const receipt: ReceiptOutcome = await this.receipts.claim({
      tenantId,
      channel,
      key: envelope.eventId,
      operation: envelope.eventType,
      requestHash: null,
      now,
      ttlMs: this.options.receiptTtlMs,
    });

    if (receipt.kind === 'REPLAY') {
      return acknowledge('DUPLICATE', `event=${envelope.eventId} was already handled.`);
    }
    if (receipt.kind === 'IN_FLIGHT') {
      // Another worker holds this delivery. Returning it immediately is right: if that worker
      // is alive it will finish, and if it died the lease sweep frees the stage (FI-11).
      return retryLater(
        this.options.leaseMs,
        `event=${envelope.eventId} is in flight on another worker.`,
      );
    }
    /* c8 ignore next 3 -- a queue receipt passes requestHash: null, so CONFLICT, which is
       raised only by a differing hash, is unreachable on this channel. */
    if (receipt.kind === 'CONFLICT') {
      return deadLetter('MALFORMED_ENVELOPE', `event=${envelope.eventId} conflicts with itself.`);
    }

    // Layer two of FI-07, and the one that survives receipt expiry: stage identity.
    const stage = await this.stages.ensure({
      tenantId,
      runId: envelope.aggregateId,
      stageKey,
      maxAttempts: STAGE_ATTEMPT_CEILING,
      now,
    });

    if (isTerminal(stage.state)) {
      // Succeeded, abandoned or cancelled. A redelivery does not re-open any of the three —
      // in particular, work must never resume on a run someone cancelled (FI-12).
      await this.releaseReceipt({ tenantId, channel, envelope });
      return acknowledge(
        'ALREADY_TERMINAL',
        `stage=${stageKey} is already ${stage.state}; the delivery was discarded.`,
      );
    }

    const lease = await this.stages.acquireLease({
      tenantId,
      runId: envelope.aggregateId,
      stageKey,
      owner: `${this.options.consumerName}:${String(process.pid)}`,
      leaseMs: this.options.leaseMs,
      maxExecutionMs: this.options.maxExecutionMs,
      now,
    });

    if (lease === null) {
      // Either another worker holds it or it is not due yet (a backoff from a previous
      // failure). Both mean "not now", and both are answered by the transport holding the
      // message rather than by this process spinning on it.
      await this.releaseReceipt({ tenantId, channel, envelope });
      return retryLater(
        this.options.leaseMs,
        `stage=${stageKey} is leased elsewhere or not yet due.`,
      );
    }

    return this.execute({ envelope, handler, tenantId, stageKey, lease, channel, now });
  }

  /** Run the handler and record what happened, fenced. */
  private async execute(input: {
    readonly envelope: JobEnvelope;
    readonly handler: JobHandler;
    readonly tenantId: string;
    readonly stageKey: string;
    readonly lease: Lease;
    readonly channel: string;
    readonly now: Date;
  }): Promise<Disposition> {
    const { envelope, handler, tenantId, stageKey, lease, channel } = input;

    try {
      await handler.execute({
        tenantId,
        envelope,
        runId: envelope.aggregateId,
        stageKey,
        attempt: lease.attempt,
        heartbeat: async () =>
          (await this.stages.renewLease({
            tenantId,
            stageExecutionId: lease.stageExecutionId,
            leaseToken: lease.leaseToken,
            leaseMs: this.options.leaseMs,
            now: new Date(),
          })) !== null,
      });
    } catch (error) {
      return this.recordFailure({ ...input, error });
    }

    // Success. The stage's terminal state and the receipt commit together (FI-09): if they
    // were separate writes, a crash between them would leave completed work with no receipt,
    // and the redelivery would do it again.
    const applied = await this.transactions.run(
      async (session: ClientSession) => {
        const fenced = await this.stages.completeFenced({
          tenantId,
          stageExecutionId: lease.stageExecutionId,
          leaseToken: lease.leaseToken,
          expectedRevision: lease.revision,
          state: 'SUCCEEDED',
          now: new Date(),
          session,
        });

        if (!fenced) {
          return false;
        }

        await this.receipts.complete({
          tenantId,
          channel,
          key: envelope.eventId,
          operation: envelope.eventType,
          resultId: lease.stageExecutionId,
          now: new Date(),
          session,
        });
        return true;
      },
      { name: 'job.complete' },
    );

    if (!applied) {
      // The lease moved or the revision changed while the handler ran — a cancellation, or a
      // lease that expired and was reclaimed. The result is discarded and NOT retried: a stale
      // worker that retries is a stale worker that eventually wins (FI-12, T30).
      await this.releaseReceipt({ tenantId, channel, envelope });
      this.logger.warn(
        `Fence refused a completed stage; the result was discarded. stage=${stageKey} ` +
          `run=${envelope.aggregateId}`,
      );
      return acknowledge(
        'FENCE_REFUSED',
        `stage=${stageKey} completed after its lease or revision moved; result discarded.`,
      );
    }

    return acknowledge(
      'SUCCEEDED',
      `stage=${stageKey} succeeded on attempt ${String(lease.attempt)}.`,
    );
  }

  /** Classify, decide, record. The FR-06 table decides; nothing here second-guesses it. */
  private async recordFailure(input: {
    readonly envelope: JobEnvelope;
    readonly tenantId: string;
    readonly stageKey: string;
    readonly lease: Lease;
    readonly channel: string;
    readonly error: unknown;
  }): Promise<Disposition> {
    const { envelope, tenantId, stageKey, lease, channel, error } = input;

    const classified = classifyAttempt(error, lease.attempt, this.random);
    const now = new Date();

    if (classified.policy?.alertOperator === true) {
      // Silent revocation and hard blocks do not fix themselves, and nothing downstream of
      // here will notice: the run simply reports a coverage gap forever.
      this.logger.error(
        `Operator action required (${classified.failureClass ?? 'INTERNAL'}) on ` +
          `run=${envelope.aggregateId} stage=${stageKey}: ${classified.detail}`,
      );
    }

    const fenced = await this.stages.completeFenced({
      tenantId,
      stageExecutionId: lease.stageExecutionId,
      leaseToken: lease.leaseToken,
      expectedRevision: lease.revision,
      state: classified.retry ? 'FAILED' : 'ABANDONED',
      failureClass: classified.failureClass,
      failureDetail: classified.detail,
      nextAttemptAt: classified.retry ? new Date(now.getTime() + classified.delayMs) : null,
      now,
    });

    // The claim is released either way: a retry must not be blocked by this delivery's dead
    // reservation, and an abandoned stage has no use for one.
    await this.releaseReceipt({ tenantId, channel, envelope });

    if (!fenced) {
      return acknowledge(
        'FENCE_REFUSED',
        `stage=${stageKey} failed after its lease or revision moved; the failure was discarded.`,
      );
    }

    if (classified.retry) {
      return retryLater(classified.delayMs, `stage=${stageKey}: ${classified.detail}`);
    }

    return acknowledge('ABANDONED', `stage=${stageKey}: ${classified.detail}`);
  }

  private async releaseReceipt(input: {
    readonly tenantId: string;
    readonly channel: string;
    readonly envelope: JobEnvelope;
  }): Promise<void> {
    await this.receipts.release({
      tenantId: input.tenantId,
      channel: input.channel,
      key: input.envelope.eventId,
      operation: input.envelope.eventType,
    });
  }

  /** Turn a disposition into a dead letter. The runtime sends it; this shapes it. */
  letterFor(message: ReceivedMessage, reason: DeadLetterReason, detail: string): DeadLetter {
    return {
      reason,
      body: message.body,
      detail,
      envelope: message.envelope,
      receivedAt: new Date(),
    };
  }

  async deadLetter(letter: DeadLetter): Promise<void> {
    await this.deadLetters.send(letter);
  }
}

export interface ClassifiedAttempt {
  readonly failureClass: FailureClass | null;
  readonly policy: FailurePolicy | null;
  readonly retry: boolean;
  readonly delayMs: number;
  readonly detail: string;
}

/**
 * Decide what a thrown error means.
 *
 * Exported and pure so the decision can be tested directly against the FR-06 table — the
 * interesting assertions here are about *which* class a signal produces and whether it is
 * retried, and neither needs a database to be true.
 */
export function classifyAttempt(
  error: unknown,
  attempt: number,
  random: () => number,
): ClassifiedAttempt {
  if (error instanceof JobFailure) {
    const policy = classifyFailure(error.signal);
    const retry = shouldRetry(policy, attempt);
    return {
      failureClass: policy.failureClass,
      policy,
      retry,
      delayMs: retry
        ? backoffDelayMs({
            policy,
            attempt,
            baseMs: 1_000,
            // Honoured exactly when the source gave one: a source that says "wait 30 seconds"
            // has told us the answer, and jittering it is us deciding we know better.
            ...(error.signal.retryAfterSeconds === undefined
              ? {}
              : { retryAfterSeconds: error.signal.retryAfterSeconds }),
            random: random(),
          })
        : 0,
      detail: `${policy.failureClass}: ${error.message}`,
    };
  }

  // Not a described failure — a defect in our own code, or something environmental it did not
  // anticipate. Kept out of the FR-06 vocabulary on purpose; see INTERNAL_ERROR_ATTEMPTS.
  const retry = attempt < INTERNAL_ERROR_ATTEMPTS;
  return {
    failureClass: null,
    policy: null,
    retry,
    delayMs: retry ? Math.floor(random() * INTERNAL_BACKOFF_BASE_MS * 2 ** (attempt - 1)) : 0,
    detail: `internal error: ${error instanceof Error ? error.message : String(error)}`,
  };
}

function acknowledge(outcome: AckOutcome, detail: string): Disposition {
  return { kind: 'ACKNOWLEDGE', outcome, detail };
}

function retryLater(delayMs: number, detail: string): Disposition {
  return { kind: 'RETRY_LATER', delayMs, detail };
}

function deadLetter(reason: DeadLetterReason, detail: string): Disposition {
  return { kind: 'DEAD_LETTER', reason, detail };
}
