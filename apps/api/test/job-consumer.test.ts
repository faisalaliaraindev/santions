/**
 * C6 — the consumer's decisions, without a queue or a database.
 *
 * Everything asserted here is a decision, not an effect: which FR-06 class a signal produces,
 * whether it is retried, and what the runtime is told to do with the message. Those are the
 * properties that go wrong silently — a hard block retried five times looks exactly like a
 * transient failure recovering, until someone reads the source's logs — and they do not need
 * infrastructure to be true.
 *
 * The effects (a stage committed once across two deliveries, a cancellation surviving a late
 * completion) are in `tests/integration/jobs.test.ts`, against the real replica set, because
 * those genuinely depend on a unique index and a transaction.
 */

import { describe, expect, it } from 'vitest';

import { failurePolicy, NON_RETRYABLE_CLASSES, type FailureSignal } from '@erly/adverse-domain';

import {
  classifyAttempt,
  INTERNAL_ERROR_ATTEMPTS,
  JobConsumer,
  STAGE_ATTEMPT_CEILING,
} from '../src/jobs/job-consumer.js';
import { InMemoryDeadLetterSink } from '../src/jobs/dead-letter.port.js';
import { JobFailure, type JobHandler } from '../src/jobs/job-handler.js';
import { parseIfMatch } from '../src/searches/searches.controller.js';
import {
  JOB_ENVELOPE_VERSION,
  type JobEnvelope,
  type ReceivedMessage,
} from '../src/jobs/queue.port.js';
import type { InboxReceiptService } from '../src/persistence/inbox-receipt.service.js';
import type { StageExecutionService } from '../src/persistence/stage-execution.service.js';
import type { TransactionRunner } from '../src/persistence/transaction.runner.js';
import type { OwnedAggregate } from '../src/jobs/job-ownership.js';

function envelope(overrides: Partial<JobEnvelope> = {}): JobEnvelope {
  return {
    envelopeVersion: JOB_ENVELOPE_VERSION,
    eventId: 'evt-1',
    eventType: 'search.queued',
    tenantId: 't-1',
    aggregateType: 'SearchRun',
    aggregateId: 'run-1',
    aggregateRevision: 1,
    occurredAt: '2026-09-11T00:00:00.000Z',
    correlationId: null,
    payload: {},
    ...overrides,
  };
}

function message(overrides: Partial<ReceivedMessage> = {}): ReceivedMessage {
  const env = overrides.envelope === undefined ? envelope() : overrides.envelope;
  return {
    envelope: env,
    body: env === null ? '{' : JSON.stringify(env),
    receiptHandle: 'handle-1',
    approximateReceiveCount: 1,
    ...overrides,
  };
}

const noopHandler: JobHandler = {
  eventType: 'search.queued',
  stageKeyFor: () => 'stage-1',
  execute: async () => Promise.resolve(),
};

/**
 * A consumer whose persistence is never reached.
 *
 * Every test in this file stops at a decision taken *before* the first database call, so the
 * services are stubs that throw. That is deliberate: if a change made one of these paths touch
 * the database, the test would fail loudly rather than quietly start needing infrastructure.
 */
function consumerFor(load: (id: string) => Promise<OwnedAggregate | null>): JobConsumer {
  const unreachable = new Proxy(
    {},
    {
      get: (_target, property) => () => {
        throw new Error(`Persistence must not be reached here (called ${String(property)}).`);
      },
    },
  );

  const consumer = new JobConsumer(
    unreachable as StageExecutionService,
    unreachable as InboxReceiptService,
    unreachable as TransactionRunner,
    new InMemoryDeadLetterSink(),
    load,
    {
      consumerName: 'test-worker',
      leaseMs: 60_000,
      maxExecutionMs: 900_000,
      receiptTtlMs: 3_600_000,
      maxDeliveries: 5,
    },
    () => 0.5,
  );
  consumer.register(noopHandler);
  return consumer;
}

const neverLoaded = async (): Promise<OwnedAggregate | null> => Promise.resolve(null);

describe('C6 — what the consumer decides before it touches anything', () => {
  it('dead-letters a body that is not an envelope, with a reason', async () => {
    const consumer = consumerFor(neverLoaded);

    const disposition = await consumer.handle(
      message({ envelope: null, body: 'not json at all' }),
      new Date(),
    );

    expect(disposition.kind).toBe('DEAD_LETTER');
    expect(disposition).toMatchObject({ reason: 'MALFORMED_ENVELOPE' });
  });

  it('dead-letters a message that has been delivered too many times', async () => {
    const consumer = consumerFor(neverLoaded);

    const disposition = await consumer.handle(message({ approximateReceiveCount: 5 }), new Date());

    expect(disposition).toMatchObject({ kind: 'DEAD_LETTER', reason: 'POISON_MESSAGE' });
  });

  it('dead-letters an event type nothing handles rather than retrying it forever', async () => {
    const consumer = consumerFor(neverLoaded);

    const disposition = await consumer.handle(
      message({ envelope: envelope({ eventType: 'search.unheard-of' }) }),
      new Date(),
    );

    expect(disposition).toMatchObject({ kind: 'DEAD_LETTER', reason: 'UNROUTABLE' });
  });

  it('dead-letters a forged tenant and never does the work (SEC-01)', async () => {
    // The record says tenant B. The envelope claims tenant A. A consumer that trusted the
    // envelope would do tenant A's work against tenant B's run.
    const consumer = consumerFor(async () => Promise.resolve({ tenantId: 't-other', revision: 1 }));

    const disposition = await consumer.handle(
      message({ envelope: envelope({ tenantId: 't-1' }) }),
      new Date(),
    );

    expect(disposition).toMatchObject({ kind: 'DEAD_LETTER', reason: 'TENANT_MISMATCH' });
  });

  it('discards a delivery older than the state already applied (REL-03, T31)', async () => {
    const consumer = consumerFor(async () => Promise.resolve({ tenantId: 't-1', revision: 7 }));

    const disposition = await consumer.handle(
      message({ envelope: envelope({ aggregateRevision: 3 }) }),
      new Date(),
    );

    expect(disposition).toMatchObject({ kind: 'ACKNOWLEDGE', outcome: 'STALE_REVISION' });
  });

  it('acknowledges a delivery for an aggregate that no longer exists', async () => {
    const consumer = consumerFor(neverLoaded);

    const disposition = await consumer.handle(message(), new Date());

    expect(disposition).toMatchObject({ kind: 'ACKNOWLEDGE', outcome: 'AGGREGATE_GONE' });
  });

  it('refuses two handlers for one event type', () => {
    const consumer = consumerFor(neverLoaded);
    expect(() => {
      consumer.register(noopHandler);
    }).toThrow(/already registered/);
  });
});

describe('C6 — classification decides the retry, and the FR-06 table decides the classification', () => {
  const random = (): number => 1;

  it.each(NON_RETRYABLE_CLASSES)('never retries %s, not even on the first attempt', (cls) => {
    // Build the signal that produces this class, so the test exercises classification rather
    // than asserting a policy lookup against itself.
    const signals: Record<string, FailureSignal> = {
      HARD_BLOCK: { robotsDisallow: true },
      CONTENT_ERROR: { httpStatus: 404 },
      AUTH_CREDENTIAL: { httpStatus: 401 },
      OVERSIZE: { limitExceeded: true },
    };

    const classified = classifyAttempt(
      new JobFailure(signals[cls] as FailureSignal, 'refused'),
      1,
      random,
    );

    expect(classified.failureClass).toBe(cls);
    expect(classified.retry).toBe(false);
    expect(classified.delayMs).toBe(0);
  });

  it('retries a transient network failure up to the table, then stops', () => {
    const policy = failurePolicy('TRANSIENT_NETWORK');
    const failure = new JobFailure({ syscallCode: 'ECONNRESET' }, 'reset');

    expect(classifyAttempt(failure, 1, random).retry).toBe(true);
    expect(classifyAttempt(failure, policy.maxAttempts - 1, random).retry).toBe(true);
    // maxAttempts counts attempts, not retries: at the cap, there is no further attempt.
    expect(classifyAttempt(failure, policy.maxAttempts, random).retry).toBe(false);
  });

  it('honours Retry-After exactly, without jitter', () => {
    const classified = classifyAttempt(
      new JobFailure({ httpStatus: 429, retryAfterSeconds: 30 }, 'slow down'),
      1,
      () => 0.01,
    );

    expect(classified.failureClass).toBe('RATE_LIMITED');
    // Not 1% of 30 seconds. The source told us the answer.
    expect(classified.delayMs).toBe(30_000);
  });

  it('caps a backoff at the policy ceiling however many attempts have passed', () => {
    const classified = classifyAttempt(
      new JobFailure({ httpStatus: 503 }, 'unavailable'),
      4,
      () => 0.999,
    );

    expect(classified.delayMs).toBeLessThanOrEqual(
      failurePolicy('TRANSIENT_NETWORK').backoffCapMs ?? 0,
    );
  });

  it('keeps our own defects out of the FR-06 vocabulary', () => {
    const classified = classifyAttempt(new TypeError('x is not a function'), 1, random);

    // A null class, not CONTENT_ERROR: the source did nothing, and recording this against it
    // would report a dead lead for a failure the source had no part in.
    expect(classified.failureClass).toBeNull();
    expect(classified.retry).toBe(true);
    expect(classified.detail).toContain('internal error');

    expect(classifyAttempt(new TypeError('x'), INTERNAL_ERROR_ATTEMPTS, random).retry).toBe(false);
  });

  it('bounds a stage below the highest retryable count in the table', () => {
    const retryableCaps = ['TRANSIENT_NETWORK', 'RATE_LIMITED', 'SOFT_BLOCK'].map(
      (c) => failurePolicy(c as 'TRANSIENT_NETWORK').maxAttempts,
    );
    expect(STAGE_ATTEMPT_CEILING).toBe(Math.max(...retryableCaps));
  });
});

describe('C6 — If-Match, the header the whole conflict story depends on', () => {
  it('accepts the quoted ETag it issued and the bare number', () => {
    expect(parseIfMatch('"7"')).toBe(7);
    expect(parseIfMatch('7')).toBe(7);
    expect(parseIfMatch('W/"7"')).toBe(7);
  });

  it.each(['', undefined, 'abc', '"0"', '-1', '1.5'])('rejects %o rather than coercing it', (v) => {
    // `Number('')` is 0 and `Number('abc')` is NaN. Either would fence against a revision that
    // never existed and report a conflict that misdescribes what happened.
    expect(() => parseIfMatch(v)).toThrow();
  });
});
