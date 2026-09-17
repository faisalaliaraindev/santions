/**
 * What a failed SEC request is allowed to cost — the retry half of the amplification question.
 *
 * Deduplicating the poll bounds the requests a **successful** search makes. This file bounds the
 * other direction: a search that goes wrong must not turn one planned request into a stream of
 * them. The rules, stated as tests rather than as prose in a brief:
 *
 * 1. A successful response is never retried. There is no path from `SUCCEEDED` back to the wire.
 * 2. A retryable failure is retried up to the FR-06 table's count for its class, and no further.
 * 3. A non-retryable failure is terminal on the first attempt — it never loops.
 * 4. When the publisher names a wait, that wait is honoured rather than jittered over.
 *
 * The SEC's own stop conditions are stricter again (**D17**): 403 halts and needs a person, 429
 * halts after its stated cooldown. Those escalate what is asserted here; they never relax it, and
 * `fetch-tripwires.test.ts` holds them.
 *
 * Nothing here opens a socket or touches a database. `classifyAttempt` is pure and exported for
 * exactly this reason.
 */

import { describe, expect, it } from 'vitest';

import { classifyFailure, failurePolicy, shouldRetry } from '@erly/adverse-domain';

import { classifyAttempt } from '../src/jobs/job-consumer.js';
import { JobFailure } from '../src/jobs/job-handler.js';

/** Deterministic, so a backoff assertion is about the policy and not about luck. */
const noJitter = (): number => 0;

/** Run a failure through the consumer's decision until it stops asking for another attempt. */
function attemptsUntilExhausted(signal: Parameters<typeof classifyFailure>[0]): number {
  let attempt = 1;
  // The ceiling is the consumer's own `STAGE_ATTEMPT_CEILING`; going past it here would mean the
  // loop, not the policy, decided when to stop.
  while (attempt < 20) {
    const classified = classifyAttempt(
      new JobFailure(signal, 'the SEC answered'),
      attempt,
      noJitter,
    );
    if (!classified.retry) {
      return attempt;
    }
    attempt += 1;
  }
  throw new Error('classifyAttempt never stopped asking for another attempt');
}

describe('a successful SEC response is never retried', () => {
  it('has no retry decision to make at all, because retry is reached only by a thrown failure', () => {
    // Stated as the shape of the code rather than as a mock: `classifyAttempt` is called from the
    // catch block, and the success path acknowledges. The assertion that matters is that nothing
    // in the FR-06 table retries an outcome that carries no failure signal.
    const policy = classifyFailure({});
    expect(policy.failureClass).toBe('CONTENT_ERROR');
    expect(policy.retryable).toBe(false);
    expect(shouldRetry(policy, 1)).toBe(false);
  });

  it('does not retry a 200', () => {
    const classified = classifyAttempt(new JobFailure({ httpStatus: 200 }, 'ok'), 1, noJitter);
    expect(classified.retry).toBe(false);
  });
});

describe('a retryable failure uses only the configured bounded count', () => {
  it('retries a rate limit exactly as many times as the FR-06 table says, then stops', () => {
    const policy = failurePolicy('RATE_LIMITED');
    expect(policy.retryable).toBe(true);

    // `maxAttempts` counts attempts, not retries. Exhaustion therefore lands on that number.
    expect(attemptsUntilExhausted({ httpStatus: 429 })).toBe(policy.maxAttempts);
    expect(policy.maxAttempts).toBeLessThanOrEqual(3);
  });

  it('retries a transient network error within its own bound', () => {
    const policy = failurePolicy('TRANSIENT_NETWORK');
    expect(policy.retryable).toBe(true);
    expect(attemptsUntilExhausted({ syscallCode: 'ECONNRESET' })).toBe(policy.maxAttempts);
    expect(policy.maxAttempts).toBeLessThanOrEqual(5);
  });

  it('honours a Retry-After the publisher stated rather than a backoff of our own', () => {
    const classified = classifyAttempt(
      new JobFailure({ httpStatus: 429, retryAfterSeconds: 30 }, 'slow down'),
      1,
      noJitter,
    );
    expect(classified.retry).toBe(true);
    expect(classified.delayMs).toBeGreaterThanOrEqual(30_000);
  });

  it('records the class on every attempt, so the retries are visible rather than inferred', () => {
    const classified = classifyAttempt(
      new JobFailure({ httpStatus: 429 }, 'slow down'),
      1,
      noJitter,
    );
    expect(classified.failureClass).toBe('RATE_LIMITED');
    expect(classified.detail).toContain('RATE_LIMITED');
  });
});

describe('a non-retryable failure does not loop', () => {
  it('abandons a 403 that has already repeated across identities on the first attempt', () => {
    // A bare 403 is FR-06's `SOFT_BLOCK`: retry **once**, from another identity. Once that other
    // identity has been refused too, there is nothing left to try and it is a hard block.
    expect(classifyFailure({ httpStatus: 403 }).failureClass).toBe('SOFT_BLOCK');
    expect(attemptsUntilExhausted({ httpStatus: 403 })).toBe(
      failurePolicy('SOFT_BLOCK').maxAttempts,
    );
    expect(failurePolicy('SOFT_BLOCK').maxAttempts).toBe(2);

    const classified = classifyAttempt(
      new JobFailure({ httpStatus: 403, repeatedAcrossIdentities: true }, 'forbidden'),
      1,
      noJitter,
    );
    expect(classified.failureClass).toBe('HARD_BLOCK');
    expect(classified.retry).toBe(false);
    expect(classified.delayMs).toBe(0);
    expect(attemptsUntilExhausted({ httpStatus: 403, repeatedAcrossIdentities: true })).toBe(1);
  });

  it('leaves the SEC’s own 403 halt to the stop conditions, which only ever tighten this', () => {
    // D17 escalates a 403 from "retry once elsewhere" to "halt and require a person". That lives
    // in `SourceHealthService`, applied per source from the approved version, and is asserted in
    // `fetch-tripwires.test.ts`. Recorded here so the two bounds are read together rather than
    // one being mistaken for the whole rule.
    expect(failurePolicy('SOFT_BLOCK').retryable).toBe(true);
    expect(failurePolicy('HARD_BLOCK').retryable).toBe(false);
  });

  it('abandons a body it could not parse on the first attempt', () => {
    // A feed whose shape changed returns the same unparsable bytes however many times it is
    // asked, so a retry is a request that cannot succeed.
    expect(attemptsUntilExhausted({ unparsableBody: true })).toBe(1);
  });

  it('abandons our own gate refusal without asking the publisher again', () => {
    const classified = classifyAttempt(
      new JobFailure({ policyRefusal: true }, 'the gate refused this URL'),
      1,
      noJitter,
    );
    expect(classified.retry).toBe(false);
  });
});

describe('the worst case is bounded', () => {
  it('gives no failure class more attempts than the stage ceiling allows', () => {
    // If a class ever carried more attempts than the stage record's ceiling, the consumer would
    // keep asking for retries the stage refuses to count — and the two bounds would disagree
    // about how many requests a publisher can receive.
    for (const failureClass of [
      'TRANSIENT_NETWORK',
      'RATE_LIMITED',
      'SOFT_BLOCK',
      'HARD_BLOCK',
      'CONTENT_ERROR',
      'AUTH_CREDENTIAL',
      'OVERSIZE',
    ] as const) {
      expect(failurePolicy(failureClass).maxAttempts).toBeLessThanOrEqual(5);
    }
  });
});
