/**
 * The one place that opens a MongoDB transaction, and the one retry policy around it.
 *
 * Section 6.3: *handle transaction conflicts, unknown commit outcomes and duplicate-key errors
 * explicitly.* All three are handled here, visibly, rather than delegated to the driver's
 * `withTransaction` helper — which does implement the same algorithm, but hides the middle
 * case entirely, and the middle case is the one that silently duplicates work when someone
 * later "simplifies" the retry loop.
 *
 * The three cases, and why each is treated the way it is:
 *
 * **Transaction conflict** (`TransientTransactionError`, which is the label a write conflict
 * carries). Two transactions touched the same document; one lost. Nothing was committed, so
 * running the whole transaction body again is safe and is the only way to make progress.
 * Bounded attempts, bounded deadline, full jitter — see `backoffMs`.
 *
 * **Unknown commit outcome** (`UnknownTransactionCommitResult`). The commit was sent and the
 * answer never came back. **This is not a failure.** The transaction may well have committed,
 * and re-running the body would commit it a second time. So the *commit alone* is retried, not
 * the body: `commitTransaction` on an already-committed transaction is a no-op that returns
 * success. Treating this as a failure and restarting the body is precisely how duplicate work
 * gets committed, and it is the mistake this file exists to make hard.
 *
 * **Duplicate key** (code 11000). Deterministic. It will happen again on every retry, so
 * retrying turns a clear error into a slow one. It is surfaced to the caller, which is usually
 * the right answer anyway — `StageExecutionService.ensure` and `InboxReceiptService.claim` both
 * *use* a duplicate key as their success signal for "somebody already did this".
 *
 * Backoff here is deliberately **not** the FR-06 table. That table classifies failures of
 * external sources — rate limits, blocks, content errors — and a write conflict is none of
 * those. Borrowing it would put "suspend the domain and alert an operator" one refactor away
 * from a contended document.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ClientSession, MongoClient } from 'mongodb';

import { MONGO_CLIENT } from '../tokens.js';

/** What a Mongo error looks like to the classifier. Narrow on purpose, so it is testable. */
export interface ClassifiableError {
  readonly code?: number | undefined;
  hasErrorLabel?: (label: string) => boolean;
  readonly errorLabels?: readonly string[] | undefined;
}

export type TransactionDisposition =
  /** Nothing committed. Run the whole body again. */
  | 'RETRY_TRANSACTION'
  /** The body committed, or may have. Retry the commit only — never the body. */
  | 'RETRY_COMMIT'
  /** Deterministic or unrecognised. Surface it. */
  | 'FAIL';

export const TRANSIENT_LABEL = 'TransientTransactionError';
export const UNKNOWN_COMMIT_LABEL = 'UnknownTransactionCommitResult';
export const DUPLICATE_KEY_CODE = 11000;

function hasLabel(error: ClassifiableError, label: string): boolean {
  if (typeof error.hasErrorLabel === 'function') {
    return error.hasErrorLabel(label);
  }
  return error.errorLabels?.includes(label) ?? false;
}

/**
 * Classify an error thrown by the transaction body.
 *
 * Duplicate key is checked **first**. A duplicate-key error can arrive carrying a transient
 * label when it happens inside a transaction, and retrying it would loop until the deadline
 * and then report a timeout instead of the unique-index violation that actually occurred.
 */
export function classifyBodyError(error: ClassifiableError): TransactionDisposition {
  if (error.code === DUPLICATE_KEY_CODE) {
    return 'FAIL';
  }
  if (hasLabel(error, TRANSIENT_LABEL)) {
    return 'RETRY_TRANSACTION';
  }
  return 'FAIL';
}

/**
 * Classify an error thrown by `commitTransaction`.
 *
 * The unknown-commit label wins over the transient one when both are present: an outcome we
 * did not hear is not the same as an outcome we know did not happen, and the safe response to
 * "we do not know" is to ask again rather than to do it again.
 */
export function classifyCommitError(error: ClassifiableError): TransactionDisposition {
  if (hasLabel(error, UNKNOWN_COMMIT_LABEL)) {
    return 'RETRY_COMMIT';
  }
  if (error.code === DUPLICATE_KEY_CODE) {
    return 'FAIL';
  }
  if (hasLabel(error, TRANSIENT_LABEL)) {
    return 'RETRY_TRANSACTION';
  }
  return 'FAIL';
}

export interface TransactionOptions {
  /** A name for logs and metrics. Required, so an unattributable transaction cannot exist. */
  readonly name: string;
  readonly maxAttempts?: number;
  readonly deadlineMs?: number;
  /** Injected for tests. Uniform in [0, 1). */
  readonly random?: () => number;
  /** Injected for tests, so a retry policy can be asserted without waiting for it. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_MAX_ATTEMPTS = 5;
/**
 * Total wall-clock bound across all attempts.
 *
 * Shorter than the driver's own 120 s default, on purpose: this runner sits behind an HTTP
 * request, and a caller that has already given up is not helped by a commit that lands two
 * minutes later. Long-running work belongs in a stage, not in a transaction.
 */
export const DEFAULT_DEADLINE_MS = 15_000;

const BASE_BACKOFF_MS = 20;
const MAX_BACKOFF_MS = 500;

/** Bounded exponential backoff with full jitter, so contending writers do not resynchronise. */
export function backoffMs(attempt: number, random: number): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random * ceiling);
}

/** Thrown when the retries are spent. Carries the cause, so the real error is not lost. */
export class TransactionExhaustedError extends Error {
  constructor(
    readonly transactionName: string,
    readonly attempts: number,
    override readonly cause: unknown,
  ) {
    super(
      `Transaction "${transactionName}" did not commit after ${String(attempts)} attempt(s). ` +
        `Last error: ${String((cause as { message?: string }).message ?? cause)}`,
    );
    this.name = 'TransactionExhaustedError';
  }
}

@Injectable()
export class TransactionRunner {
  private readonly logger = new Logger('TransactionRunner');

  constructor(@Inject(MONGO_CLIENT) private readonly client: MongoClient) {}

  /**
   * Run `body` in a transaction and commit it.
   *
   * `body` may run more than once and must therefore be free of side effects outside the
   * session — no S3 upload, no queue publish, no index write. Those go **after** the commit,
   * in the order section 6.3 fixes: stage the upload, verify the checksum, commit the
   * reference, publish through the outbox.
   */
  async run<T>(
    body: (session: ClientSession) => Promise<T>,
    options: TransactionOptions,
  ): Promise<T> {
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    const random = options.random ?? Math.random;
    const sleep = options.sleep ?? defaultSleep;

    const startedAt = Date.now();
    const outOfTime = (): boolean => Date.now() - startedAt >= deadlineMs;

    const session = this.client.startSession();
    let lastError: unknown;

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        session.startTransaction({
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
        });

        let result: T;
        try {
          result = await body(session);
        } catch (error) {
          await this.safeAbort(session, options.name);
          lastError = error;

          if (classifyBodyError(error as ClassifiableError) !== 'RETRY_TRANSACTION') {
            throw error;
          }
          if (attempt >= maxAttempts || outOfTime()) {
            break;
          }
          this.logger.debug(
            `${options.name}: conflict on attempt ${String(attempt)}; retrying the transaction.`,
          );
          await sleep(backoffMs(attempt, random()));
          continue;
        }

        // The body succeeded. Commit it — and note that a failure from here is a different
        // question from a failure above, because the body's writes may already be durable.
        const committed = await this.commit(session, {
          name: options.name,
          deadlineMs,
          startedAt,
          random,
          sleep,
        });

        if (committed.kind === 'COMMITTED') {
          return result;
        }

        lastError = committed.error;
        if (committed.kind === 'FAILED') {
          throw committed.error;
        }
        // RETRY_TRANSACTION: nothing was committed, so the body may safely run again.
        if (attempt >= maxAttempts || outOfTime()) {
          break;
        }
        await sleep(backoffMs(attempt, random()));
      }

      throw new TransactionExhaustedError(options.name, maxAttempts, lastError);
    } finally {
      await session.endSession();
    }
  }

  /**
   * Commit, retrying **only** the commit while the outcome is unknown.
   *
   * This loop is the whole reason the runner is written out rather than delegated. An unknown
   * commit outcome is answered by asking again, never by doing the work again.
   */
  private async commit(
    session: ClientSession,
    options: {
      readonly name: string;
      readonly deadlineMs: number;
      readonly startedAt: number;
      readonly random: () => number;
      readonly sleep: (ms: number) => Promise<void>;
    },
  ): Promise<
    | { readonly kind: 'COMMITTED' }
    | { readonly kind: 'RETRY_TRANSACTION'; readonly error: unknown }
    | { readonly kind: 'FAILED'; readonly error: unknown }
  > {
    for (let commitAttempt = 1; ; commitAttempt += 1) {
      try {
        await session.commitTransaction();
        return { kind: 'COMMITTED' };
      } catch (error) {
        const disposition = classifyCommitError(error as ClassifiableError);

        if (disposition === 'RETRY_COMMIT') {
          if (Date.now() - options.startedAt >= options.deadlineMs) {
            // Out of time with the outcome still unknown. This must be reported as unknown,
            // not as a failure: a caller told "it failed" may redo work that did commit.
            return { kind: 'FAILED', error: new UnknownCommitOutcomeError(options.name, error) };
          }
          this.logger.warn(
            `${options.name}: commit outcome unknown (attempt ${String(commitAttempt)}); ` +
              'retrying the commit, not the work.',
          );
          await options.sleep(backoffMs(commitAttempt, options.random()));
          continue;
        }

        if (disposition === 'RETRY_TRANSACTION') {
          await this.safeAbort(session, options.name);
          return { kind: 'RETRY_TRANSACTION', error };
        }

        await this.safeAbort(session, options.name);
        return { kind: 'FAILED', error };
      }
    }
  }

  /**
   * Abort without letting the abort's own failure mask the error that caused it.
   *
   * An abort can fail because the connection is gone — which is usually the same reason the
   * body failed. Throwing from here would replace a diagnosable error with a confusing one.
   */
  private async safeAbort(session: ClientSession, name: string): Promise<void> {
    if (!session.inTransaction()) {
      return;
    }
    try {
      await session.abortTransaction();
    } catch (abortError) {
      this.logger.debug(`${name}: abort failed and was swallowed: ${String(abortError)}`);
    }
  }
}

/**
 * The commit was sent and its outcome was never learned within the deadline.
 *
 * Distinct from a plain failure on purpose. The work may be committed. A caller that catches
 * this must not assume either way — it should report the operation as indeterminate and let
 * the persisted identity of the record decide, exactly as a redelivered message would.
 */
export class UnknownCommitOutcomeError extends Error {
  constructor(
    readonly transactionName: string,
    override readonly cause: unknown,
  ) {
    super(
      `Transaction "${transactionName}" may or may not have committed: the commit outcome was ` +
        'never learned. Do not retry the work; check the persisted record.',
    );
    this.name = 'UnknownCommitOutcomeError';
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
